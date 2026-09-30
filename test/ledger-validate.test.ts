import { describe, it, expect } from "vitest";
import { parseInstant, assertJsonData, snapshotJsonData, projectUnsealed, projectStored, ValidationError, MAX_DEPTH } from "../src/ledger/validate.js";
import { unsealed, sealedWithoutHash } from "./helpers/ledger-fixtures.js";
import { hashRecord } from "../src/ledger/contract.js";

describe("parseInstant (Astra #12: explicit offset, real calendar)", () => {
  it("accepts RFC 3339 with Z or ±hh:mm and treats equivalent offsets as the same instant", () => {
    expect(parseInstant("2026-09-30T00:00:00Z", "t")).toBe(Date.UTC(2026, 8, 30));
    expect(parseInstant("2026-09-30T02:00:00+02:00", "t")).toBe(Date.UTC(2026, 8, 30));
    expect(parseInstant("2026-09-29T19:00:00.250-05:00", "t")).toBe(Date.UTC(2026, 8, 30, 0, 0, 0, 250));
    expect(parseInstant("2026-09-30T00:00:00.1Z", "t")).toBe(Date.UTC(2026, 8, 30, 0, 0, 0, 100));
    expect(parseInstant(new Date().toISOString(), "t")).toBeTypeOf("number");
  });
  it("re-review: refuses leap seconds (:60) instead of shifting them, and more than 3 fractional digits instead of losing their order", () => {
    expect(() => parseInstant("2026-09-30T12:34:60Z", "t")).toThrow(/leap second/);
    expect(() => parseInstant("2026-12-31T23:59:60Z", "t")).toThrow(/leap second/);
    expect(() => parseInstant("2026-09-30T00:00:00.0001Z", "t")).toThrow(/fractional digits/);
    expect(() => parseInstant("2026-09-30T00:00:00.000000001Z", "t")).toThrow(/fractional digits/);
    expect(parseInstant("2026-09-30T00:00:00.001Z", "t")).toBeGreaterThan(parseInstant("2026-09-30T00:00:00.000Z", "t"));
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
  it("re-review: never invokes getters: array index accessors, Proxies, holes and extra array properties are rejected; the result is a snapshot", () => {
    let reads = 0;
    const arr: unknown[] = ["safe"];
    Object.defineProperty(arr, 1, { get() { reads++; return reads <= 2 ? "safe" : { toJSON() { return { password: "RAW" }; } }; }, enumerable: true, configurable: true });
    expect(() => snapshotJsonData({ arr }, "args")).toThrow(/accessor/);
    expect(reads).toBe(0);
    expect(() => snapshotJsonData({ p: new Proxy([1, 2], {}) }, "args")).toThrow(/Proxy/);
    expect(() => snapshotJsonData({ p: new Proxy({ a: 1 }, {}) }, "args")).toThrow(/Proxy/);
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    expect(() => snapshotJsonData({ sparse }, "args")).toThrow(/sparse|hole/);
    const extra = [1, 2] as unknown[] & { foo?: string }; extra.foo = "x";
    expect(() => snapshotJsonData({ extra }, "args")).toThrow(/extra properties/);
    const src = { a: [{ b: "c" }] };
    const snap = snapshotJsonData(src, "args") as typeof src;
    expect(snap).toEqual(src);
    src.a[0]!.b = "mutated";
    expect(snap.a[0]!.b).toBe("c");
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
  it("re-review P1: projectStored REJECTS unknown fields at every level, so an injected field can never be dropped before hashing", () => {
    const rec = sealedWithoutHash(1);
    const full = { ...rec, hash: hashRecord(rec), approval: undefined, outcome: { status: "ok" as const }, handoff: { kind: "to-proxy" as const, proxyServerName: "agentledger_abc123def456" } };
    delete (full as { approval?: unknown }).approval;
    const withHash = { ...full, hash: hashRecord(full) };
    expect(projectStored(withHash)).toEqual(withHash);
    const inject = (mut: (r: Record<string, unknown>) => void) => { const r = structuredClone(withHash) as unknown as Record<string, unknown>; mut(r); return () => projectStored(r); };
    expect(inject((r) => { r.credential = "UNHASHED"; })).toThrow(/record has unknown field\(s\): credential/);
    expect(inject((r) => { (r.policy as Record<string, unknown>).credential = "UNHASHED-SECRET"; })).toThrow(/record\.policy has unknown field/);
    expect(inject((r) => { (r.call as Record<string, unknown>).credential = { kind: "api_key", value: "x" }; })).toThrow(/record\.call has unknown field/);
    expect(inject((r) => { (r.outcome as Record<string, unknown>).note = "x"; })).toThrow(/record\.outcome has unknown field/);
    expect(inject((r) => { (r.handoff as Record<string, unknown>).extra = 1; })).toThrow(/record\.handoff has unknown field/);
    expect(inject((r) => { r.approval = { callId: "c", decision: "approved", decidedAt: "2026-09-30T12:00:00Z", channel: "slack", rawArgs: {} }; })).toThrow(/record\.approval has unknown field/);
    // append stays lenient: the same junk is DROPPED there, never stored
    const dirty = structuredClone(withHash) as unknown as Record<string, unknown>;
    (dirty.policy as Record<string, unknown>).credential = "x";
    expect(JSON.stringify(projectUnsealed(dirty))).not.toContain("credential");
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
