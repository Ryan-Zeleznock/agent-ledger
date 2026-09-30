import { describe, it, expect } from "vitest";
import {
  APPROVAL_DECISIONS, BUILTIN_CODEX_SERVER, BUILTIN_NAMESPACE, BUILTIN_SERVER, BUILTIN_SERVERS, BUILTIN_SERVER_KEYS, HANDOFF_TO_PROXY_REASON, HANDOFF_TO_PROXY_RULE_PREFIX, HOOK_AGENTS, HOOK_DECISIONS, HOOK_DECISION_KINDS,
  RESERVED_KEYS, RESERVED_SERVER_NAMES, RISKS, VERDICTS,
  type ApprovalChannel, type ApprovalResult, type HookAgent, type HookDecision, type IncomingCall, type LedgerRecord, type ToolCall, type ToolInfo, type UnsealedRecord,
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
    const d: HookDecision = { decision: "ask", reason: "unreviewed tool", callId: "toolu_01", kind: "decided" };
    expect(d.callId).toBe("toolu_01");
    // ADR-006: a Codex call to the proxy's tools is allowed by the hook and recorded by the proxy, never twice
    expect(HOOK_DECISION_KINDS).toEqual(["decided", "governed-by-proxy"]);
    const viaProxy: HookDecision = { decision: "allow", reason: "governed by the Agent Ledger proxy", callId: "call_01", kind: "governed-by-proxy" };
    expect(viaProxy.kind).toBe("governed-by-proxy");
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
    const slack: ApprovalChannel = {
      kind: "slack", channelId: "C0123456789", timeoutMs: 300_000, transport: "socket-mode",
      botToken: { kind: "env", name: "SLACK_BOT_TOKEN" }, appToken: { kind: "file", path: "/run/secrets/slack_app_token" }, approvers: ["U0123456789"],
    };
    const ask: ApprovalChannel = { kind: "hook-ask" };
    // @ts-expect-error hook-ask carries no timeout: there is nothing to wait for, Claude Code asks the human
    const bad: ApprovalChannel = { kind: "hook-ask", timeoutMs: 1 };
    // @ts-expect-error ADR-006: the Slack channel needs Socket Mode, both token references and an approver allowlist
    const thin: ApprovalChannel = { kind: "slack", channelId: "C0123", timeoutMs: 1 };
    expect([slack.kind, ask.kind, bad.kind, thin.kind]).toEqual(["slack", "hook-ask", "hook-ask", "slack"]);
    expect(slack.kind === "slack" && slack.transport).toBe("socket-mode");
    expect(JSON.stringify(slack)).not.toMatch(/xoxb-|xapp-/); // config carries references, never token values
    expect(APPROVAL_DECISIONS).toEqual(["approved", "denied", "timeout", "unavailable", "no-channel", "delegated"]);
    const down: ApprovalResult = { callId: "c1", decision: "unavailable", decidedAt: "2026-09-29T00:00:00Z", channel: "slack" };
    const delegated: ApprovalResult = { callId: "c1", decision: "delegated", decidedAt: "2026-09-29T00:00:00Z", channel: "hook-ask" };
    // ADR-006: under Codex a require_approval with no Slack channel is a RECORDED final deny, not a dangling delegated
    const noChannel: ApprovalResult = { callId: "c1", decision: "no-channel", reason: "Codex cannot ask and no Slack channel is configured", decidedAt: "2026-09-29T00:00:00Z", channel: "hook-ask" };
    const approved: ApprovalResult = { callId: "c1", decision: "approved", approver: "U0123456789", reason: "Approve", decidedAt: "2026-09-29T00:00:00Z", channel: "slack" };
    expect([down.decision, delegated.channel, noChannel.decision, approved.approver]).toEqual(["unavailable", "hook-ask", "no-channel", "U0123456789"]);
  });
  it("exports the reserved identity constants (Astra spec v2 findings 1 and 3; ADR-005 Codex)", () => {
    expect(BUILTIN_SERVER).toBe("builtin:claude-code");
    expect(BUILTIN_SERVER.startsWith(BUILTIN_NAMESPACE)).toBe(true);
    expect(HOOK_AGENTS).toEqual(["claude-code", "codex"]);
    expect(BUILTIN_SERVERS).toEqual({ "claude-code": "builtin:claude-code", codex: "builtin:codex" });
    expect(BUILTIN_SERVER_KEYS).toEqual(["builtin:claude-code", "builtin:codex"]);
    for (const k of BUILTIN_SERVER_KEYS) expect(k.startsWith(BUILTIN_NAMESPACE), k).toBe(true);
    const agent: HookAgent = "codex";
    expect(BUILTIN_SERVERS[agent]).toBe(BUILTIN_CODEX_SERVER);
    expect(RESERVED_KEYS).toEqual(["__proto__", "constructor", "prototype"]);
    expect(RESERVED_SERVER_NAMES).toEqual(["claudecode", "builtinclaudecode", "codex", "builtincodex"]);
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
  it("a handoff-to-proxy intent record names the proxy and classifies nothing (ADR-006, spec v2.1; Astra 2026-09-30)", () => {
    const proxy = "agentledger_proxy_7f3a9c2e1b04";
    const handoff: UnsealedRecord = {
      id: "r3", phase: "intent",
      call: { callId: "call_9", sessionId: "s1", agentId: "astra", server: proxy, tool: "list_repos", args: {}, receivedAt: "2026-09-30T00:00:00Z" },
      policy: { verdict: "allow", ruleId: `${HANDOFF_TO_PROXY_RULE_PREFIX}${proxy}`, reason: HANDOFF_TO_PROXY_REASON, risk: "unreviewed" },
      handoff: { kind: "to-proxy", proxyServerName: proxy },
    };
    expect(handoff.handoff?.proxyServerName).toBe(proxy);
    expect(handoff.policy.ruleId).toBe("handoff-to-proxy:" + proxy);
    expect(handoff.approval).toBeUndefined(); // the hook asked nobody; the proxy's own record carries any approval
    const plain: UnsealedRecord = { ...handoff, handoff: undefined };
    expect(plain.handoff).toBeUndefined(); // absent on every other record
  });
  it("ToolInfo carries the four MCP annotation hints, all optional", () => {
    const t: ToolInfo = { server: "github", name: "list_repos", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } };
    expect(Object.keys(t.annotations!).sort()).toEqual(["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"]);
    const bare: ToolInfo = { server: "github", name: "x" };
    expect(bare.annotations).toBeUndefined();
  });
});
