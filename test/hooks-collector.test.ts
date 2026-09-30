import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import * as hooks from "../src/hooks/contract.js";
import {
  APPROVAL_MIN_MARGIN_MS, CODEX_ASK_UNSUPPORTED_REASON, HOOK_AGENTS, MAX_MAX_OUTPUT_BYTES, MAX_REASON_CHARS,
  WATCHDOG_WRITE_BUDGET_MS, WATCHDOG_WRITE_RETRY_SLEEP_MS, formatPreToolUseOutput, parseHookInput, toIncomingCall, toOutcome,
  validateHandlerOutput, validateHookTiming, writeAllSync,
  type CodexPostToolUseEvent, type CodexPreToolUseEvent, type PostToolUseFailureEvent, type PreToolUseEvent,
} from "../src/hooks/contract.js";
import type { AgentCredential, HookAgent, HookDecision, IncomingCall, Outcome } from "../src/types/index.js";

const load = (name: string) => readFileSync(`test/fixtures/${name}.json`, "utf8");
const json = (name: string) => JSON.parse(load(name)) as Record<string, unknown>;
const cred: AgentCredential = { kind: "local", value: "local-test-credential" };
const withField = (name: string, patch: Record<string, unknown>) => JSON.stringify({ ...json(name), ...patch });
const without = (name: string, ...keys: string[]) => { const o = json(name); for (const k of keys) delete o[k]; return JSON.stringify(o); };

describe("parseHookInput(raw, \"claude-code\")", () => {
  it("accepts all three Claude Code fixtures", () => {
    expect(parseHookInput(load("claude-code-pretooluse"), "claude-code").hook_event_name).toBe("PreToolUse");
    expect(parseHookInput(load("claude-code-posttooluse"), "claude-code").hook_event_name).toBe("PostToolUse");
    expect(parseHookInput(load("claude-code-posttoolusefailure"), "claude-code").hook_event_name).toBe("PostToolUseFailure");
  });
  it.each([
    ["invalid JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a JSON string", "\"PreToolUse\""],
    ["missing session_id", without("claude-code-pretooluse", "session_id")],
    ["missing hook_event_name", without("claude-code-pretooluse", "hook_event_name")],
    ["missing tool_use_id", without("claude-code-pretooluse", "tool_use_id")],
    ["missing tool_input", without("claude-code-pretooluse", "tool_input")],
    ["an unknown event name", withField("claude-code-pretooluse", { hook_event_name: "PermissionRequest" })],
    ["a non-object tool_input", withField("claude-code-pretooluse", { tool_input: "npm test" })],
    ["PostToolUseFailure without error", without("claude-code-posttoolusefailure", "error")],
    ["a null transcript_path", withField("claude-code-pretooluse", { transcript_path: null })],
    ["a Codex fixture (model/turn_id are Codex fields)", load("codex-pretooluse")],
    ["a malformed mcp_server object", withField("claude-code-pretooluse", { mcp_server: { name: "github" } })],
  ])("rejects %s", (_what, raw) => {
    expect(() => parseHookInput(raw, "claude-code")).toThrow();
  });
  it("tolerates fields Claude Code may add later (agent_id, a new field) but never Codex's markers", () => {
    expect(() => parseHookInput(withField("claude-code-pretooluse", { agent_id: "a1", agent_type: "worker", future_field: 1 }), "claude-code")).not.toThrow();
    expect(() => parseHookInput(withField("claude-code-pretooluse", { turn_id: "t" }), "claude-code")).toThrow(/Codex/);
  });
});

