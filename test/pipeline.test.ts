import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import canonicalize from "canonicalize";
import { ARGS_HMAC_PREFIX, CODEX_NO_CHANNEL_REASON, ORPHAN_OUTCOME_RULE_PREFIX, WATCHDOG_DEADLINE_DENY_REASON, createPipeline, projectArgs, type PipelineDeps } from "../src/pipeline/contract.js";
import { APPROVAL_MIN_MARGIN_MS, SLACK_HOOK_TIMING, WATCHDOG_DEADLINE_AT_ENV, WATCHDOG_DEADLINE_ENV } from "../src/hooks/contract.js";
import { createLedger } from "../src/ledger/contract.js";
import type { ToolRegistry } from "../src/policy/contract.js";
import type { ApprovalResult, IncomingCall, LedgerRecord, SessionHeartbeat, ToolCall, ToolResult, UnsealedRecord } from "../src/types/index.js";
import { APPROVAL_DECISIONS, CODEX_MCP_NOT_PROXIED_REASON, HANDOFF_TO_PROXY_REASON, HEARTBEAT_REASON, HEARTBEAT_RULE_ID, HEARTBEAT_TOOL, PERMISSION_DENIED_ERROR_CLASS } from "../src/types/index.js";
import * as approvalsMod from "../src/approvals/contract.js";

// The approvals module is a stub until the Slack slice; the pipeline's contract with it is what these tests pin.
vi.mock("../src/approvals/contract.js", () => ({
  requestApproval: vi.fn(async () => { throw new Error("requestApproval not stubbed for this test"); }),
  validateSlackChannel: vi.fn(async () => []),
}));
const requestApproval = vi.mocked(approvalsMod.requestApproval);
const validateSlackChannel = vi.mocked(approvalsMod.validateSlackChannel);

// ---------- fixtures ----------
const PROXY = "agentledger_proxy_7f3a9c2e1b04";
const registry: ToolRegistry = {
  version: 1,
  proxy: { codex: { serverName: PROXY } },
  servers: {
    github: { trusted: true, tools: {
      list_repos: { class: "read", reviewedBy: "ryan", reviewedAt: "2026-09-29", storeArgs: ["owner"] },
      create_issue: { class: "write", reviewedBy: "ryan", reviewedAt: "2026-09-29", storeArgs: ["owner", "repo", "title"] },
      delete_repo: { class: "risky", reviewedBy: "ryan", reviewedAt: "2026-09-29" },
      update_branch_protection: { class: "write", reviewedBy: "ryan", reviewedAt: "2026-09-29", escalateWhen: [{ argPattern: { branch: "^(main|master)$" }, to: "risky" }] },
    } },
    "builtin:claude-code": { trusted: true, tools: {
      Read: { class: "read", reviewedBy: "ryan", reviewedAt: "2026-09-29", storeArgs: ["file_path"] },
      Edit: { class: "write", reviewedBy: "ryan", reviewedAt: "2026-09-29" },
      Bash: { class: "risky", reviewedBy: "ryan", reviewedAt: "2026-09-29", storeArgs: [], note: "a shell can do anything" },
    } },
    "builtin:codex": { trusted: true, tools: {
      update_plan: { class: "read", reviewedBy: "ryan", reviewedAt: "2026-09-29" },
      apply_patch: { class: "write", reviewedBy: "ryan", reviewedAt: "2026-09-29" },
      Bash: { class: "risky", reviewedBy: "ryan", reviewedAt: "2026-09-29", storeArgs: [] },
    } },
  },
};
const KEY = randomBytes(32);
const CRED = { kind: "local" as const, value: "s3cret-credential-value" };
const identity = {
  resolveAgent: vi.fn(async (c: { kind: string; value: string }) => { if (c.value === CRED.value) return "fable"; throw new Error("Unknown agent credential"); }),
  startSession: vi.fn(async () => "sess-1"),
};
interface FakeLedger { records: UnsealedRecord[]; failNext: number; append: ReturnType<typeof vi.fn>; verify: () => Promise<{ ok: true; checked: number }>; head: () => Promise<string>; read: () => AsyncGenerator<LedgerRecord> }
function fakeLedger(): FakeLedger {
  const l: FakeLedger = {
    records: [], failNext: 0,
    append: vi.fn(async (r: UnsealedRecord) => { if (l.failNext > 0) { l.failNext--; throw new Error("ledger: lock is held"); } l.records.push(r); return { ...r, parentRecordId: null, prevHash: "0", hash: "x", writtenAt: new Date().toISOString() }; }),
    verify: async () => ({ ok: true, checked: 0 }), head: async () => "0",
    read: async function* () { for (const r of l.records) yield { ...r, parentRecordId: null, prevHash: "0", hash: "x", writtenAt: new Date().toISOString() } as LedgerRecord; },
  };
  return l;
}
const upstream = { listTools: vi.fn(async () => []), execute: vi.fn(async (_call: ToolCall): Promise<ToolResult> => ({ content: "ok", isError: false })), close: vi.fn(async () => {}) };
const slack = { kind: "slack" as const, channelId: "C0123456789", timeoutMs: 300_000, transport: "socket-mode" as const, botToken: { kind: "env" as const, name: "B" }, appToken: { kind: "env" as const, name: "A" }, approvers: ["U0123456789"] };
const call = (server: string, tool: string, args: Record<string, unknown> = {}, callId = `call-${Math.random().toString(16).slice(2)}`): IncomingCall =>
  ({ callId, credential: { ...CRED }, server, tool, args, receivedAt: "2026-09-30T12:00:00.000Z" });
const approval = (decision: ApprovalResult["decision"], extra: Partial<ApprovalResult> = {}) => (callId: string): ApprovalResult => ({ callId, decision, decidedAt: new Date().toISOString(), channel: "slack", ...extra });
const deps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({ identity, registry, ledger: fakeLedger() as never, upstream, approvals: { kind: "hook-ask" }, hookAgent: "claude-code", argsHmacKey: KEY, ...over });
const heartbeat = (over: Partial<SessionHeartbeat> = {}): SessionHeartbeat =>
  ({ agentSessionId: "abc123", hookAgent: "claude-code", source: "startup", permissionMode: "default", interpreter: "/usr/local/bin/node", nodeOptionsSet: false, watchdogCheck: "ok", ...over });

let ledger: FakeLedger;
beforeEach(() => {
  ledger = fakeLedger();
  process.env[WATCHDOG_DEADLINE_AT_ENV] = String(Date.now() + 25_000);
  process.env[WATCHDOG_DEADLINE_ENV] = "25000";
  upstream.execute.mockClear(); identity.resolveAgent.mockClear();
  requestApproval.mockReset(); validateSlackChannel.mockReset(); validateSlackChannel.mockResolvedValue([]);
});
afterEach(() => { delete process.env[WATCHDOG_DEADLINE_AT_ENV]; delete process.env[WATCHDOG_DEADLINE_ENV]; });

const intents = () => ledger.records.filter((r) => r.phase === "intent");
const outcomes = () => ledger.records.filter((r) => r.phase === "outcome");

