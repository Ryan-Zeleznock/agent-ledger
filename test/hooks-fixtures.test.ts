import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as hooks from "../src/hooks/contract.js";
import {
  BUILTIN_CODEX_SERVER, BUILTIN_SERVER, CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_S, CODEX_ASK_UNSUPPORTED_REASON, CODEX_DEFAULT_HOOK_TIMEOUT_S,
  CODEX_HOOK_EVENT_NAMES, DEFAULT_DEADLINE_MS, DEFAULT_MAX_OUTPUT_BYTES, HOOK_EVENT_NAMES, HOOK_TIMEOUT_S, MAX_MAX_OUTPUT_BYTES,
  MAX_REASON_CHARS, MCP_TOOL_PREFIX, MIN_MAX_OUTPUT_BYTES, WATCHDOG_MIN_MARGIN_MS, WATCHDOG_REASONS, WATCHDOG_REASON_PREFIX,
  type CodexPostToolUseEvent, type CodexPreToolUseEvent, type PostToolUseEvent, type PostToolUseFailureEvent, type PreToolUseEvent,
  type PreToolUseOutput, type ValidatedHandlerOutput, type WatchdogOptions, type WatchdogResult,
} from "../src/hooks/contract.js";
import type { HookDecision, Outcome } from "../src/types/index.js";

// Format-drift guard. The Claude Code fixtures are the example blocks from https://code.claude.com/docs/en/hooks (read
// 2026-09-29). The Codex fixtures are composed from the field tables at https://learn.chatgpt.com/docs/hooks and the
// generated schemas (codex-rs/hooks/schema/generated/*.command.input.schema.json, read 2026-09-29), because the Codex
// page has no PreToolUse example block; the schema's `required` list is asserted below. If either agent renames a
// field, re-fetch, update the fixture, and this test tells you what else must change. Shape only (ADR-002).
const load = (name: string) => JSON.parse(readFileSync(`test/fixtures/${name}.json`, "utf8")) as Record<string, unknown>;
const COMMON: Record<string, string> = { session_id: "string", transcript_path: "string", cwd: "string", hook_event_name: "string" };

describe("Claude Code hook fixtures", () => {
  const pre = load("claude-code-pretooluse");
  const post = load("claude-code-posttooluse");
  const fail = load("claude-code-posttoolusefailure");
  const all = { pre, post, fail };

  it.each(Object.entries(COMMON))("all three events carry common field %s as %s", (field, type) => {
    for (const [n, ev] of Object.entries(all)) expect(typeof ev[field], `${n}.${field}`).toBe(type);
  });
  it("all three carry tool_name, tool_input (object) and tool_use_id", () => {
    for (const [n, ev] of Object.entries(all)) {
      expect(typeof ev["tool_name"], n).toBe("string");
      expect(typeof ev["tool_input"], n).toBe("object");
      expect(typeof ev["tool_use_id"], n).toBe("string");
    }
  });
  it("the three event names are exactly the ones the collector accepts", () => {
    expect(HOOK_EVENT_NAMES).toEqual(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
    expect([pre, post, fail].map((e) => e["hook_event_name"])).toEqual([...HOOK_EVENT_NAMES]);
  });
  it("PreToolUse has no tool_response and no error", () => {
    expect("tool_response" in pre).toBe(false);
    expect("error" in pre).toBe(false);
    const typed: PreToolUseEvent = pre as unknown as PreToolUseEvent;
    expect(typed.tool_input["command"]).toBe("npm test");
    expect(typed.mcp_server).toBeUndefined(); // Bash is built-in; the object appears only for MCP tools (≥ 2.1.274)
  });
  it("PostToolUse adds tool_response and shares session_id, tool_input and tool_use_id with its PreToolUse", () => {
    expect("tool_response" in post).toBe(true);
    expect("error" in post).toBe(false);
    expect(post["session_id"]).toBe(pre["session_id"]);
    expect(post["tool_use_id"]).toBe(pre["tool_use_id"]);
    expect(post["tool_input"]).toEqual(pre["tool_input"]);
    const typed: PostToolUseEvent = post as unknown as PostToolUseEvent;
    expect(typeof typed.tool_response).toBe("string"); // the documented Bash example; objects are allowed too
  });
  it("PostToolUseFailure adds error (string), optional is_interrupt and duration_ms, and no tool_response", () => {
    expect("tool_response" in fail).toBe(false);
    expect(typeof fail["error"]).toBe("string");
    expect(typeof fail["is_interrupt"]).toBe("boolean");
    expect(typeof fail["duration_ms"]).toBe("number");
    expect(fail["tool_use_id"]).toBe(pre["tool_use_id"]); // same call as the PreToolUse fixture, so recordOutcome finds it
    const typed: PostToolUseFailureEvent = fail as unknown as PostToolUseFailureEvent;
    expect(typed.error.split("\n")[0]).toMatch(/^Exit code \d+$/); // Bash: first line is `Exit code N` when the command ran
    expect(typed.is_interrupt).toBe(false);
    expect(typed.duration_ms).toBe(4187);
  });
  it("the documented outcome mapping compiles: PostToolUse → ok, PostToolUseFailure → error with errorClass and durationMs", () => {
    const ok: Outcome = { status: "ok" };
    const typed = fail as unknown as PostToolUseFailureEvent;
    const err: Outcome = { status: "error", errorClass: typed.is_interrupt ? "interrupt" : typed.error.split("\n")[0], durationMs: typed.duration_ms };
    expect(ok.status).toBe("ok");
    expect(err).toEqual({ status: "error", errorClass: "Exit code 1", durationMs: 4187 });
    expect(JSON.stringify(err)).not.toContain("express"); // the error text is display text, never stored
  });
  it("uses the documented names for camelCase-free wire fields (no sessionId / toolName drift)", () => {
    for (const bad of ["sessionId", "toolName", "toolInput", "toolUseId", "hookEventName", "isInterrupt", "durationMs"]) {
      for (const [n, ev] of Object.entries(all)) expect(bad in ev, `${n}.${bad}`).toBe(false);
    }
  });
  it("pins the server-mapping constants and the MCP tool-name convention", () => {
    expect(BUILTIN_SERVER).toBe("builtin:claude-code");
    expect(MCP_TOOL_PREFIX).toBe("mcp__");
    expect("mcp__github__create_issue".startsWith(MCP_TOOL_PREFIX)).toBe(true);
    expect((pre["tool_name"] as string).startsWith(MCP_TOOL_PREFIX)).toBe(false); // Bash is built-in
  });
  it("the PreToolUse output shape is the documented hookSpecificOutput block", () => {
    const d: HookDecision = { decision: "deny", reason: "Destructive command blocked by hook", callId: "toolu_01ABC123...", kind: "decided" };
    const out: PreToolUseOutput = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.decision, permissionDecisionReason: d.reason } };
    expect(JSON.parse(JSON.stringify(out))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Destructive command blocked by hook" },
    });
    expect(Object.keys(out.hookSpecificOutput)).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  });
});