describe("parseHookInput(raw, \"codex\")", () => {
  it("accepts both Codex fixtures, and transcript_path: null", () => {
    expect(parseHookInput(load("codex-pretooluse"), "codex").hook_event_name).toBe("PreToolUse");
    expect(parseHookInput(load("codex-posttooluse"), "codex").hook_event_name).toBe("PostToolUse");
    expect(parseHookInput(withField("codex-pretooluse", { transcript_path: null }), "codex").transcript_path).toBeNull();
  });
  it.each([
    ["missing model", without("codex-pretooluse", "model")],
    ["missing turn_id", without("codex-pretooluse", "turn_id")],
    ["missing permission_mode", without("codex-pretooluse", "permission_mode")],
    ["permission_mode auto", withField("codex-pretooluse", { permission_mode: "auto" })],
    ["PostToolUseFailure (Codex has none)", withField("codex-posttooluse", { hook_event_name: "PostToolUseFailure", error: "x" })],
    ["PermissionRequest", withField("codex-pretooluse", { hook_event_name: "PermissionRequest" })],
    ["a Claude Code fixture (no model)", load("claude-code-pretooluse")],
    ["a Claude Code fixture patched with model and turn_id (prompt_id is a Claude Code field)", withField("claude-code-pretooluse", { model: "m", turn_id: "t" })],
    ["PostToolUse without tool_response", without("codex-posttooluse", "tool_response")],
  ])("rejects %s", (_what, raw) => {
    expect(() => parseHookInput(raw, "codex")).toThrow();
  });
  it("accepts any JSON tool_input at parse time (the schema says JSON value); toIncomingCall is the gate", () => {
    const ev = parseHookInput(withField("codex-pretooluse", { tool_input: "npm test" }), "codex");
    expect(ev.tool_input).toBe("npm test");
    expect(() => toIncomingCall(ev as CodexPreToolUseEvent, cred, "codex")).toThrow(/plain object/);
  });
  it("rejects an unknown agent", () => {
    expect(() => parseHookInput(load("codex-pretooluse"), "cursor" as HookAgent)).toThrow(/unknown agent/);
  });
});

const pre = (agent: HookAgent, tool_name: string, extra: Record<string, unknown> = {}) =>
  parseHookInput(withField(agent === "codex" ? "codex-pretooluse" : "claude-code-pretooluse", { tool_name, ...extra }), agent) as PreToolUseEvent | CodexPreToolUseEvent;