describe("createPipeline: construction-time refusals", () => {
  it("argsHmacKey shorter than 32 bytes, or not a Uint8Array, throws (ADR-009 amendment)", () => {
    expect(() => createPipeline(deps({ argsHmacKey: randomBytes(31) }))).toThrow(/argsHmacKey/);
    expect(() => createPipeline(deps({ argsHmacKey: "x".repeat(64) as unknown as Uint8Array }))).toThrow(/argsHmacKey/);
    expect(() => createPipeline(deps({ argsHmacKey: randomBytes(32) }))).not.toThrow();
  });
  it("hook-ask in proxy mode (no hookAgent) is refused; with a hookAgent, handle is not exposed (throws when called)", async () => {
    expect(() => createPipeline(deps({ hookAgent: undefined }))).toThrow(/hook-ask/);
    const p = createPipeline(deps());
    await expect(p.handle(call("github", "list_repos"))).rejects.toThrow(/decide-only/);
    expect(upstream.execute).not.toHaveBeenCalled();
  });
  it("ADR-011: decide-only mode CONSTRUCTS without AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS (both agents, hook-ask and slack); proxy mode never needed it", () => {
    delete process.env[WATCHDOG_DEADLINE_AT_ENV];
    delete process.env[WATCHDOG_DEADLINE_ENV];
    expect(() => createPipeline(deps())).not.toThrow();
    expect(() => createPipeline(deps({ hookAgent: "codex" }))).not.toThrow();
    expect(() => createPipeline(deps({ hookAgent: "codex", approvals: slack }))).not.toThrow(); // the duration is absent too: decide() denies, construction does not throw
    expect(() => createPipeline(deps({ hookAgent: undefined, approvals: slack }))).not.toThrow();
  });
  it("ADR-011: decide() denies BEFORE identity, registry or append when the absolute deadline is missing, non-integer or already past; present → the usual answer", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    for (const bad of [undefined, "soon", "1.5", "-1", "0", "", String(Date.now() - 1)]) {
      if (bad === undefined) delete process.env[WATCHDOG_DEADLINE_AT_ENV]; else process.env[WATCHDOG_DEADLINE_AT_ENV] = bad;
      identity.resolveAgent.mockClear();
      const d = await p.decide(call("github", "list_repos", { owner: "acme" }, "d1"));
      expect(d, String(bad)).toEqual({ decision: "deny", reason: expect.stringContaining(WATCHDOG_DEADLINE_DENY_REASON), callId: "d1", kind: "decided" });
      expect(d.reason).toContain(WATCHDOG_DEADLINE_AT_ENV);
      expect(identity.resolveAgent).not.toHaveBeenCalled();
    }
    expect(ledger.records).toEqual([]);
    expect(ledger.append).not.toHaveBeenCalled();
    process.env[WATCHDOG_DEADLINE_AT_ENV] = String(Date.now() + 25_000);
    expect((await p.decide(call("github", "list_repos", { owner: "acme" }, "d2"))).decision).toBe("allow"); // the same instance, read per call
    expect(ledger.records.length).toBe(1);
    // a Codex instance behaves the same; under the real watchdog this deny line is `handler-deny`, exit 2 (test/hooks-watchdog.test.ts "real" mode runs with the env present)
    delete process.env[WATCHDOG_DEADLINE_AT_ENV];
    expect((await createPipeline(deps({ hookAgent: "codex", ledger: ledger as never })).decide(call("builtin:codex", "update_plan"))).reason).toContain(WATCHDOG_DEADLINE_DENY_REASON);
    expect(ledger.records.length).toBe(1);
  });
  it("ADR-011: recordOutcome and recordHeartbeat never consult the deadline: both work with neither watchdog variable set", async () => {
    delete process.env[WATCHDOG_DEADLINE_AT_ENV]; delete process.env[WATCHDOG_DEADLINE_ENV];
    const p = createPipeline(deps({ ledger: ledger as never }));
    await p.recordOutcome("orphan-1", { status: "ok" });
    await p.recordHeartbeat(heartbeat(), CRED);
    expect(ledger.records.map((r) => r.phase)).toEqual(["outcome", "intent"]);
    expect(ledger.records[1]!.policy.ruleId).toBe(HEARTBEAT_RULE_ID);
  });
  it("ADR-011 (Astra 1c P2 #3): construction reads NO watchdog clock, Slack included: an inherited duration that is missing, incompatible or past never blocks record-only use (both agents, both channels); decide() alone judges the clocks", async () => {
    // The watchdog's variables are inherited by anything the hook agent spawns; a record-only handler must not care what they say.
    const durations: (string | undefined)[] = [undefined, "25000", "1", "0", "soon"];
    for (const hookAgent of ["codex", "claude-code"] as const) for (const approvals of [slack, { kind: "hook-ask" as const }]) for (const duration of durations) {
      const label = `${hookAgent}/${approvals.kind}/${String(duration)}`;
      if (duration === undefined) delete process.env[WATCHDOG_DEADLINE_ENV]; else process.env[WATCHDOG_DEADLINE_ENV] = duration;
      process.env[WATCHDOG_DEADLINE_AT_ENV] = String(Date.now() - 1); // and the absolute deadline is already past
      const l = fakeLedger();
      let p!: ReturnType<typeof createPipeline>;
      expect(() => { p = createPipeline(deps({ hookAgent, approvals, ledger: l as never })); }, label).not.toThrow();
      await p.recordOutcome(`orphan-${label}`, { status: "ok" });
      await p.recordHeartbeat(heartbeat({ hookAgent }), CRED);
      expect(l.records.map((r) => r.phase), label).toEqual(["outcome", "intent"]);
      // `pre` on the same instance still fails closed: decide() denies before identity or append
      identity.resolveAgent.mockClear();
      const d = await p.decide(call(hookAgent === "codex" ? "builtin:codex" : "builtin:claude-code", "Bash", {}, `sc-${label}`));
      expect(d.decision, label).toBe("deny"); expect(d.reason, label).toContain(WATCHDOG_DEADLINE_DENY_REASON);
      expect(identity.resolveAgent, label).not.toHaveBeenCalled(); expect(l.records.length, label).toBe(2);
    }
    expect(requestApproval).not.toHaveBeenCalled();
  });
  it("Slack clocks are judged in decide() on EVERY call: a timeoutMs that does not fit under AGENT_LEDGER_WATCHDOG_DEADLINE_MS, or a missing duration, is a deny (never a wait past the deadline); a fitting one reaches the approval step", async () => {
    process.env[WATCHDOG_DEADLINE_AT_ENV] = String(Date.now() + 400_000);
    const p = createPipeline(deps({ hookAgent: "codex", approvals: slack, ledger: ledger as never }));
    delete process.env[WATCHDOG_DEADLINE_ENV];
    const missing = await p.decide(call("builtin:codex", "Bash", {}, "sc1"));
    expect(missing.decision).toBe("deny");
    expect(missing.reason).toContain(WATCHDOG_DEADLINE_ENV);
    for (const duration of ["25000", String(300_000 + APPROVAL_MIN_MARGIN_MS - 1)]) {
      process.env[WATCHDOG_DEADLINE_ENV] = duration;
      const broken = await p.decide(call("builtin:codex", "Bash", {}, `sc2-${duration}`));
      expect(broken.decision, duration).toBe("deny");
      expect(broken.reason, duration).toMatch(/approval-not-below-deadline/);
    }
    expect(ledger.records).toEqual([]);
    expect(requestApproval).not.toHaveBeenCalled();
    // the shipped consistent set (SLACK_HOOK_TIMING) fits: the call reaches requestApproval
    requestApproval.mockImplementation(async (c) => approval("timeout")(c.callId));
    process.env[WATCHDOG_DEADLINE_ENV] = String(SLACK_HOOK_TIMING.deadlineMs);
    const fitting = createPipeline(deps({ hookAgent: "codex", approvals: { ...slack, timeoutMs: SLACK_HOOK_TIMING.approvalTimeoutMs! }, ledger: ledger as never }));
    const asked = await fitting.decide(call("builtin:codex", "Bash", {}, "sc3"));
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(asked.decision).toBe("deny"); expect(asked.reason).toMatch(/approval timeout/);
    expect(ledger.records.map((r) => r.phase)).toEqual(["intent", "outcome"]);
  });
  it("a Slack channel that fails validateSlackChannel makes every decide a deny (the sync constructor cannot await it)", async () => {
    validateSlackChannel.mockResolvedValue(["approvers: must be non-empty"]);
    process.env[WATCHDOG_DEADLINE_ENV] = "310000";
    const p = createPipeline(deps({ hookAgent: "codex", approvals: slack, ledger: ledger as never }));
    const d = await p.decide(call("builtin:codex", "update_plan"));
    expect(d.decision).toBe("deny");
    expect(d.reason).toMatch(/slack channel misconfigured.*approvers/);
    expect(ledger.records).toEqual([]);
  });
});