describe("Codex hook fixtures (ADR-005)", () => {
  const pre = load("codex-pretooluse");
  const post = load("codex-posttooluse");
  const both = { pre, post };
  // `required` from pre-tool-use.command.input.schema.json (read 2026-09-29); post adds tool_response
  const SCHEMA_REQUIRED = ["cwd", "hook_event_name", "model", "permission_mode", "session_id", "tool_input", "tool_name", "tool_use_id", "transcript_path", "turn_id"];

  it("carries every field the generated schema marks required, and nothing Claude Code-specific", () => {
    for (const [n, ev] of Object.entries(both)) {
      for (const f of SCHEMA_REQUIRED) expect(f in ev, `${n}.${f}`).toBe(true);
      // additionalProperties: false in the schema, and these names exist only in Claude Code's events
      for (const absent of ["prompt_id", "scratchpad_dir", "mcp_server", "is_interrupt", "duration_ms", "error"]) expect(absent in ev, `${n}.${absent}`).toBe(false);
    }
    expect("tool_response" in pre).toBe(false);
    expect("tool_response" in post).toBe(true);
  });
  it("model and turn_id are Codex-specific extensions and are strings; transcript_path may be null there", () => {
    for (const ev of Object.values(both)) {
      expect(typeof ev["model"]).toBe("string");
      expect(typeof ev["turn_id"]).toBe("string");
      expect(["string", "object"]).toContain(typeof ev["transcript_path"]); // string | null
    }
    const nullable: CodexPreToolUseEvent = { ...(pre as unknown as CodexPreToolUseEvent), transcript_path: null };
    expect(nullable.transcript_path).toBeNull();
    // @ts-expect-error Claude Code's transcript_path is never null
    const cc: PreToolUseEvent = { ...(load("claude-code-pretooluse") as unknown as PreToolUseEvent), transcript_path: null };
    expect(cc.hook_event_name).toBe("PreToolUse");
  });
  it("permission_mode is required and uses Codex's five values (no `auto`)", () => {
    const modes = ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"];
    for (const ev of Object.values(both)) expect(modes).toContain(ev["permission_mode"]);
    const typed = pre as unknown as CodexPreToolUseEvent;
    // @ts-expect-error `auto` is a Claude Code mode only
    const bad: CodexPreToolUseEvent = { ...typed, permission_mode: "auto" };
    expect(bad.permission_mode).toBe("auto");
  });
  it("Codex has only two tool events the collector consumes: there is no PostToolUseFailure", () => {
    expect(CODEX_HOOK_EVENT_NAMES).toEqual(["PreToolUse", "PostToolUse"]);
    expect(CODEX_HOOK_EVENT_NAMES).not.toContain("PostToolUseFailure");
    expect([pre, post].map((e) => e["hook_event_name"])).toEqual([...CODEX_HOOK_EVENT_NAMES]);
    // a failed Bash command still arrives as PostToolUse; the outcome is `ok` = "ran and returned" (spec §6)
    const typed = post as unknown as CodexPostToolUseEvent;
    expect(String(typed.tool_response).startsWith("Exit code 1")).toBe(true);
    const outcome: Outcome = { status: "ok" };
    expect(outcome).toEqual({ status: "ok" });
  });
  it("tool names are Codex's canonical hook names: Bash, apply_patch (never Edit/Write), mcp__<server>__<tool>", () => {
    expect(pre["tool_name"]).toBe("Bash");
    expect((pre["tool_input"] as Record<string, unknown>)["command"]).toBe("npm test"); // Bash and apply_patch use tool_input.command
    const patch: CodexPreToolUseEvent = { ...(pre as unknown as CodexPreToolUseEvent), tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** End Patch" } };
    expect(patch.tool_name).toBe("apply_patch");
    const mcp: CodexPreToolUseEvent = { ...(pre as unknown as CodexPreToolUseEvent), tool_name: "mcp__filesystem__read_file", tool_input: { path: "a" } };
    expect(mcp.tool_name.startsWith(MCP_TOOL_PREFIX)).toBe(true);
    expect(BUILTIN_CODEX_SERVER).toBe("builtin:codex");
  });
  it("tool_input is `any JSON value` in the schema, so the type is unknown and the collector must check it", () => {
    const typed = pre as unknown as CodexPreToolUseEvent;
    const input: unknown = typed.tool_input;
    // @ts-expect-error Codex tool_input is not a Record: toIncomingCall narrows it and denies anything that is not a plain object
    const direct: string = typed.tool_input["command"];
    expect(typeof input).toBe("object");
    expect(direct).toBe("npm test");
  });
  it("shares the PreToolUse output shape with Claude Code, but ask is rewritten to deny for Codex", () => {
    const ask: HookDecision = { decision: "ask", reason: "unreviewed tool", callId: "call_01ABC123", kind: "decided" };
    const codexOut: PreToolUseOutput = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: CODEX_ASK_UNSUPPORTED_REASON } };
    expect(ask.decision).toBe("ask");
    expect(codexOut.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(CODEX_ASK_UNSUPPORTED_REASON).toMatch(/Codex hooks cannot prompt/);
    expect(CODEX_ASK_UNSUPPORTED_REASON.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
  });
  it("uses the documented names for camelCase-free wire fields", () => {
    for (const bad of ["sessionId", "toolName", "toolInput", "toolUseId", "hookEventName", "turnId", "transcriptPath", "permissionMode"]) {
      for (const [n, ev] of Object.entries(both)) expect(bad in ev, `${n}.${bad}`).toBe(false);
    }
  });
});

describe("two-process watchdog contract (spec §7)", () => {
  it("replaces the in-process supervisor: runWatchdog and validateHandlerOutput exist, runHookSupervised does not", () => {
    expect(typeof hooks.runWatchdog).toBe("function");
    expect(typeof hooks.validateHandlerOutput).toBe("function");
    expect("runHookSupervised" in hooks).toBe(false);
  });
  it("the deadline sits below the hook timeout we configure by at least the margin, and that sits far below both agents' defaults", () => {
    expect(CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_S).toBe(600); // verified 2026-09-29, Claude Code hooks reference "Common fields"
    expect(CODEX_DEFAULT_HOOK_TIMEOUT_S).toBe(600);       // verified 2026-09-29, Codex hooks "Config shape" notes
    expect(HOOK_TIMEOUT_S).toBeLessThan(CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_S);
    expect(HOOK_TIMEOUT_S * 1000 - DEFAULT_DEADLINE_MS).toBeGreaterThanOrEqual(WATCHDOG_MIN_MARGIN_MS);
    expect(Number.isInteger(DEFAULT_DEADLINE_MS) && DEFAULT_DEADLINE_MS > 0).toBe(true);
  });
  it("the output cap is bounded on both sides and stays under Claude Code's 10,000-character spill limit", () => {
    expect(MIN_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(DEFAULT_MAX_OUTPUT_BYTES);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(MAX_MAX_OUTPUT_BYTES);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThan(10_000);
    // a maximal valid payload fits under the default cap with room for the reason
    const maximal: PreToolUseOutput = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "x".repeat(MAX_REASON_CHARS) } };
    expect(Buffer.byteLength(JSON.stringify(maximal))).toBeLessThan(DEFAULT_MAX_OUTPUT_BYTES);
  });
  it("options carry the handler argv, the deadline, the cap and the agent; deny reasons are namespaced", () => {
    const opts: WatchdogOptions = { handlerCommand: ["node", "/opt/agent-ledger/hook-handler.js"], deadlineMs: DEFAULT_DEADLINE_MS, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES, agent: "codex" };
    expect(opts.handlerCommand.length).toBeGreaterThan(0);
    expect(WATCHDOG_REASON_PREFIX).toBe("watchdog:");
    for (const r of ["config", "deadline", "handler-exit", "output:too-large", "output:extra-key", "handler-deny", "write", "internal"]) expect(WATCHDOG_REASONS).toContain(r);
    // Astra watchdog P1/P2 (2026-09-29): the deadline names what it ran out on, and a failed write is still exit 2
    expect(hooks.WATCHDOG_DEADLINE_DETAILS).toEqual(["stdin", "handler", "pipes-open"]);
    expect(hooks.WATCHDOG_KILL_SIGNAL).toBe("SIGKILL");
    expect(typeof hooks.writeAllSync).toBe("function");
  });
  it("the three clocks are ordered: approval < watchdog deadline < hook timeout, in both timing profiles (ADR-006)", () => {
    const ordered = (t: hooks.HookTiming) =>
      (t.approvalTimeoutMs === undefined || t.approvalTimeoutMs + hooks.APPROVAL_MIN_MARGIN_MS <= t.deadlineMs) &&
      t.deadlineMs + WATCHDOG_MIN_MARGIN_MS <= t.hookTimeoutS * 1000;
    expect(hooks.DEFAULT_HOOK_TIMING).toEqual({ deadlineMs: DEFAULT_DEADLINE_MS, hookTimeoutS: HOOK_TIMEOUT_S });
    expect(ordered(hooks.DEFAULT_HOOK_TIMING)).toBe(true);
    expect(hooks.SLACK_HOOK_TIMING.approvalTimeoutMs).toBe(300_000); // five minutes for a human
    expect(ordered(hooks.SLACK_HOOK_TIMING)).toBe(true);
    // the Slack profile needs a hook timeout above 30 s; both agents accept it (Codex: no upper clamp on PreToolUse, verified in source 2026-09-29)
    expect(hooks.SLACK_HOOK_TIMING.hookTimeoutS).toBeGreaterThan(HOOK_TIMEOUT_S);
    expect(hooks.SLACK_HOOK_TIMING.hookTimeoutS).toBeLessThan(CODEX_DEFAULT_HOOK_TIMEOUT_S);
    expect(hooks.WATCHDOG_DEADLINE_ENV).toBe("AGENT_LEDGER_WATCHDOG_DEADLINE_MS");
    expect(typeof hooks.validateHookTiming).toBe("function");
  });
  it("the failure-path result is a deny JSON AND exit 2; exit 1 is not a legal result; allow is exit 0 with a re-serialised payload", () => {
    const denied: WatchdogResult = {
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "watchdog:deadline" } }),
      stderr: "watchdog:deadline",
      exitCode: 2,
    };
    expect(denied.exitCode).toBe(2);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied.stdout.split("\n").length).toBe(1); // one JSON value: two lines would be a parse failure for Claude Code
    const allowed: WatchdogResult = { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "reviewed read" } }), stderr: "", exitCode: 0 };
    // @ts-expect-error the watchdog never exits 1: both agents treat it as "continue"
    const never: WatchdogResult = { stdout: "", stderr: "", exitCode: 1 };
    expect([allowed.exitCode, never.exitCode]).toEqual([0, 1]);
  });
  it("a validated handler payload is either an exact PreToolUseOutput or a namespaced output:* reason", () => {
    const ok: ValidatedHandlerOutput = { ok: true, payload: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "r" } } };
    const bad: ValidatedHandlerOutput = { ok: false, reason: "watchdog:output:extra-key:updatedInput" };
    // @ts-expect-error a non-output reason is not a validation result
    const wrong: ValidatedHandlerOutput = { ok: false, reason: "watchdog:deadline" };
    expect(ok.ok && Object.keys(ok.payload)).toEqual(["hookSpecificOutput"]);
    expect(!bad.ok && bad.reason.startsWith("watchdog:output:")).toBe(true);
    expect(wrong.ok).toBe(false);
  });
});
