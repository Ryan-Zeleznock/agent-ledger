import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import canonicalize from "canonicalize";
import { ARGS_HMAC_PREFIX, CODEX_NO_CHANNEL_REASON, ORPHAN_OUTCOME_RULE_PREFIX, createPipeline, projectArgs, type PipelineDeps } from "../src/pipeline/contract.js";
import { APPROVAL_MIN_MARGIN_MS, SLACK_HOOK_TIMING, WATCHDOG_DEADLINE_AT_ENV, WATCHDOG_DEADLINE_ENV } from "../src/hooks/contract.js";
import { createLedger } from "../src/ledger/contract.js";
import type { ToolRegistry } from "../src/policy/contract.js";
import type { ApprovalResult, IncomingCall, LedgerRecord, ToolCall, ToolResult, UnsealedRecord } from "../src/types/index.js";
import { APPROVAL_DECISIONS, CODEX_MCP_NOT_PROXIED_REASON, HANDOFF_TO_PROXY_REASON } from "../src/types/index.js";
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
  it("decide-only mode refuses a missing, non-integer or already-past AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS", () => {
    delete process.env[WATCHDOG_DEADLINE_AT_ENV];
    expect(() => createPipeline(deps())).toThrow(new RegExp(WATCHDOG_DEADLINE_AT_ENV));
    for (const bad of ["soon", "1.5", "-1", "0", ""]) { process.env[WATCHDOG_DEADLINE_AT_ENV] = bad; expect(() => createPipeline(deps()), bad).toThrow(); }
    process.env[WATCHDOG_DEADLINE_AT_ENV] = String(Date.now() - 1);
    expect(() => createPipeline(deps())).toThrow(/already past/);
    // proxy mode does not need it
    delete process.env[WATCHDOG_DEADLINE_AT_ENV];
    expect(() => createPipeline(deps({ hookAgent: undefined, approvals: slack }))).not.toThrow();
  });
  it("under Codex (and Claude Code) a Slack timeoutMs that is not below the watchdog deadline throws at construction; the Slack profile passes", () => {
    process.env[WATCHDOG_DEADLINE_ENV] = "25000";
    expect(() => createPipeline(deps({ hookAgent: "codex", approvals: slack }))).toThrow(/approval-not-below-deadline/);
    expect(() => createPipeline(deps({ hookAgent: "claude-code", approvals: slack }))).toThrow(/approval-not-below-deadline/);
    expect(() => createPipeline(deps({ hookAgent: "codex", approvals: { ...slack, timeoutMs: 25_000 - APPROVAL_MIN_MARGIN_MS + 1 } }))).toThrow(/approval-not-below-deadline/);
    expect(() => createPipeline(deps({ hookAgent: "codex", approvals: { ...slack, timeoutMs: 25_000 - APPROVAL_MIN_MARGIN_MS } }))).not.toThrow();
    process.env[WATCHDOG_DEADLINE_ENV] = String(SLACK_HOOK_TIMING.deadlineMs);
    expect(() => createPipeline(deps({ hookAgent: "codex", approvals: { ...slack, timeoutMs: SLACK_HOOK_TIMING.approvalTimeoutMs! } }))).not.toThrow();
    delete process.env[WATCHDOG_DEADLINE_ENV];
    expect(() => createPipeline(deps({ hookAgent: "codex", approvals: slack }))).toThrow(new RegExp(WATCHDOG_DEADLINE_ENV));
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
    await proxy.decide(call("github", "delete_repo"));
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
  it("refuses a missing callId or an invalid status", async () => {
    const p = createPipeline(deps({ ledger: ledger as never }));
    await expect(p.recordOutcome("", { status: "ok" })).rejects.toThrow(/callId/);
    await expect(p.recordOutcome("x", { status: "weird" } as never)).rejects.toThrow(/invalid outcome/);
  });
});

describe("handle(): proxy mode", () => {
  const proxy = () => createPipeline(deps({ hookAgent: undefined, approvals: slack, ledger: ledger as never }));
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
      // a field whose NAME is sensitive is hashed by the projection and then replaced by the ledger's key layer: safe, stated in the README
      expect(lines[1]!.call.args["password"]).toBe("[REDACTED:key:password]");
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
  it("the pipeline reads no suggestions file: deps.registry is the only policy input", () => {
    const src = readFileSync("src/pipeline/contract.ts", "utf8");
    expect(src).not.toMatch(/suggestions|suggestClass|loadSuggestions/);
    expect(src).toMatch(/evaluate\(registry, rawCall\)/);
  });
});