describe("decide(): mapping, records, no upstream", () => {
  it("allow → allow (decided) with one intent record and no outcome; upstream never called", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    const d = await p.decide(call("github", "list_repos", { owner: "acme" }, "c1"));
    expect(d).toEqual({ decision: "allow", reason: expect.stringMatching(/^agent-ledger: allowed \(read; registry:github\/list_repos\)/), callId: "c1", kind: "decided" });
    expect(ledger.records.map((r) => r.phase)).toEqual(["intent"]);
    expect(intents()[0]!.policy).toEqual({ verdict: "allow", risk: "read", ruleId: "registry:github/list_repos", reason: "Reviewed read by ryan" });
    expect(upstream.execute).not.toHaveBeenCalled();
  });
  it("require_approval + hook-ask under Claude Code → ask, intent record says delegated (channel hook-ask), no outcome record", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    const d = await p.decide(call("builtin:claude-code", "Bash", { command: "ls" }, "c2"));
    expect(d.decision).toBe("ask");
    expect(d.reason).toMatch(/approval required \(risky; registry:builtin:claude-code\/Bash\): a shell can do anything/);
    expect(intents()[0]!.approval).toMatchObject({ callId: "c2", decision: "delegated", channel: "hook-ask" });
    expect(outcomes()).toEqual([]);
  });
  it("unreviewed tool (unknown server, unknown tool, github/constructor, claude-code/Read from MCP) → ask under Claude Code hook-ask, never the builtin row", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    for (const [s, t] of [["unknown", "x"], ["github", "nope"], ["github", "constructor"], ["github", "__proto__"], ["claude-code", "Read"], ["GitHub", "list_repos"]]) {
      const d = await p.decide(call(s!, t!));
      expect(d.decision, `${s}/${t}`).toBe("ask");
      expect(intents().at(-1)!.policy).toMatchObject({ risk: "unreviewed", ruleId: `unreviewed:${s}/${t}` });
    }
  });
  it("an escalation on the raw args (branch main) makes the call risky even though the stored args are hashed", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    expect((await p.decide(call("github", "update_branch_protection", { branch: "main" }))).decision).toBe("ask");
    expect(intents()[0]!.policy.ruleId).toBe("registry:github/update_branch_protection#escalate:0");
    expect(intents()[0]!.call.args["branch"]).toMatch(/^hmac-sha256:/);
    expect((await p.decide(call("github", "update_branch_protection", { branch: "feature" }))).decision).toBe("allow");
  });
  it("unknown agent → deny before any record; malformed call → deny", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    const d = await p.decide({ ...call("github", "list_repos"), credential: { kind: "local", value: "wrong" } });
    expect(d.decision).toBe("deny");
    expect(d.reason).toMatch(/unknown agent/);
    expect(ledger.records).toEqual([]);
    expect((await p.decide({ callId: "", credential: CRED, server: "github", tool: "list_repos", args: {}, receivedAt: "x" })).decision).toBe("deny");
  });
  it("ledger down: read, write, risky and unreviewed calls are ALL denied (fail closed; §7 read buffering is not implemented in this slice)", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    for (const [s, t] of [["github", "list_repos"], ["github", "create_issue"], ["builtin:claude-code", "Bash"], ["github", "unknown"]]) {
      ledger.failNext = 1;
      const d = await p.decide(call(s!, t!));
      expect(d.decision, `${s}/${t}`).toBe("deny");
      expect(d.reason).toMatch(/ledger unavailable \(ledger: lock is held\); fail closed/);
    }
    expect(ledger.records).toEqual([]);
  });
});

