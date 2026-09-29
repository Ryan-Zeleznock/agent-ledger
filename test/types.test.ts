import { describe, it, expect } from "vitest";
import { VERDICTS, type LedgerRecord } from "../src/types/index.js";
import { notImplemented } from "../src/types/not-implemented.js";

describe("types", () => {
  it("exposes the three verdicts", () => {
    expect(VERDICTS).toEqual(["allow", "deny", "require_approval"]);
  });
  it("notImplemented names the function", () => {
    expect(notImplemented("ledger.append").message).toBe("not implemented: ledger.append");
  });
  it("LedgerRecord shape compiles", () => {
    const r: LedgerRecord = {
      id: "r1", phase: "intent",
      call: { callId: "c1", sessionId: "s1", agentId: "a1", server: "github", tool: "list_repos", args: {}, receivedAt: "2026-09-28T00:00:00Z" },
      policy: { verdict: "allow", ruleId: "default-read", reason: "read-only", risk: "read" },
      prevHash: "0", hash: "h", writtenAt: "2026-09-28T00:00:00Z",
    };
    expect(r.phase).toBe("intent");
  });
});
