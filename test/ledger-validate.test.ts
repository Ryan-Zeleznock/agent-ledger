import { describe, it, expect } from "vitest";
import { parseInstant, assertJsonData, projectUnsealed, projectStored, ValidationError, MAX_DEPTH } from "../src/ledger/validate.js";
import { unsealed, sealedWithoutHash } from "./helpers/ledger-fixtures.js";
import { hashRecord } from "../src/ledger/contract.js";

describe("parseInstant (Astra #12: explicit offset, real calendar)", () => {
  it("accepts RFC 3339 with Z or ±hh:mm and treats equivalent offsets as the same instant", () => {
    expect(parseInstant("2026-09-30T00:00:00Z", "t")).toBe(Date.UTC(2026, 8, 30));
    expect(parseInstant("2026-09-30T02:00:00+02:00", "t")).toBe(Date.UTC(2026, 8, 30));
    expect(parseInstant("2026-09-29T19:00:00.250-05:00", "t")).toBe(Date.UTC(2026, 8, 30, 0, 0, 0, 250));
    expect(parseInstant("2026-09-30T00:00:00.123456789Z", "t")).toBe(Date.UTC(2026, 8, 30, 0, 0, 0, 123));
    expect(parseInstant(new Date().toISOString(), "t")).toBeTypeOf("number");
  });
  it("rejects timezone-free, impossible-calendar, epoch-like and non-string values whatever the host TZ", () => {
    const prev = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/New_York"]) {
        process.env.TZ = tz;
        for (const bad of ["2026-09-30T00:00:00", "2026-09-30", "0", "yesterday", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-09-30T24:00:00Z", "2026-09-30T00:00:00+25:00", 1727654400000, null]) {
          expect(() => parseInstant(bad, "t"), String(bad)).toThrow(ValidationError);
        }
      }
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  });
});

describe("assertJsonData (Astra #5: JSON-only boundary; #6: limits)", () => {
  it("accepts what JSON.parse produces", () => {
    expect(() => assertJsonData(JSON.parse('{"a":[1,"x",null,true,{"b":{}}],"__proto__":{"c":1}}'), "args")).not.toThrow();
  });
  it("rejects functions, accessors, own toJSON functions, class instances, undefined, bigint, symbols, NaN and lone surrogates", () => {
    const cases: [string, unknown][] = [
      ["function", { f() { return 1; } }],
      ["toJSON", { obj: { toJSON() { return { password: "raw-from-toJSON" }; } } }],
      ["accessor", Object.defineProperty({}, "x", { get: () => "secret", enumerable: true })],
      ["Date", { d: new Date() }],
      ["Map", { m: new Map() }],
      ["class", { c: new (class Foo { a = 1; })() }],
      ["undefined member", { u: undefined }],
      ["undefined array item", { a: [1, undefined] }],
      ["bigint", { b: 10n }],
      ["symbol", { s: Symbol("x") }],
      ["NaN", { n: Number.NaN }],
      ["Infinity", { n: 1e400 }],
      ["lone surrogate", { s: "\uD800" }],
      ["lone surrogate key", { "\uD800": 1 }],
    ];
    for (const [name, v] of cases) expect(() => assertJsonData(v, "args"), name).toThrow(ValidationError);
  });
  it("rejects nesting deeper than MAX_DEPTH and oversize strings before any expensive processing", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_DEPTH + 2; i++) deep = [deep];
    expect(() => assertJsonData({ deep }, "args")).toThrow(/nested deeper/);
    expect(() => assertJsonData({ s: "x".repeat(256 * 1024 + 1) }, "args")).toThrow(/longer than/);
    expect(() => assertJsonData({ a: "x".repeat(200_000), b: "y".repeat(200_000) }, "args")).not.toThrow();
  });
});

describe("projectUnsealed / projectStored (Astra #1, #9)", () => {
  it("rebuilds every nested object field by field: smuggled properties never survive", () => {
    const dirty = structuredClone(unsealed(1)) as unknown as { policy: Record<string, unknown>; call: Record<string, unknown> } & Record<string, unknown>;
    dirty.policy.credential = { value: "RAW-SECRET" };
    dirty.call.credential = { kind: "api_key", value: "RAW-CRED" };
    dirty.approval = { callId: "call-1", decision: "approved", decidedAt: "2026-09-30T12:00:00Z", channel: "slack", approver: "U1", rawArgs: { password: "x" } };
    dirty.outcome = { status: "ok", durationMs: 5, credential: "leak" };
    dirty.handoff = { kind: "to-proxy", proxyServerName: "agentledger_abc123def456", token: "leak" };
    (dirty as Record<string, unknown>).hash = "deadbeef"; (dirty as Record<string, unknown>).extra = 1;
    const out = JSON.stringify(projectUnsealed(dirty));
    expect(out).not.toMatch(/RAW-SECRET|RAW-CRED|rawArgs|leak|deadbeef|extra|credential/);
    expect(JSON.parse(out).approval).toEqual({ callId: "call-1", decision: "approved", decidedAt: "2026-09-30T12:00:00Z", channel: "slack", approver: "U1" });
  });
  it("rejects objects smuggled through nominal string fields, bad enums, missing fields and bad timestamps", () => {
    const bad = (mut: (r: Record<string, unknown>) => void) => { const r = structuredClone(unsealed(1)) as unknown as Record<string, unknown>; mut(r); return () => projectUnsealed(r); };
    expect(bad((r) => { (r.call as Record<string, unknown>).tool = { name: "Read" }; })).toThrow(/call\.tool/);
    expect(bad((r) => { (r.policy as Record<string, unknown>).verdict = "maybe"; })).toThrow(/verdict/);
    expect(bad((r) => { delete (r.policy as Record<string, unknown>).ruleId; })).toThrow(/ruleId/);
    expect(bad((r) => { (r.call as Record<string, unknown>).receivedAt = "2026-09-30T12:00:00"; })).toThrow(/receivedAt/);
    expect(bad((r) => { r.outcome = { status: "ok", durationMs: -1 }; })).toThrow(/durationMs/);
    expect(bad((r) => { r.handoff = { kind: "elsewhere", proxyServerName: "x" }; })).toThrow(/handoff\.kind/);
    expect(bad((r) => { (r.call as Record<string, unknown>).args = [1]; })).toThrow(/args/);
    expect(bad((r) => { r.id = ""; })).toThrow(/id/);
  });
  it("projectStored requires the four sealed fields to be well-formed and genesis-consistent", () => {
    const rec = sealedWithoutHash(1);
    const full = { ...rec, hash: hashRecord(rec) };
    expect(projectStored(full)).toEqual(full);
    expect(() => projectStored({ id: "bad", hash: "x" })).toThrow(ValidationError);
    expect(() => projectStored({ ...full, hash: "x" })).toThrow(/hash/);
    expect(() => projectStored({ ...full, prevHash: "ab" })).toThrow(/prevHash/);
    expect(() => projectStored({ ...full, parentRecordId: "rec-0" })).toThrow(/genesis/);
    expect(() => projectStored({ ...full, writtenAt: "2026-09-30T12:00:01" })).toThrow(/writtenAt/);
    expect(() => projectStored({ id: "only", prevHash: "0", parentRecordId: null, hash: "a".repeat(64) })).toThrow(ValidationError);
  });
});