describe("decide(): ADR-006 Codex rules", () => {
  it("Codex + hook-ask + builtin:codex/Bash → channel resolved BEFORE append: intent carries no-channel + reason, a blocked outcome follows, answer deny; nothing says delegated", async () => {
    const p = createPipeline(deps({ hookAgent: "codex", ledger: ledger as never }));
    const d = await p.decide(call("builtin:codex", "Bash", { command: "rm -rf /" }, "cx1"));
    expect(d).toEqual({ decision: "deny", reason: expect.stringContaining(CODEX_NO_CHANNEL_REASON), callId: "cx1", kind: "decided" });
    expect(ledger.records.map((r) => [r.phase, r.approval?.decision, r.outcome?.status])).toEqual([["intent", "no-channel", undefined], ["outcome", undefined, "blocked"]]);
    expect(intents()[0]!.approval).toMatchObject({ decision: "no-channel", reason: CODEX_NO_CHANNEL_REASON, channel: "hook-ask", callId: "cx1" });
    expect(JSON.stringify(ledger.records)).not.toContain("delegated");
    expect((await p.decide(call("builtin:codex", "update_plan"))).decision).toBe("allow");
    expect((await p.decide(call("builtin:codex", "apply_patch", { command: "*** Begin Patch" }))).decision).toBe("allow");
  });
  it("proxy server → ONE handoff-to-proxy intent record (handoff, ruleId, reason, risk unreviewed, no approval), THEN governed-by-proxy allow", async () => {
    const p = createPipeline(deps({ hookAgent: "codex", ledger: ledger as never }));
    const d = await p.decide(call(PROXY, "list_repos", { owner: "acme" }, "cx2"));
    expect(d).toEqual({ decision: "allow", reason: HANDOFF_TO_PROXY_REASON, callId: "cx2", kind: "governed-by-proxy" });
    expect(ledger.records.length).toBe(1);
    const r = ledger.records[0]!;
    expect(r.phase).toBe("intent");
    expect(r.handoff).toEqual({ kind: "to-proxy", proxyServerName: PROXY });
    expect(r.policy).toEqual({ verdict: "allow", risk: "unreviewed", ruleId: `handoff-to-proxy:${PROXY}`, reason: HANDOFF_TO_PROXY_REASON });
    expect(r.approval).toBeUndefined();
    expect(r.call.args["owner"]).toMatch(/^hmac-sha256:/); // no registry row for the proxy: no clear args
    // a failed append is a deny, and no other record type carries `handoff`
    ledger.failNext = 1;
    expect((await p.decide(call(PROXY, "list_repos"))).decision).toBe("deny");
    await p.decide(call("builtin:codex", "update_plan"));
    await p.decide(call("github", "list_repos"));
    expect(ledger.records.filter((x) => x.handoff !== undefined).length).toBe(1);
  });
  it("any other Codex mcp__ server (even a reviewed read row!) → recorded deny codex-mcp-not-proxied + blocked outcome", async () => {
    const p = createPipeline(deps({ hookAgent: "codex", ledger: ledger as never }));
    const d = await p.decide(call("github", "list_repos", { owner: "acme" }, "cx3"));
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain(CODEX_MCP_NOT_PROXIED_REASON);
    expect(intents()[0]!.policy).toEqual({ verdict: "deny", risk: "unreviewed", ruleId: "codex-mcp-not-proxied:github/list_repos", reason: CODEX_MCP_NOT_PROXIED_REASON });
    expect(outcomes()[0]!.outcome).toEqual({ status: "blocked" });
    expect(outcomes()[0]!.call.callId).toBe("cx3");
  });
  it("Astra P1 #2: a Codex mcp__ hook name never borrows a registry row's clear fields: not-proxied denials and handoffs store hashes only", async () => {
    const p = createPipeline(deps({ hookAgent: "codex", ledger: ledger as never }));
    // github_/list_repos and github/_list_repos both arrive as mcp__github__list_repos → server github (a reviewed row with storeArgs [owner])
    await p.decide(call("github", "list_repos", { owner: "synthetic-private-value-48293" }, "cx4"));
    await p.decide(call(PROXY, "list_repos", { owner: "synthetic-private-value-48293" }, "cx5"));
    for (const r of ledger.records) {
      expect(r.call.args["owner"], `${r.phase} ${r.call.callId}`).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(ledger.records)).not.toContain("synthetic-private-value");
    // built-in rows keep their allowlists under Codex; Claude Code MCP rows keep theirs
    await p.decide(call("builtin:codex", "update_plan", { plan: "x" }));
    expect(intents().at(-1)!.call.args["plan"]).toMatch(/^hmac-sha256:/);
    const cc = createPipeline(deps({ hookAgent: "claude-code", ledger: ledger as never }));
    await cc.decide(call("github", "list_repos", { owner: "acme" }));
    expect(intents().at(-1)!.call.args["owner"]).toBe("acme");
  });
  it("with no proxy.codex configured every Codex MCP call is that deny; the same github/list_repos under Claude Code is an allow via the registry", async () => {
    const noProxy: ToolRegistry = { version: 1, servers: registry.servers };
    const cx = createPipeline(deps({ hookAgent: "codex", registry: noProxy, ledger: ledger as never }));
    expect((await cx.decide(call(PROXY, "list_repos"))).decision).toBe("deny");
    expect((await cx.decide(call("github", "list_repos"))).decision).toBe("deny");
    const cc = createPipeline(deps({ hookAgent: "claude-code", ledger: ledger as never }));
    expect((await cc.decide(call("github", "list_repos"))).decision).toBe("allow");
  });
});

describe("decide(): Slack approvals (module mocked; the pipeline's contract with it)", () => {
  const codexSlack = () => { process.env[WATCHDOG_DEADLINE_ENV] = "310000"; return createPipeline(deps({ hookAgent: "codex", approvals: slack, ledger: ledger as never })); };
  it("approved risky → the intent record (approved, approver, reason, callId) is persisted FIRST, then allow", async () => {
    const order: string[] = [];
    requestApproval.mockImplementation(async (c) => { order.push("slack"); return approval("approved", { approver: "U0123456789", reason: "clicked approve" })(c.callId); });
    ledger.append.mockImplementation(async (r: UnsealedRecord) => { order.push(`append:${r.phase}`); ledger.records.push(r); return r as never; });
    const p = codexSlack();
    const d = await p.decide(call("builtin:codex", "Bash", { command: "deploy" }, "s1"));
    expect(d.decision).toBe("allow");
    expect(d.reason).toMatch(/approved by U0123456789/);
    expect(order).toEqual(["slack", "append:intent"]);
    expect(intents()[0]!.approval).toMatchObject({ callId: "s1", decision: "approved", approver: "U0123456789", reason: "clicked approve", channel: "slack" });
    expect(requestApproval.mock.calls[0]![0]).not.toHaveProperty("credential");
    expect(requestApproval.mock.calls[0]![2]).toBe(slack);
  });
  it("append rejects AFTER the approval → deny, no allow is ever emitted (Astra spec v2 #4)", async () => {
    requestApproval.mockImplementation(async (c) => approval("approved", { approver: "U0123456789" })(c.callId));
    const p = codexSlack();
    ledger.failNext = 1;
    const d = await p.decide(call("builtin:codex", "Bash", {}, "s2"));
    expect(d.decision).toBe("deny");
    expect(d.reason).toMatch(/ledger unavailable/);
    expect(ledger.records).toEqual([]);
  });
  it("unavailable (the channel rejects with a network error) → deny, intent unavailable, outcome blocked", async () => {
    requestApproval.mockRejectedValue(new Error("ECONNRESET"));
    const p = codexSlack();
    const d = await p.decide(call("builtin:codex", "Bash", {}, "s3"));
    expect(d.decision).toBe("deny");
    expect(intents()[0]!.approval).toMatchObject({ decision: "unavailable", reason: expect.stringContaining("ECONNRESET"), channel: "slack" });
    expect(outcomes()[0]!.outcome).toEqual({ status: "blocked" });
  });
  it("denied by U… → denied with approver and reason; timeout → timeout; every Codex approval.decision is in the final set (never delegated)", async () => {
    requestApproval.mockImplementationOnce(async (c) => approval("denied", { approver: "U0123456789", reason: "no" })(c.callId));
    requestApproval.mockImplementationOnce(async (c) => approval("timeout", { reason: "no approver answered within 300000 ms" })(c.callId));
    const p = codexSlack();
    expect((await p.decide(call("builtin:codex", "Bash", {}, "s4"))).decision).toBe("deny");
    expect((await p.decide(call("builtin:codex", "Bash", {}, "s5"))).decision).toBe("deny");
    expect(intents().map((r) => r.approval)).toEqual([
      expect.objectContaining({ decision: "denied", approver: "U0123456789", reason: "no" }),
      expect.objectContaining({ decision: "timeout" }),
    ]);
    for (const r of intents()) expect(APPROVAL_DECISIONS.filter((x) => x !== "delegated")).toContain(r.approval!.decision);
    expect(outcomes().length).toBe(2);
  });
  it("an approval result bound to another callId is treated as unavailable (never an allow)", async () => {
    requestApproval.mockImplementation(async () => approval("approved", { approver: "U0123456789" })("someone-else"));
    const d = await codexSlack().decide(call("builtin:codex", "Bash", {}, "s6"));
    expect(d.decision).toBe("deny");
    expect(intents()[0]!.approval!.decision).toBe("unavailable");
  });
  it("decide() passes deadlineAt from AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS into requestApproval; proxy mode passes none", async () => {
    requestApproval.mockImplementation(async (c) => approval("timeout")(c.callId));
    process.env[WATCHDOG_DEADLINE_AT_ENV] = "4102444800000";
    await codexSlack().decide(call("builtin:codex", "Bash"));
    expect(requestApproval.mock.calls[0]![3]).toBe(4_102_444_800_000);
    const proxy = createPipeline(deps({ hookAgent: undefined, approvals: slack, ledger: ledger as never }));
    await proxy.handle(call("github", "delete_repo")); // proxy mode decides through handle(); public decide() is not exposed there (Astra 1c P2 #5)
    expect(requestApproval.mock.calls[1]![3]).toBeUndefined();
  });
});