describe("toIncomingCall naming (both agents)", () => {
  it.each([
    ["Bash", "builtin:claude-code", "Bash"],
    ["Read", "builtin:claude-code", "Read"],
    ["mcp__github__create_issue", "github", "create_issue"],
    ["mcp__plugin_my-plugin_db__query", "plugin_my-plugin_db", "query"],
    ["mcp__srv__tool__with__more", "srv", "tool__with__more"],
  ])("claude-code: %s → %s/%s", (name, server, tool) => {
    const c = toIncomingCall(pre("claude-code", name), cred, "claude-code");
    expect([c.server, c.tool]).toEqual([server, tool]);
  });
  it.each([
    ["Bash", "builtin:codex", "Bash"],
    ["apply_patch", "builtin:codex", "apply_patch"],
    ["update_plan", "builtin:codex", "update_plan"],
    ["mcp__filesystem__read_file", "filesystem", "read_file"],
  ])("codex: %s → %s/%s", (name, server, tool) => {
    const c = toIncomingCall(pre("codex", name), cred, "codex");
    expect([c.server, c.tool]).toEqual([server, tool]);
  });
  it("a Codex event never lands on builtin:claude-code and vice versa", () => {
    expect(toIncomingCall(pre("codex", "Bash"), cred, "codex").server).toBe("builtin:codex");
    expect(toIncomingCall(pre("claude-code", "Bash"), cred, "claude-code").server).toBe("builtin:claude-code");
    expect(toIncomingCall(pre("codex", "Read"), cred, "codex").server).not.toBe("builtin:claude-code");
  });
  it.each(["mcp__claude-code__Read", "mcp__claude-code__Edit", "mcp__builtin_claude-code__Bash", "mcp__Claude_Code__Bash", "mcp__codex__Bash", "mcp__builtin_codex__Bash", "mcp__Codex__apply_patch", "mcp__BUILTIN-CODEX__x"])(
    "collision regression: %s throws under BOTH agents", (name) => {
      for (const agent of HOOK_AGENTS) expect(() => toIncomingCall(pre(agent, name), cred, agent), agent).toThrow(/impersonates/);
    });
  it.each(["mcp__claude-code-helper__x", "mcp__codex_helper__x", "mcp__github__Read"])("%s passes under both agents", (name) => {
    for (const agent of HOOK_AGENTS) expect(() => toIncomingCall(pre(agent, name), cred, agent)).not.toThrow();
  });
  it("Claude Code: mcp_server provenance on a name without the prefix throws; with the prefix it is fine", () => {
    expect(() => toIncomingCall(pre("claude-code", "Read", { mcp_server: { name: "github", source: "project" } }), cred, "claude-code")).toThrow(/provenance/);
    expect(toIncomingCall(pre("claude-code", "mcp__github__get", { mcp_server: { name: "github", source: "project" } }), cred, "claude-code").server).toBe("github");
  });
  it.each(["mcp__", "mcp__github", "mcp__github__", "mcp____tool", "mcp__a:b__tool"])("malformed MCP name %s throws", (name) => {
    expect(() => toIncomingCall(pre("claude-code", name), cred, "claude-code")).toThrow();
  });
  it.each([null, ["a"], "npm test", 42, true])("Codex tool_input %j throws (→ deny); a plain object is copied", (input) => {
    const ev = { ...(json("codex-pretooluse") as unknown as CodexPreToolUseEvent), tool_input: input };
    expect(() => toIncomingCall(ev, cred, "codex")).toThrow(/plain object/);
  });
  it("callId = tool_use_id; args is a reference-free copy; the credential is ours; nothing from the event leaks into args", () => {
    const ev = json("codex-pretooluse") as unknown as CodexPreToolUseEvent;
    const c = toIncomingCall(ev, cred, "codex");
    expect(c.callId).toBe("call_01ABC123");
    expect(c.args).toEqual({ command: "npm test" });
    expect(c.args).not.toBe(ev.tool_input);
    (ev.tool_input as Record<string, unknown>)["command"] = "changed";
    expect(c.args["command"]).toBe("npm test");
    expect(c.credential).toEqual(cred);
    expect(c.credential).not.toBe(cred);
    for (const k of ["model", "turn_id", "transcript_path", "session_id", "cwd"]) expect(k in c.args).toBe(false);
    expect(JSON.stringify(c.args)).not.toContain("gpt-5");
    expect(() => new Date(c.receivedAt).toISOString()).not.toThrow();
    expect(c.receivedAt).toBe(new Date(c.receivedAt).toISOString());
  });
  it("a tool_input with an own __proto__ key stays data and is copied", () => {
    const ev = JSON.parse(withField("claude-code-pretooluse", { tool_input: JSON.parse('{"__proto__":{"x":1},"command":"ls"}') })) as PreToolUseEvent;
    const c = toIncomingCall(ev, cred, "claude-code");
    expect(Object.hasOwn(c.args, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(c.args)).toBe(Object.prototype);
  });
  it("rejects a non-PreToolUse event or a bad credential", () => {
    expect(() => toIncomingCall(json("claude-code-posttooluse") as unknown as PreToolUseEvent, cred, "claude-code")).toThrow(/PreToolUse/);
    expect(() => toIncomingCall(pre("claude-code", "Bash"), { kind: "other", value: "x" } as unknown as AgentCredential, "claude-code")).toThrow(/credential/);
  });
});

describe("toOutcome", () => {
  const fail = json("claude-code-posttoolusefailure") as unknown as PostToolUseFailureEvent;
  it("Claude Code PostToolUse → ok; PostToolUseFailure fixture → error, Exit code 1, 4187 ms", () => {
    expect(toOutcome(parseHookInput(load("claude-code-posttooluse"), "claude-code") as never, "claude-code")).toEqual({ status: "ok" });
    expect(toOutcome(fail, "claude-code")).toEqual({ status: "error", errorClass: "Exit code 1", durationMs: 4187 });
  });
  it("is_interrupt → interrupt; no exit-code line → tool-error; the error text is never in the Outcome", () => {
    expect(toOutcome({ ...fail, is_interrupt: true }, "claude-code").errorClass).toBe("interrupt");
    const o = toOutcome({ ...fail, error: "Error: Cannot find module 'express'" }, "claude-code");
    expect(o).toEqual({ status: "error", errorClass: "tool-error", durationMs: 4187 });
    for (const ev of [fail, { ...fail, error: "Exit code 7\nsecret=hunter2" }]) expect(JSON.stringify(toOutcome(ev, "claude-code"))).not.toMatch(/express|hunter2/);
    const noDuration = { ...fail } as Partial<PostToolUseFailureEvent>; delete noDuration.duration_ms;
    expect(toOutcome(noDuration as PostToolUseFailureEvent, "claude-code")).toEqual({ status: "error", errorClass: "Exit code 1" });
  });
  it("Codex PostToolUse (tool_response starts with Exit code 1) → ok, with nothing from tool_response", () => {
    const post = parseHookInput(load("codex-posttooluse"), "codex") as CodexPostToolUseEvent;
    expect(String(post.tool_response).startsWith("Exit code 1")).toBe(true);
    const o: Outcome = toOutcome(post, "codex");
    expect(o).toEqual({ status: "ok" });
    expect(JSON.stringify(o)).not.toContain("Exit code");
  });
  it("refuses a PreToolUse event and a Codex PostToolUseFailure", () => {
    expect(() => toOutcome(json("claude-code-pretooluse") as never, "claude-code")).toThrow();
    expect(() => toOutcome({ ...fail, model: "m", turn_id: "t" } as never, "codex")).toThrow(/Codex has no/);
  });
});

describe("formatPreToolUseOutput", () => {
  const d = (decision: HookDecision["decision"], reason = "why"): HookDecision => ({ decision, reason, callId: "c1", kind: "decided" });
  it.each(["allow", "deny", "ask"] as const)("claude-code: %s is one exact line", (decision) => {
    const line = formatPreToolUseOutput(d(decision), "claude-code");
    expect(line).toBe(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"${decision}","permissionDecisionReason":"why"}}`);
    expect(line.includes("\n")).toBe(false);
    expect(line).not.toContain("defer");
  });
  it("codex: allow and deny as is; ask → deny with CODEX_ASK_UNSUPPORTED_REASON and no \"ask\" anywhere", () => {
    expect(JSON.parse(formatPreToolUseOutput(d("allow"), "codex")).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(JSON.parse(formatPreToolUseOutput(d("deny"), "codex")).hookSpecificOutput.permissionDecision).toBe("deny");
    const line = formatPreToolUseOutput(d("ask", "please ask"), "codex");
    expect(JSON.parse(line)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: CODEX_ASK_UNSUPPORTED_REASON } });
    expect(line).not.toContain("\"ask\"");
  });
  it("a multi-line reason stays one line, and a reason over MAX_REASON_CHARS is shortened so the watchdog still accepts it", () => {
    const line = formatPreToolUseOutput(d("allow", "line1\nline2"), "claude-code");
    expect(line.split("\n").length).toBe(1);
    const long = formatPreToolUseOutput(d("allow", "x".repeat(5000)), "claude-code");
    expect(validateHandlerOutput(long, "claude-code").ok).toBe(true);
    expect(JSON.parse(long).hookSpecificOutput.permissionDecisionReason.length).toBe(MAX_REASON_CHARS);
  });
  it("every line the formatter emits is accepted by the watchdog validator for that agent", () => {
    for (const agent of HOOK_AGENTS) for (const decision of ["allow", "deny", "ask"] as const) {
      const v = validateHandlerOutput(formatPreToolUseOutput(d(decision), agent), agent);
      expect(v.ok, `${agent} ${decision}`).toBe(true);
    }
  });
});

describe("validateHandlerOutput (spec §7 exact schema)", () => {
  const allow = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "r" } };
  const reason = (raw: string, agent: HookAgent = "claude-code") => { const v = validateHandlerOutput(raw, agent); return v.ok ? "ok" : v.reason; };
  it.each([
    ["", "watchdog:output:empty"], ["   \n", "watchdog:output:empty"],
    ["hello", "watchdog:output:not-json"], ["{", "watchdog:output:not-json"],
    ["[]", "watchdog:output:not-object"], ["\"allow\"", "watchdog:output:not-object"], ["null", "watchdog:output:not-object"], ["42", "watchdog:output:not-object"],
    [JSON.stringify(allow) + "\n{\"x\":1}", "watchdog:output:multiple"], [JSON.stringify(allow) + JSON.stringify(allow), "watchdog:output:multiple"],
    ["{}", "watchdog:output:missing-key:hookSpecificOutput"],
    [JSON.stringify({ ...allow, systemMessage: "hi" }), "watchdog:output:extra-key:systemMessage"],
    [JSON.stringify({ ...allow, continue: false }), "watchdog:output:extra-key:continue"],
    [JSON.stringify({ hookSpecificOutput: { ...allow.hookSpecificOutput, updatedInput: {} } }), "watchdog:output:extra-key:updatedInput"],
    [JSON.stringify({ hookSpecificOutput: { ...allow.hookSpecificOutput, additionalContext: "x" } }), "watchdog:output:extra-key:additionalContext"],
    [JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }), "watchdog:output:missing-key:permissionDecisionReason"],
    [JSON.stringify({ hookSpecificOutput: "allow" }), "watchdog:output:bad-value:hookSpecificOutput"],
    [JSON.stringify({ hookSpecificOutput: { ...allow.hookSpecificOutput, hookEventName: "PostToolUse" } }), "watchdog:output:bad-value:hookEventName"],
    [JSON.stringify({ hookSpecificOutput: { ...allow.hookSpecificOutput, permissionDecision: "defer" } }), "watchdog:output:bad-value:permissionDecision"],
    [JSON.stringify({ hookSpecificOutput: { ...allow.hookSpecificOutput, permissionDecisionReason: 1 } }), "watchdog:output:bad-value:permissionDecisionReason"],
    [JSON.stringify({ hookSpecificOutput: { ...allow.hookSpecificOutput, permissionDecisionReason: "x".repeat(MAX_REASON_CHARS + 1) } }), "watchdog:output:bad-value:permissionDecisionReason"],
    ['{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"r","__proto__":{"a":1}}}', "watchdog:output:extra-key:__proto__"],
    ['{"__proto__":{},"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"r"}}', "watchdog:output:extra-key:__proto__"],
    [JSON.stringify(allow) + "\u0000".repeat(MAX_MAX_OUTPUT_BYTES), "watchdog:output:too-large"],
  ])("%j → %s", (raw, expected) => {
    expect(reason(raw)).toBe(expected);
  });
  it("ask is valid for claude-code only", () => {
    const ask = JSON.stringify({ hookSpecificOutput: { ...allow.hookSpecificOutput, permissionDecision: "ask" } });
    expect(reason(ask, "claude-code")).toBe("ok");
    expect(reason(ask, "codex")).toBe("watchdog:output:bad-value:permissionDecision");
  });
  it("on ok the payload is rebuilt in canonical key order, whatever the handler's whitespace or order", () => {
    const messy = "\n {\"hookSpecificOutput\":{\"permissionDecisionReason\":\"r\",\"permissionDecision\":\"deny\",\n\"hookEventName\":\"PreToolUse\"}}  \n";
    const v = validateHandlerOutput(messy, "codex");
    expect(v.ok && JSON.stringify(v.payload)).toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"r"}}');
  });
  it("a key name echoed in a reason is bounded and printable", () => {
    const r = reason(JSON.stringify({ ...allow, ["\u0007" + "k".repeat(200)]: 1 }));
    expect(r.length).toBeLessThanOrEqual("watchdog:output:extra-key:".length + 64);
    expect(r).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe("validateHookTiming (ADR-006)", () => {
  it.each([
    [{ deadlineMs: 25_000, hookTimeoutS: 30 }, []],
    [{ approvalTimeoutMs: 300_000, deadlineMs: 310_000, hookTimeoutS: 320 }, []],
    [{ approvalTimeoutMs: 306_000, deadlineMs: 310_000, hookTimeoutS: 320 }, [/approval-not-below-deadline/]],
    [{ deadlineMs: 319_000, hookTimeoutS: 320 }, [/deadline-not-below-hook-timeout/]],
    [{ deadlineMs: 28_000, hookTimeoutS: 30 }, []],
    [{ deadlineMs: 28_001, hookTimeoutS: 30 }, [/deadline-not-below-hook-timeout/]],
  ])("%j → %j", (t, patterns) => {
    const v = validateHookTiming(t as hooks.HookTiming);
    expect(v.length).toBe(patterns.length);
    patterns.forEach((p, i) => expect(v[i]).toMatch(p));
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5, -1, "25000", null])("non-integer or non-positive value %s anywhere is a violation", (bad: unknown) => {
    expect(validateHookTiming({ deadlineMs: bad as number, hookTimeoutS: 30 }).length).toBeGreaterThan(0);
    expect(validateHookTiming({ deadlineMs: 25_000, hookTimeoutS: bad as number }).length).toBeGreaterThan(0);
    expect(validateHookTiming({ approvalTimeoutMs: bad as number, deadlineMs: 25_000, hookTimeoutS: 30 }).length).toBeGreaterThan(0);
  });
  it("the profiles exported by the contract are valid and the margins are exactly those the contract states", () => {
    expect(validateHookTiming(hooks.DEFAULT_HOOK_TIMING)).toEqual([]);
    expect(validateHookTiming(hooks.SLACK_HOOK_TIMING)).toEqual([]);
    expect(validateHookTiming({ approvalTimeoutMs: 310_000 - APPROVAL_MIN_MARGIN_MS, deadlineMs: 310_000, hookTimeoutS: 320 })).toEqual([]);
    expect(validateHookTiming({ approvalTimeoutMs: 310_000 - APPROVAL_MIN_MARGIN_MS + 1, deadlineMs: 310_000, hookTimeoutS: 320 }).length).toBe(1);
  });
});

describe("writeAllSync is looped and TIME-bounded (Astra P1, 2026-09-30)", () => {
  afterEach(() => vi.restoreAllMocks());
  const eagain = () => Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
  const clock = (step = 0) => { let t = 0; return () => { const v = t; t += step; return v; }; };

  it("1 byte per call still delivers the whole payload byte-for-byte, in order", () => {
    const got: number[] = [];
    vi.spyOn(fs, "writeSync").mockImplementation(((_fd: number, data: Uint8Array, off?: number) => { got.push(data[off ?? 0]!); return 1; }) as unknown as typeof fs.writeSync);
    const payload = Buffer.from('{"hookSpecificOutput":{}}\n');
    writeAllSync(1, payload, WATCHDOG_WRITE_BUDGET_MS, clock(1));
    expect(Buffer.from(got)).toEqual(payload);
  });
  it("always-EAGAIN: throws once budgetMs has elapsed on the injected clock, having slept between attempts", () => {
    const spy = vi.spyOn(fs, "writeSync").mockImplementation((() => { throw eagain(); }) as typeof fs.writeSync);
    const now = clock(100);
    const started = Date.now();
    expect(() => writeAllSync(2, Buffer.from("x"), 1000, now)).toThrow(/no progress within 1000 ms/);
    expect(spy.mock.calls.length).toBe(10); // start reads t=0; attempts at t=100..1000 (the check after the 10th sees 1000 >= budget)
    expect(Date.now() - started).toBeGreaterThanOrEqual(9 * WATCHDOG_WRITE_RETRY_SLEEP_MS - 5); // real sleeps happened between attempts
  });
  it("zero progress (0 bytes accepted, no error) for the whole budget throws too", () => {
    vi.spyOn(fs, "writeSync").mockImplementation((() => 0) as typeof fs.writeSync);
    expect(() => writeAllSync(1, Buffer.from("abc"), 50, clock(10))).toThrow(/no progress/);
  });
  it("partial progress then a stall reports the byte count; a non-EAGAIN error is rethrown at once", () => {
    let calls = 0;
    vi.spyOn(fs, "writeSync").mockImplementation((() => (++calls === 1 ? 2 : 0)) as typeof fs.writeSync);
    expect(() => writeAllSync(1, Buffer.from("abcd"), 50, clock(10))).toThrow(/incomplete after 50 ms \(2\/4 bytes\)/);
    vi.spyOn(fs, "writeSync").mockImplementation((() => { throw Object.assign(new Error("EPIPE"), { code: "EPIPE" }); }) as typeof fs.writeSync);
    expect(() => writeAllSync(1, Buffer.from("abcd"), 1000, clock(0))).toThrow(/EPIPE/);
  });
  it("uses the default budget when none is given", () => {
    vi.spyOn(fs, "writeSync").mockImplementation((() => { throw eagain(); }) as typeof fs.writeSync);
    let t = 0;
    const now = () => { t += 400; return t; };
    expect(() => writeAllSync(1, Buffer.from("x"), undefined, now)).toThrow(new RegExp(`within ${WATCHDOG_WRITE_BUDGET_MS} ms`));
  });
});

describe("round trip through a fake pipeline (per agent)", () => {
  const fake = () => {
    const decided: IncomingCall[] = [];
    const outcomes: [string, Outcome][] = [];
    return {
      decided, outcomes,
      decide: async (c: IncomingCall): Promise<HookDecision> => { decided.push(c); return { decision: c.tool === "Bash" ? "ask" : "allow", reason: "fake", callId: c.callId, kind: "decided" }; },
      recordOutcome: async (id: string, o: Outcome) => { outcomes.push([id, o]); },
    };
  };
  it("claude-code: PreToolUse → ask (Bash); PostToolUse → ok; PostToolUseFailure → error, all keyed by tool_use_id", async () => {
    const p = fake();
    const ev = parseHookInput(load("claude-code-pretooluse"), "claude-code") as PreToolUseEvent;
    const line = formatPreToolUseOutput(await p.decide(toIncomingCall(ev, cred, "claude-code")), "claude-code");
    expect(JSON.parse(line).hookSpecificOutput.permissionDecision).toBe("ask");
    expect(p.decided[0]?.callId).toBe("toolu_01ABC123...");
    await p.recordOutcome((parseHookInput(load("claude-code-posttooluse"), "claude-code")).tool_use_id, toOutcome(parseHookInput(load("claude-code-posttooluse"), "claude-code") as never, "claude-code"));
    const f = parseHookInput(load("claude-code-posttoolusefailure"), "claude-code") as PostToolUseFailureEvent;
    await p.recordOutcome(f.tool_use_id, toOutcome(f, "claude-code"));
    expect(p.outcomes).toEqual([["toolu_01ABC123...", { status: "ok" }], ["toolu_01ABC123...", { status: "error", errorClass: "Exit code 1", durationMs: 4187 }]]);
  });
  it("codex: PreToolUse Bash → the fake's ask becomes a deny on the wire; PostToolUse → ok", async () => {
    const p = fake();
    const ev = parseHookInput(load("codex-pretooluse"), "codex") as CodexPreToolUseEvent;
    const line = formatPreToolUseOutput(await p.decide(toIncomingCall(ev, cred, "codex")), "codex");
    expect(JSON.parse(line).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: CODEX_ASK_UNSUPPORTED_REASON });
    const post = parseHookInput(load("codex-posttooluse"), "codex") as CodexPostToolUseEvent;
    await p.recordOutcome(post.tool_use_id, toOutcome(post, "codex"));
    expect(p.outcomes).toEqual([["call_01ABC123", { status: "ok" }]]);
  });
});
