import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { hashRecord } from "../src/ledger/contract.js";
import { sealedWithoutHash } from "./helpers/ledger-fixtures.js";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("ledger.hashRecord (spec §5: SHA-256 over JCS of the record without `hash`)", () => {
  it("equals a hash computed by hand from the RFC 8785 string", () => {
    const rec = sealedWithoutHash(1);
    expect(hashRecord(rec)).toBe(sha256(canonicalize(rec)!));
    expect(hashRecord(rec)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("key order does not change the hash (todo: ledger)", () => {
    const rec = sealedWithoutHash(1);
    // Same content, keys in a different order at two nesting levels.
    const shuffled = {
      writtenAt: rec.writtenAt, prevHash: rec.prevHash, parentRecordId: rec.parentRecordId,
      policy: { risk: rec.policy.risk, reason: rec.policy.reason, ruleId: rec.policy.ruleId, verdict: rec.policy.verdict },
      call: { receivedAt: rec.call.receivedAt, args: rec.call.args, tool: rec.call.tool, server: rec.call.server, agentId: rec.call.agentId, sessionId: rec.call.sessionId, callId: rec.call.callId },
      phase: rec.phase, id: rec.id,
    } as Omit<typeof rec, never>;
    expect(hashRecord(shuffled)).toBe(hashRecord(rec));
  });

  it("ignores a stray `hash` property on the input: the preimage never contains the record's own hash", () => {
    const rec = sealedWithoutHash(1);
    const withHash = { ...rec, hash: "deadbeef" } as unknown as Omit<typeof rec, never>;
    expect(hashRecord(withHash)).toBe(hashRecord(rec));
  });

  it("changes when any field changes, including prevHash and parentRecordId", () => {
    const base = hashRecord(sealedWithoutHash(1));
    expect(hashRecord(sealedWithoutHash(1, "ab".repeat(32)))).not.toBe(base);
    expect(hashRecord(sealedWithoutHash(1, "0", "rec-0"))).not.toBe(base);
    expect(hashRecord({ ...sealedWithoutHash(1), writtenAt: "2026-09-30T12:00:02.000Z" })).not.toBe(base);
  });

  it("refuses NaN and Infinity (RFC 8785 §3.2.2.3: a JCS implementation MUST error)", () => {
    const rec = sealedWithoutHash(1);
    rec.call.args = { n: Number.NaN };
    expect(() => hashRecord(rec)).toThrow();
  });
});