describe("recordOutcome()", () => {
  it("chains the outcome to the intent with that callId (same call and policy); error keeps errorClass and durationMs", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    await p.decide(call("github", "list_repos", { owner: "acme", page: 2 }, "o1"));
    await p.recordOutcome("o1", { status: "error", errorClass: "Exit code 1", durationMs: 4187 });
    expect(outcomes().length).toBe(1);
    expect(outcomes()[0]!.call).toEqual(intents()[0]!.call);
    expect(outcomes()[0]!.policy).toEqual(intents()[0]!.policy);
    expect(outcomes()[0]!.outcome).toEqual({ status: "error", errorClass: "Exit code 1", durationMs: 4187 });
    await p.recordOutcome("o1", { status: "ok", errorClass: undefined, durationMs: Number.NaN } as never);
    expect(outcomes()[1]!.outcome).toEqual({ status: "ok" });
  });
  it("a fresh process (no cache) finds the intent through the ledger; an unknown callId is an orphan outcome, kept, never dropped", async () => {
    const p1 = createPipeline(deps({ ledger: ledger as never }));
    await p1.decide(call("builtin:claude-code", "Read", { file_path: "/a" }, "o2"));
    const p2 = createPipeline(deps({ ledger: ledger as never }));
    await p2.recordOutcome("o2", { status: "ok" });
    expect(outcomes()[0]!.call.callId).toBe("o2");
    expect(outcomes()[0]!.call.args).toEqual({ file_path: "/a" });
    await p2.recordOutcome("never-seen", { status: "ok" });
    const orphan = outcomes()[1]!;
    expect(orphan.call.callId).toBe("never-seen");
    expect(orphan.policy.ruleId).toBe(`${ORPHAN_OUTCOME_RULE_PREFIX}never-seen`);
    expect(orphan.policy.risk).toBe("unreviewed");
  });
  it("a governed-by-proxy callId chains the hook's outcome to the handoff record, not to an orphan", async () => {
    const p = createPipeline(deps({ hookAgent: "codex", ledger: ledger as never }));
    await p.decide(call(PROXY, "list_repos", {}, "o3"));
    await createPipeline(deps({ hookAgent: "codex", ledger: ledger as never })).recordOutcome("o3", { status: "ok" });
    expect(outcomes()[0]!.policy.ruleId).toBe(`handoff-to-proxy:${PROXY}`);
    expect(outcomes()[0]!.handoff).toBeUndefined();
  });
  it("Astra P2 #5: full interleaving on ONE real ledger: hook handoff, proxy intent+outcome, then a fresh Codex post handler → the hook outcome chains to the HANDOFF; the proxy's stays its own; an orphan stays an orphan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-ledger-pipeline-"));
    try {
      const real = createLedger("jsonl", join(dir, "ledger.jsonl"));
      await createPipeline(deps({ hookAgent: "codex", ledger: real })).decide(call(PROXY, "list_repos", { owner: "acme" }, "C"));
      // the proxy's own intent + ok outcome for the same callId come from handle() (its public decide() is not exposed; Astra 1c P2 #5)
      await createPipeline(deps({ hookAgent: undefined, approvals: slack, ledger: real })).handle(call("github", "list_repos", { owner: "acme", page: 1 }, "C"));
      await createPipeline(deps({ hookAgent: "codex", ledger: real })).recordOutcome("C", { status: "ok" });
      await createPipeline(deps({ hookAgent: "codex", ledger: real })).recordOutcome("nobody", { status: "ok" });
      const recs: LedgerRecord[] = [];
      for await (const r of real.read({ from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" })) recs.push(r);
      expect(recs.map((r) => [r.phase, r.policy.ruleId, r.call.server])).toEqual([
        ["intent", `handoff-to-proxy:${PROXY}`, PROXY],
        ["intent", "registry:github/list_repos", "github"],
        ["outcome", "registry:github/list_repos", "github"],
        ["outcome", `handoff-to-proxy:${PROXY}`, PROXY],
        ["outcome", `${ORPHAN_OUTCOME_RULE_PREFIX}nobody`, "unknown"],
      ]);
      expect(recs[3]!.handoff).toBeUndefined();
      expect(recs[3]!.call.args).toEqual(recs[0]!.call.args);
      expect(await real.verify()).toEqual({ ok: true, checked: 5 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses a missing callId or an invalid status", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    await expect(p.recordOutcome("", { status: "ok" })).rejects.toThrow(/callId/);
    await expect(p.recordOutcome("x", { status: "weird" } as never)).rejects.toThrow(/invalid outcome/);
  });
  it("ADR-010 pin 7: a Claude Code auto-mode denial (blocked, permission-denied:auto-mode) chains to its intent, like any outcome; unknown callId → orphan", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    await p.decide({ ...call("builtin:claude-code", "Bash", { command: "rm -rf /tmp/data" }, "pd1"), agentSessionId: "sess-auto" });
    await createPipeline(deps({ ledger: ledger as never })).recordOutcome("pd1", { status: "blocked", errorClass: PERMISSION_DENIED_ERROR_CLASS });
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]!.outcome).toEqual({ status: "blocked", errorClass: "permission-denied:auto-mode" });
    expect(outcomes()[0]!.call).toEqual(intents()[0]!.call);
    expect(outcomes()[0]!.call.agentSessionId).toBe("sess-auto");
    expect(outcomes()[0]!.policy.ruleId).toBe("registry:builtin:claude-code/Bash");
    await p.recordOutcome("pd-unknown", { status: "blocked", errorClass: PERMISSION_DENIED_ERROR_CLASS });
    expect(outcomes()[1]!.policy.ruleId).toBe(`${ORPHAN_OUTCOME_RULE_PREFIX}pd-unknown`);
  });
});

