import type { LedgerRecord, UnsealedRecord } from "../../src/types/index.js";

/** A realistic unsealed intent record. `n` makes ids and callIds unique; `args` overrides the tool arguments. */
export function unsealed(n: number, args: Record<string, unknown> = { path: `/tmp/file-${n}.txt` }): UnsealedRecord {
  return {
    id: `rec-${n}`,
    phase: "intent",
    call: {
      callId: `call-${n}`, sessionId: "sess-1", agentId: "agent-1",
      server: "builtin:claude-code", tool: "Read", args, receivedAt: "2026-09-30T12:00:00.000Z",
    },
    policy: { verdict: "allow", ruleId: "builtin:claude-code/Read", reason: "reviewed read tool", risk: "read" },
  };
}

/** A fully sealed record with a fixed clock, for hashing tests. `hash` is left for the test to compute. */
export function sealedWithoutHash(n: number, prevHash = "0", parentRecordId: string | null = null): Omit<LedgerRecord, "hash"> {
  return { ...unsealed(n), parentRecordId, prevHash, writtenAt: "2026-09-30T12:00:01.000Z" };
}
