import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

// Library test, not business logic (ADR-002): proves the RFC 8785 (JCS) dependency the ledger will hash over
// behaves as the spec says (§5). `canonicalize` 5.1.0, pinned exactly; README claims RFC 8785 conformance.
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("canonicalize (RFC 8785 JCS)", () => {
  it("orders keys so {b,a} and {a,b} canonicalize identically", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("sorts nested objects too, keeps array order, and emits no whitespace", () => {
    const x = canonicalize({ z: [{ b: 1, a: 1 }, 2], m: { y: true, x: null } });
    expect(x).toBe('{"m":{"x":null,"y":true},"z":[{"a":1,"b":1},2]}');
    expect(x).not.toMatch(/\s/);
  });
  it("gives the same SHA-256 for two key orders, so hash-chain verification is order-independent", () => {
    const rec1 = { id: "r1", phase: "intent", policy: { verdict: "allow", risk: "read" } };
    const rec2 = { policy: { risk: "read", verdict: "allow" }, phase: "intent", id: "r1" };
    expect(sha256(canonicalize(rec1)!)).toBe(sha256(canonicalize(rec2)!));
    expect(sha256(canonicalize(rec1)!)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("serialises numbers the ECMAScript way (RFC 8785 §3.2.2.3)", () => {
    expect(canonicalize({ n: 56.0, e: 1e21, s: 1e-7 })).toBe('{"e":1e+21,"n":56,"s":1e-7}');
  });
});