describe("ADR-010: agentSessionId projection and recordHeartbeat (Slice 1c pins 3, 4, 7)", () => {
  it("decide(): the ToolCall projection carries agentSessionId when the IncomingCall has one, and omits the key otherwise; the credential never survives", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    await p.decide({ ...call("github", "list_repos", { owner: "acme" }, "p1"), agentSessionId: "abc123", onBehalfOf: "ryan" });
    await p.decide(call("github", "list_repos", { owner: "acme" }, "p2"));
    expect(Object.keys(intents()[0]!.call).sort()).toEqual(["agentId", "agentSessionId", "args", "callId", "onBehalfOf", "receivedAt", "server", "sessionId", "tool"]);
    expect(intents()[0]!.call.agentSessionId).toBe("abc123");
    expect("agentSessionId" in intents()[1]!.call).toBe(false);
    expect(JSON.stringify(ledger.records)).not.toContain(CRED.value);
    // an empty string is not a session id: the key is omitted rather than stored blank
    await p.decide({ ...call("github", "list_repos", {}, "p3"), agentSessionId: "" });
    expect("agentSessionId" in intents()[2]!.call).toBe(false);
  });
  it("recordHeartbeat writes exactly the pin 7 record: intent, heartbeat:<uuid>, builtin server, SessionStart, agentSessionId, args in the clear, allow/read/heartbeat:session-start; never an outcome", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    await p.recordHeartbeat(heartbeat(), CRED);
    expect(ledger.records).toHaveLength(1);
    const r = ledger.records[0]!;
    expect(r.phase).toBe("intent");
    expect(r.outcome).toBeUndefined(); expect(r.approval).toBeUndefined(); expect(r.handoff).toBeUndefined();
    expect(r.call.callId).toMatch(/^heartbeat:[0-9a-f-]{36}$/);
    expect(r.call).toMatchObject({ sessionId: "sess-1", agentId: "fable", agentSessionId: "abc123", server: "builtin:claude-code", tool: HEARTBEAT_TOOL });
    expect(Object.keys(r.call).sort()).toEqual(["agentId", "agentSessionId", "args", "callId", "receivedAt", "server", "sessionId", "tool"]);
    expect(r.call.args).toEqual({ agentSessionId: "abc123", hookAgent: "claude-code", source: "startup", permissionMode: "default", interpreter: "/usr/local/bin/node", nodeOptionsSet: false, watchdogCheck: "ok" });
    expect(r.policy).toEqual({ verdict: "allow", risk: "read", ruleId: HEARTBEAT_RULE_ID, reason: HEARTBEAT_REASON });
    expect(r.policy.ruleId).toBe("heartbeat:session-start");
    expect(new Date(r.call.receivedAt).toISOString()).toBe(r.call.receivedAt);
    expect(identity.resolveAgent).toHaveBeenCalledWith(CRED);
    // the args object is a copy: mutating the input afterwards changes nothing; permissionMode is omitted when absent
    const hb = heartbeat({ hookAgent: "codex", agentSessionId: "thr_123", source: "compact", watchdogCheck: "missing", nodeOptionsSet: true });
    delete hb.permissionMode;
    await createPipeline(deps({ hookAgent: "codex", ledger: ledger as never })).recordHeartbeat(hb, CRED);
    hb.source = "mutated";
    expect(ledger.records[1]!.call.server).toBe("builtin:codex");
    expect(ledger.records[1]!.call.args).toEqual({ agentSessionId: "thr_123", hookAgent: "codex", source: "compact", interpreter: "/usr/local/bin/node", nodeOptionsSet: true, watchdogCheck: "missing" });
    expect("permissionMode" in ledger.records[1]!.call.args).toBe(false);
  });
  it("ADR-010 amendment (proposed 2026-10-03; Astra 1c P2 #4): the public signature is recordHeartbeat(hb, credential): a one-argument call is a compile error, and at runtime it attributes nothing (no record)", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    // @ts-expect-error the credential is a required second parameter (it is never carried inside the stored SessionHeartbeat)
    await expect(p.recordHeartbeat(heartbeat())).rejects.toThrow(); // identity gets `undefined` and rejects it: nothing to attribute
    expect(ledger.records).toEqual([]);
    expect(Object.keys(heartbeat())).not.toContain("credential");
    expect(p.recordHeartbeat.length).toBe(2);
  });
  it("recordHeartbeat throws (no record) on: unknown agent, proxy mode, a hookAgent that differs from the pipeline's, a malformed heartbeat, and a failed append", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    await expect(p.recordHeartbeat(heartbeat(), { kind: "local", value: "wrong" })).rejects.toThrow(/Unknown agent/);
    await expect(createPipeline(deps({ hookAgent: undefined, approvals: slack, ledger: ledger as never })).recordHeartbeat(heartbeat(), CRED)).rejects.toThrow(/proxy mode/);
    await expect(p.recordHeartbeat(heartbeat({ hookAgent: "codex" }), CRED)).rejects.toThrow(/configured for claude-code/);
    for (const bad of [
      heartbeat({ agentSessionId: "" }), heartbeat({ source: "" }), heartbeat({ interpreter: "" }), heartbeat({ permissionMode: "" }),
      heartbeat({ watchdogCheck: "fine" as never }), heartbeat({ nodeOptionsSet: "no" as never }), heartbeat({ hookAgent: "cursor" as never }), null as never, "hb" as never,
    ]) await expect(p.recordHeartbeat(bad, CRED), JSON.stringify(bad)).rejects.toThrow(/recordHeartbeat/);
    expect(ledger.records).toEqual([]);
    ledger.failNext = 1;
    await expect(p.recordHeartbeat(heartbeat(), CRED)).rejects.toThrow(/lock is held/);
    expect(ledger.records).toEqual([]);
    // extra fields on the heartbeat object are dropped, never stored (NODE_OPTIONS value smuggled on the object, say)
    await p.recordHeartbeat({ ...heartbeat(), nodeOptions: "--import=evil" } as never, CRED);
    expect("nodeOptions" in ledger.records[0]!.call.args).toBe(false);
    expect(JSON.stringify(ledger.records)).not.toContain("--import");
  });
  it("pin 4 round trip through the REAL jsonl ledger: heartbeat and a tool intent with agentSessionId append, read back with the field present, verify() ok, and the interpreter path survives redaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-ledger-pipeline-"));
    try {
      const real = createLedger("jsonl", join(dir, "ledger.jsonl"));
      const p = createPipeline(deps({ ledger: real }));
      await p.recordHeartbeat(heartbeat({ interpreter: "/Users/someone/.nvm/versions/node/v25.8.2/bin/node", permissionMode: "bypassPermissions" }), CRED);
      await p.decide({ ...call("builtin:claude-code", "Read", { file_path: "/a" }, "rt1"), agentSessionId: "abc123" });
      await p.decide({ ...call("builtin:claude-code", "Read", { file_path: "/b" }, "rt2"), agentSessionId: "other-session" });
      await createPipeline(deps({ ledger: real })).recordOutcome("rt1", { status: "ok" });
      const recs: LedgerRecord[] = [];
      for await (const r of real.read({ from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" })) recs.push(r);
      expect(recs.map((r) => [r.phase, r.policy.ruleId, r.call.agentSessionId])).toEqual([
        ["intent", HEARTBEAT_RULE_ID, "abc123"],
        ["intent", "registry:builtin:claude-code/Read", "abc123"],
        ["intent", "registry:builtin:claude-code/Read", "other-session"],
        ["outcome", "registry:builtin:claude-code/Read", "abc123"],
      ]);
      expect(recs[0]!.call.tool).toBe("SessionStart");
      expect(recs[0]!.call.args).toEqual({ agentSessionId: "abc123", hookAgent: "claude-code", source: "startup", permissionMode: "bypassPermissions", interpreter: "/Users/someone/.nvm/versions/node/v25.8.2/bin/node", nodeOptionsSet: false, watchdogCheck: "ok" });
      expect(recs[3]!.call).toEqual(recs[1]!.call);
      expect(await real.verify()).toEqual({ ok: true, checked: 4 });
      const text = readFileSync(join(dir, "ledger.jsonl"), "utf8");
      expect(text).toContain('"agentSessionId":"abc123"');
      expect(text).not.toContain(CRED.value);
      // a heartbeat session that only ever heartbeated and a session with tool records but no heartbeat are both visible to a reader (B's report check)
      const heartbeats = new Set(recs.filter((r) => r.policy.ruleId === HEARTBEAT_RULE_ID).map((r) => r.call.agentSessionId));
      const toolSessions = new Set(recs.filter((r) => r.phase === "intent" && r.policy.ruleId !== HEARTBEAT_RULE_ID).map((r) => r.call.agentSessionId));
      expect([...toolSessions].filter((s) => !heartbeats.has(s))).toEqual(["other-session"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("handle(): proxy mode", () => {
  const proxy = () => createPipeline(deps({ hookAgent: undefined, approvals: slack, ledger: ledger as never }));
  it("Astra 1c P2 #5 (pre-existing): public decide() is NOT exposed in proxy mode: it throws before identity, approval or append, even with the absolute deadline absent or past and a validator that answers clean; handle() needs no watchdog clock", async () => {
    for (const at of [undefined, String(Date.now() - 1)]) {
      if (at === undefined) delete process.env[WATCHDOG_DEADLINE_AT_ENV]; else process.env[WATCHDOG_DEADLINE_AT_ENV] = at;
      delete process.env[WATCHDOG_DEADLINE_ENV];
      identity.resolveAgent.mockClear();
      await expect(proxy().decide(call("github", "list_repos", { owner: "acme" }, `pd-${String(at)}`)), String(at)).rejects.toThrow(/proxy mode/);
      expect(identity.resolveAgent).not.toHaveBeenCalled(); expect(requestApproval).not.toHaveBeenCalled(); expect(ledger.records).toEqual([]);
    }
    // control: the same construction serves MCP calls through handle() with neither watchdog variable set (there is no watchdog in front of the proxy)
    const res = await proxy().handle(call("github", "list_repos", { owner: "acme" }, "ph1"));
    expect(res).toEqual({ content: "ok", isError: false });
    expect(upstream.execute).toHaveBeenCalledOnce();
    expect(ledger.records.map((r) => r.phase)).toEqual(["intent", "outcome"]);
  });
  it("allowed call: intent record BEFORE upstream, then an ok outcome with durationMs; the ToolCall carries no credential", async () => {
    const order: string[] = [];
    ledger.append.mockImplementation(async (r: UnsealedRecord) => { order.push(`append:${r.phase}`); ledger.records.push(r); return r as never; });
    upstream.execute.mockImplementation(async () => { order.push("execute"); return { content: "listed", isError: false }; });
    const res = await proxy().handle(call("github", "list_repos", { owner: "acme" }, "h1"));
    expect(res).toEqual({ content: "listed", isError: false });
    expect(order).toEqual(["append:intent", "execute", "append:outcome"]);
    const executed = upstream.execute.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(Object.keys(executed).sort()).toEqual(["agentId", "args", "callId", "receivedAt", "server", "sessionId", "tool"]);
    expect("credential" in executed).toBe(false);
    expect(outcomes()[0]!.outcome).toMatchObject({ status: "ok" });
    expect(typeof outcomes()[0]!.outcome!.durationMs).toBe("number");
  });
  it("Astra P1 #1: upstream executes the RAW args (scalars, objects, bodies) while the ledger stores the projection; read and approved-write", async () => {
    requestApproval.mockImplementation(async (c) => approval("approved", { approver: "U0123456789" })(c.callId));
    const p = proxy();
    const readArgs = { owner: "acme", page: 2, filter: { a: [1, 2], b: "x" }, body: "line1\nline2" };
    await p.handle(call("github", "list_repos", readArgs, "h3"));
    expect(upstream.execute.mock.calls[0]![0].args).toEqual(readArgs);
    expect(upstream.execute.mock.calls[0]![0].args).not.toBe(readArgs);
    expect(intents()[0]!.call.args).toEqual({ owner: "acme", page: expect.stringMatching(/^hmac-sha256:/), filter: expect.stringMatching(/^hmac-sha256:/), body: expect.stringMatching(/^hmac-sha256:/) });
    expect(outcomes()[0]!.call.args).toEqual(intents()[0]!.call.args);
    const writeArgs = { repo: "r", confirm: true, reason: "cleanup" };
    await p.handle(call("github", "delete_repo", writeArgs, "h4"));
    expect(upstream.execute.mock.calls[1]![0].args).toEqual(writeArgs);
    expect(Object.values(intents()[1]!.call.args).every((v) => String(v).startsWith("hmac-sha256:"))).toBe(true);
    expect(requestApproval.mock.calls[0]![0].args).toEqual(intents()[1]!.call.args); // Slack previews see the storage projection, never raw values
    expect(JSON.stringify(ledger.records)).not.toContain("cleanup");
  });
  it("Astra P1 #1: no execution while the intent append fails, and the executed call carries no credential and no hash", async () => {
    ledger.failNext = 1;
    const res = await proxy().handle(call("github", "list_repos", { owner: "acme", page: 2 }));
    expect(res.isError).toBe(true);
    expect(upstream.execute).not.toHaveBeenCalled();
  });
  it("denied (Slack denied) → one blocked outcome record, isError result, upstream never called", async () => {
    requestApproval.mockImplementation(async (c) => approval("denied", { approver: "U0123456789" })(c.callId));
    const res = await proxy().handle(call("github", "delete_repo", {}, "h2"));
    expect(res.isError).toBe(true);
    expect(outcomes().map((r) => r.outcome)).toEqual([{ status: "blocked" }]);
    expect(upstream.execute).not.toHaveBeenCalled();
  });
  it("ledger down → blocked for risky, unreviewed AND read; upstream never runs", async () => {
    requestApproval.mockImplementation(async (c) => approval("approved", { approver: "U0123456789" })(c.callId));
    for (const [s, t] of [["github", "delete_repo"], ["github", "nope"], ["github", "list_repos"]]) {
      ledger.failNext = 1;
      const res = await proxy().handle(call(s!, t!));
      expect(res.isError, `${s}/${t}`).toBe(true);
      expect(String((res.content as { text: string }[])[0]!.text)).toMatch(/ledger unavailable/);
    }
    expect(upstream.execute).not.toHaveBeenCalled();
  });
  it("upstream throws → error outcome recorded, isError result; an isError ToolResult → error outcome", async () => {
    upstream.execute.mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "UpstreamError" }));
    const p = proxy();
    expect((await p.handle(call("github", "list_repos"))).isError).toBe(true);
    expect(outcomes()[0]!.outcome).toMatchObject({ status: "error", errorClass: "UpstreamError" });
    upstream.execute.mockResolvedValueOnce({ content: "nope", isError: true });
    expect((await p.handle(call("github", "list_repos"))).isError).toBe(true);
    expect(outcomes()[1]!.outcome).toMatchObject({ status: "error", errorClass: "tool-error" });
  });
});

describe("ADR-009 + pin 1: argument projection (clear fields kept, everything else HMAC-SHA256 over JCS)", () => {
  const hmac = (v: unknown) => `${ARGS_HMAC_PREFIX}${createHmac("sha256", KEY).update(canonicalize(v)!, "utf8").digest("hex")}`;
  it("projectArgs: listed fields verbatim, others hmac-sha256:<hex> of HMAC(key, JCS(value)); JCS makes key order irrelevant", () => {
    const out = projectArgs({ owner: "acme", body: "x", n: 1, nested: { b: 2, a: [1, "two"] }, nul: null }, ["owner"], KEY);
    expect(out).toEqual({ owner: "acme", body: hmac("x"), n: hmac(1), nested: hmac({ a: [1, "two"], b: 2 }), nul: hmac(null) });
    expect(out["nested"]).toBe(projectArgs({ nested: { a: [1, "two"], b: 2 } }, [], KEY)["nested"]);
    expect(out["body"]).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    // RFC 2104 check against a hand-rolled HMAC: H((K ^ opad) || H((K ^ ipad) || text)) with a 64-byte block
    const k = Buffer.alloc(64); KEY.copy(k);
    const ipad = Buffer.from(k.map((b) => b ^ 0x36)); const opad = Buffer.from(k.map((b) => b ^ 0x5c));
    const inner = createHash("sha256").update(Buffer.concat([ipad, Buffer.from('"x"', "utf8")])).digest();
    const manual = createHash("sha256").update(Buffer.concat([opad, inner])).digest("hex");
    expect(out["body"]).toBe(`${ARGS_HMAC_PREFIX}${manual}`);
  });
  it("different keys give different digests; the same value in two calls gives the same digest (verifiable by whoever holds the key)", () => {
    const a = projectArgs({ v: "main" }, [], KEY)["v"]; const b = projectArgs({ v: "main" }, [], randomBytes(32))["v"];
    expect(a).not.toBe(b);
    expect(projectArgs({ v: "main" }, [], KEY)["v"]).toBe(a);
  });
  it("own __proto__ keys are data; the result is a fresh object; values NaN cannot be recorded (fail closed at decide)", async () => {
    const args = JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<string, unknown>;
    const out = projectArgs(args, ["a"], KEY);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    const p = createPipeline(deps({ ledger: ledger as never }));
    const d = await p.decide(call("github", "list_repos", { owner: "acme", bad: Number.NaN }));
    expect(d.decision).toBe("deny");
    expect(d.reason).toMatch(/arguments cannot be recorded/);
  });
  it("through decide(): reviewed row keeps its storeArgs; storeArgs [] hashes everything; unreviewed tools store NO clear args", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    await p.decide(call("github", "create_issue", { owner: "acme", repo: "r", title: "Bug", body: "token=abc" }));
    expect(intents()[0]!.call.args).toEqual({ owner: "acme", repo: "r", title: "Bug", body: hmac("token=abc") });
    await p.decide(call("builtin:claude-code", "Bash", { command: "curl -H 'Authorization: Bearer x'", description: "d" }));
    expect(intents()[1]!.call.args).toEqual({ command: hmac("curl -H 'Authorization: Bearer x'"), description: hmac("d") });
    await p.decide(call("github", "unknown_tool", { owner: "acme" }));
    expect(intents()[2]!.call.args).toEqual({ owner: hmac("acme") });
    await p.decide(call("github", "list_repos", { owner: "acme", constructor: "x" }));
    expect(intents()[3]!.call.args).toEqual({ owner: "acme", constructor: hmac("x") });
    expect(JSON.stringify(ledger.records)).not.toContain("token=abc");
  });
  it("with the REAL jsonl ledger: redaction still runs on clear fields (defence in depth), HMAC strings survive it, and no stored line carries the credential", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-ledger-pipeline-"));
    try {
      const real = createLedger("jsonl", join(dir, "ledger.jsonl"));
      const p = createPipeline(deps({ ledger: real }));
      await p.decide(call("github", "create_issue", { owner: "acme", repo: "r", title: "rotate token=hunter2 now", body: "secret body" }, "r1"));
      await p.decide(call("builtin:claude-code", "Read", { file_path: "/etc/passwd", password: "p" }, "r2"));
      await p.recordOutcome("r1", { status: "ok" });
      const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as LedgerRecord);
      expect(lines.length).toBe(3);
      expect(lines[0]!.call.args["title"]).toBe("rotate token=[REDACTED:assignment]");
      expect(lines[0]!.call.args["body"]).toBe(hmac("secret body"));
      expect(lines[1]!.call.args["file_path"]).toBe("/etc/passwd");
      // Astra P2 #6: a field whose NAME is sensitive keeps its HMAC evidence through the ledger's key-layer redaction (ADR-009: every non-clear field is stored as its digest)
      expect(lines[1]!.call.args["password"]).toBe(hmac("p"));
      expect(lines[2]!.phase).toBe("outcome");
      expect(lines[2]!.call.args).toEqual(lines[0]!.call.args);
      const text = readFileSync(join(dir, "ledger.jsonl"), "utf8");
      expect(text).not.toContain(CRED.value);
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("secret body");
      expect(await real.verify()).toEqual({ ok: true, checked: 3 });
      writeFileSync(join(dir, "ok"), "");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("Astra P2 #6: sensitive NAMES on an unreviewed tool keep distinct, key-verifiable digests in the REAL ledger; clear sensitive-looking VALUES are still redacted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-ledger-pipeline-"));
    try {
      const real = createLedger("jsonl", join(dir, "ledger.jsonl"));
      const p = createPipeline(deps({ ledger: real }));
      const other = randomBytes(32);
      const p2 = createPipeline(deps({ ledger: real, argsHmacKey: other }));
      await p.decide(call("github", "unknown_tool", { password: "hunter2", token: "t-1", api_key: "k", Authorization: "Bearer abc", nested_secret: { pin: "1234" } }, "k1"));
      await p.decide(call("github", "unknown_tool", { password: "hunter3" }, "k2"));
      await p2.decide(call("github", "unknown_tool", { password: "hunter2" }, "k3"));
      const lines = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as LedgerRecord);
      expect(lines[0]!.call.args).toEqual({ password: hmac("hunter2"), token: hmac("t-1"), api_key: hmac("k"), Authorization: hmac("Bearer abc"), nested_secret: hmac({ pin: "1234" }) });
      expect(lines[1]!.call.args["password"]).toBe(hmac("hunter3"));
      expect(lines[1]!.call.args["password"]).not.toBe(lines[0]!.call.args["password"]);
      const otherMac = `${ARGS_HMAC_PREFIX}${createHmac("sha256", other).update('"hunter2"', "utf8").digest("hex")}`;
      expect(lines[2]!.call.args["password"]).toBe(otherMac);
      expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).not.toMatch(/hunter|t-1|1234|Bearer/);
      expect(await real.verify()).toEqual({ ok: true, checked: 3 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the pipeline reads no suggestions file: deps.registry is the only policy input", () => {
    const src = readFileSync("src/pipeline/contract.ts", "utf8");
    expect(src).not.toMatch(/suggestions|suggestClass|loadSuggestions/);
    expect(src).toMatch(/evaluate\(registry, rawCall\)/);
  });
});
