import { describe, it, expect } from "vitest";
import {
  APPROVAL_DECISIONS, BUILTIN_NAMESPACE, BUILTIN_SERVER, HOOK_DECISIONS, RESERVED_KEYS, RESERVED_SERVER_NAMES, RISKS, VERDICTS,
  type ApprovalChannel, type ApprovalResult, type HookDecision, type IncomingCall, type LedgerRecord, type ToolCall, type ToolInfo, type UnsealedRecord,
} from "../src/types/index.js";
import { notImplemented } from "../src/types/not-implemented.js";

describe("types", () => {
  it("exposes the three verdicts", () => {
    expect(VERDICTS).toEqual(["allow", "deny", "require_approval"]);
  });
  it("exposes the three reviewed classes plus unreviewed (ADR-004)", () => {
    expect(RISKS).toEqual(["read", "write", "risky", "unreviewed"]);
  });
  it("hook decisions are allow | deny | ask, never defer", () => {
    expect(HOOK_DECISIONS).toEqual(["allow", "deny", "ask"]);
    expect(HOOK_DECISIONS).not.toContain("defer");
    const d: HookDecision = { decision: "ask", reason: "unreviewed tool", callId: "toolu_01" };
    expect(d.callId).toBe("toolu_01");
  });
  it("notImplemented names the function", () => {
    expect(notImplemented("ledger.append").message).toBe("not implemented: ledger.append");
  });
  it("IncomingCall carries a credential and no agent or session id", () => {
    const incoming: IncomingCall = {
      callId: "c1", credential: { kind: "api_key", value: "k" },
      server: "github", tool: "list_repos", args: {}, receivedAt: "2026-09-28T00:00:00Z",
      onBehalfOf: "ryan", declaredPlan: "list repos",
    };
    expect(incoming.credential.kind).toBe("api_key");
    expect("agentId" in incoming).toBe(false);
    expect("sessionId" in incoming).toBe(false);
    const authenticated: ToolCall = {
      callId: incoming.callId, sessionId: "s1", agentId: "a1",
      server: incoming.server, tool: incoming.tool, args: incoming.args, receivedAt: incoming.receivedAt,
      // @ts-expect-error a ToolCall is authenticated: it never carries the credential
      credential: incoming.credential,
    };
    expect(authenticated.callId).toBe("c1");
  });
  it("ApprovalResult is bound to a callId", () => {
    const a: ApprovalResult = { callId: "c1", decision: "approved", approver: "ryan", decidedAt: "2026-09-28T00:00:00Z", channel: "slack" };
    expect(a.callId).toBe("c1");
  });
  it("ApprovalChannel is a union: slack with its options, or hook-ask with none (Astra spec v2 finding 4)", () => {
    const slack: ApprovalChannel = { kind: "slack", channelId: "C0123", timeoutMs: 300_000 };
    const ask: ApprovalChannel = { kind: "hook-ask" };
    // @ts-expect-error hook-ask carries no timeout: there is nothing to wait for, Claude Code asks the human
    const bad: ApprovalChannel = { kind: "hook-ask", timeoutMs: 1 };
    expect([slack.kind, ask.kind, bad.kind]).toEqual(["slack", "hook-ask", "hook-ask"]);
    expect(APPROVAL_DECISIONS).toEqual(["approved", "denied", "timeout", "unavailable", "delegated"]);
    const down: ApprovalResult = { callId: "c1", decision: "unavailable", decidedAt: "2026-09-29T00:00:00Z", channel: "slack" };
    const delegated: ApprovalResult = { callId: "c1", decision: "delegated", decidedAt: "2026-09-29T00:00:00Z", channel: "hook-ask" };
    expect([down.decision, delegated.channel]).toEqual(["unavailable", "hook-ask"]);
  });
  it("exports the reserved identity constants (Astra spec v2 findings 1 and 3)", () => {
    expect(BUILTIN_SERVER).toBe("builtin:claude-code");
    expect(BUILTIN_SERVER.startsWith(BUILTIN_NAMESPACE)).toBe(true);
    expect(RESERVED_KEYS).toEqual(["__proto__", "constructor", "prototype"]);
    expect(RESERVED_SERVER_NAMES).toEqual(["claudecode", "builtinclaudecode"]);
  });
  it("LedgerRecord shape compiles, with the chain fields the ledger seals", () => {
    const unsealed: UnsealedRecord = {
      id: "r1", phase: "intent",
      call: { callId: "c1", sessionId: "s1", agentId: "a1", server: "github", tool: "list_repos", args: {}, receivedAt: "2026-09-28T00:00:00Z" },
      policy: { verdict: "allow", ruleId: "registry:github/list_repos", reason: "reviewed read", risk: "read" },
    };
    const genesis: LedgerRecord = { ...unsealed, parentRecordId: null, prevHash: "0", hash: "h1", writtenAt: "2026-09-28T00:00:00Z" };
    const next: LedgerRecord = { ...unsealed, id: "r2", parentRecordId: genesis.id, prevHash: genesis.hash, hash: "h2", writtenAt: "2026-09-28T00:00:01Z" };
    expect(genesis.parentRecordId).toBeNull();
    expect(next.parentRecordId).toBe("r1");
    expect("parentRecordId" in unsealed).toBe(false);
  });
  it("ToolInfo carries the four MCP annotation hints, all optional", () => {
    const t: ToolInfo = { server: "github", name: "list_repos", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } };
    expect(Object.keys(t.annotations!).sort()).toEqual(["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"]);
    const bare: ToolInfo = { server: "github", name: "x" };
    expect(bare.annotations).toBeUndefined();
  });
});
