import { describe, it, expect } from "vitest";
import { VERDICTS, type ApprovalResult, type IncomingCall, type LedgerRecord, type ToolCall } from "../src/types/index.js";
import { notImplemented } from "../src/types/not-implemented.js";

describe("types", () => {
  it("exposes the three verdicts", () => {
    expect(VERDICTS).toEqual(["allow", "deny", "require_approval"]);
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
  it("LedgerRecord shape compiles", () => {
    const r: LedgerRecord = {
      id: "r1", phase: "intent",
      call: { callId: "c1", sessionId: "s1", agentId: "a1", server: "github", tool: "list_repos", args: {}, receivedAt: "2026-09-28T00:00:00Z" },
      policy: { verdict: "allow", ruleId: "read-only", reason: "read-only", risk: "read" },
      prevHash: "0", hash: "h", writtenAt: "2026-09-28T00:00:00Z",
    };
    expect(r.phase).toBe("intent");
  });
});
