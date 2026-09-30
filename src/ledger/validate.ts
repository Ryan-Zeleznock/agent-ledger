import { types } from "node:util";
import { APPROVAL_DECISIONS, RISKS, VERDICTS } from "../types/index.js";
import type { ApprovalResult, LedgerRecord, Outcome, PolicyDecision, ProxyHandoff, ToolCall, UnsealedRecord } from "../types/index.js";

/**
 * Strict runtime validation shared by sealing, tail inspection, verify() and read() (Astra reviews 2026-09-30).
 * Everything the ledger stores or trusts passes through here: the JSON-only boundary (as a SNAPSHOT, never re-reading
 * the caller's object), RFC 3339 timestamps with an explicit offset, and explicit field-by-field projection of every
 * nested contract object. Two modes: `strict: false` (append: unknown fields are DROPPED so nothing unnamed reaches
 * the file) and `strict: true` (stored records: unknown fields at ANY level are REJECTED, so the hash always covers the
 * complete stored line and an injected field makes verify() fail; re-review P1 "stored modifications bypass hashing").
 */

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ValidationError"; }
}
const fail = (field: string, what: string): never => { throw new ValidationError(`ledger: ${field} ${what}`); };

// ---------- limits ----------
export const MAX_DEPTH = 64;                       // nesting levels inside args
export const MAX_STRING_CHARS = 256 * 1024;        // one string value
export const MAX_TOTAL_CHARS = 4 * 1024 * 1024;    // all string content in one record
export const MAX_SCALAR_CHARS = 4096;              // ids, names, reasons and other contract scalars
export const MAX_FRACTION_DIGITS = 3;              // timestamps: milliseconds, what Date#toISOString writes
const HEX64 = /^[0-9a-f]{64}$/;
/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one (RFC 8785 refuses both). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormed = (s: string) => !LONE_SURROGATE.test(s);

// ---------- timestamps (#12) ----------
/**
 * RFC 3339 `date-time` with an EXPLICIT offset (`Z` or `±hh:mm`), a real calendar day, and at most 3 fractional digits.
 * Returns epoch milliseconds (exact: 3 digits fit an integer, so range comparisons keep full precision).
 * Refused on purpose, documented here (re-review P2 "timestamp parsing changes instants"):
 * - timezone-free strings: `Date.parse` reads them in the host zone (ECMA-262 §21.4.3.2), which made one range include
 *   a record under TZ=UTC and exclude it under America/New_York;
 * - seconds `:60` (leap seconds, RFC 3339 §5.7): ECMAScript time values have no representation for a leap second
 *   (ECMA-262 §21.4.1.1 "ignores leap seconds"), so accepting one would silently shift the instant onto :59;
 * - more than 3 fractional digits: they cannot be represented exactly in an epoch-millisecond number, so ordering
 *   between `.000000001Z` and `.000Z` would be lost. Our own clock writes exactly 3.
 */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;
export function parseInstant(value: unknown, field: string): number {
  if (typeof value !== "string") return fail(field, "must be an RFC 3339 timestamp string");
  const m = RFC3339.exec(value);
  if (!m) return fail(field, `must be an RFC 3339 timestamp with an explicit offset (got ${JSON.stringify(value.slice(0, 64))})`);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (s === 60) return fail(field, "is a leap second (:60), which ECMAScript time cannot represent; refused rather than shifted");
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return fail(field, "has an out-of-range date or time component");
  if (m[7] !== undefined && m[7].length > MAX_FRACTION_DIGITS) return fail(field, `has more than ${MAX_FRACTION_DIGITS} fractional digits; millisecond precision only`);
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return fail(field, "names a day that does not exist");
  let ms = utc + (m[7] ? Number(m[7].padEnd(3, "0")) : 0);
  const off = m[8]!;
  if (off !== "Z" && off !== "z") {
    const sign = off.startsWith("-") ? -1 : 1;
    const oh = Number(off.slice(1, 3)); const om = Number(off.slice(4, 6));
    if (oh > 23 || om > 59) return fail(field, "has an invalid offset");
    ms -= sign * (oh * 60 + om) * 60_000;
  }
  return ms;
}

// ---------- JSON-only boundary (#5) ----------
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
const isPlainArray = (v: unknown): v is unknown[] => Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype;

interface Budget { chars: number; }
/**
 * Returns a plain deep COPY of `v`, accepting exactly what JSON.parse can produce: null, finite numbers, well-formed
 * strings, booleans, dense plain arrays and plain objects (prototype Object.prototype or null) whose properties are
 * plain data properties. Every value is read once, through its property DESCRIPTOR, so a getter is never invoked
 * (re-review P2 "array accessors restore the toJSON leak"); Proxies are rejected outright. Rejects functions, symbols,
 * bigint, undefined, accessors, holes, class instances (Date, Map, ...) and own `toJSON` functions. Enforces depth and
 * size limits before any expensive processing. Callers use the snapshot, never the original.
 */
export function snapshotJsonData(v: unknown, field: string, depth = 0, budget: Budget = { chars: 0 }): unknown {
  if (depth > MAX_DEPTH) fail(field, `is nested deeper than ${MAX_DEPTH} levels`);
  switch (typeof v) {
    case "string":
      if (v.length > MAX_STRING_CHARS) fail(field, `is longer than ${MAX_STRING_CHARS} characters`);
      if (!wellFormed(v)) fail(field, "contains a lone surrogate");
      budget.chars += v.length;
      if (budget.chars > MAX_TOTAL_CHARS) fail(field, `pushes the record past ${MAX_TOTAL_CHARS} characters of string content`);
      return v;
    case "number": if (!Number.isFinite(v)) fail(field, "is not a finite number"); return v;
    case "boolean": return v;
    case "object": {
      if (v === null) return null;
      if (types.isProxy(v)) fail(field, "is a Proxy, not data");
      if (isPlainArray(v)) {
        const len = v.length;
        if (Object.keys(v).length !== len) fail(field, "is a sparse array or carries extra properties");
        const out: unknown[] = new Array(len);
        for (let i = 0; i < len; i++) {
          const desc = Object.getOwnPropertyDescriptor(v, i);
          const item: unknown = desc !== undefined && "value" in desc ? desc.value : fail(`${field}[${i}]`, "is a hole or an accessor property, not data");
          if (item === undefined) fail(`${field}[${i}]`, "is undefined");
          out[i] = snapshotJsonData(item, `${field}[${i}]`, depth + 1, budget);
        }
        return out;
      }
      if (!isPlainObject(v)) fail(field, "is not a plain object (class instances, Date, Map, etc. are not JSON data)");
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v)) {
        const desc = Object.getOwnPropertyDescriptor(v, key)!;
        if (!("value" in desc)) fail(`${field}.${key}`, "is an accessor property, not data");
        if (desc.value === undefined) fail(`${field}.${key}`, "is undefined");
        if (!wellFormed(key)) fail(`${field}.${key}`, "has a key with a lone surrogate");
        budget.chars += key.length;
        const value = snapshotJsonData(desc.value, `${field}.${key}`, depth + 1, budget);
        Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true }); // `__proto__` stays data
      }
      return out;
    }
    default: return fail(field, `is a ${typeof v}, which is not JSON data`);
  }
}
export function assertJsonData(v: unknown, field: string): void { snapshotJsonData(v, field); }

// ---------- scalar helpers ----------
interface Mode { strict: boolean }
const LENIENT: Mode = { strict: false };
const str = (v: unknown, field: string, { min = 1 } = {}): string => {
  if (typeof v !== "string") return fail(field, "must be a string");
  if (v.length < min) return fail(field, "must not be empty");
  if (v.length > MAX_SCALAR_CHARS) return fail(field, `is longer than ${MAX_SCALAR_CHARS} characters`);
  if (!wellFormed(v)) return fail(field, "contains a lone surrogate");
  return v;
};
const has = (o: Record<string, unknown>, key: string) => Object.hasOwn(o, key) && o[key] !== undefined;
const optStr = (o: Record<string, unknown>, key: string, field: string): string | undefined => (has(o, key) ? str(o[key], `${field}.${key}`, { min: 0 }) : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string): T => {
  if (typeof v !== "string" || !allowed.includes(v as T)) return fail(field, `must be one of ${allowed.join("|")}`);
  return v as T;
};
/**
 * A contract object as a plain SNAPSHOT: prototype checked, Proxy refused, every own property read once through its
 * descriptor (accessors refused), so the values validated are the values sealed (round 3: `outcome.durationMs` getter).
 */
const obj = (v: unknown, field: string): Record<string, unknown> => {
  if (!isPlainObject(v)) return fail(field, "must be a plain object");
  if (types.isProxy(v)) return fail(field, "is a Proxy, not data");
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v)) {
    const desc = Object.getOwnPropertyDescriptor(v, key)!;
    if (!("value" in desc)) fail(`${field}.${key}`, "is an accessor property, not data");
    Object.defineProperty(out, key, { value: desc.value, enumerable: true, writable: true, configurable: true });
  }
  return out;
};
const instant = (v: unknown, field: string): string => { parseInstant(v, field); return v as string; };
const withOpt = <T extends object>(base: T, extras: Record<string, unknown>): T => {
  for (const [k, val] of Object.entries(extras)) if (val !== undefined) (base as Record<string, unknown>)[k] = val;
  return base;
};
/** strict: any own key outside `allowed` is an error (an injected field must break the hash, not vanish). */
const noExtra = (o: Record<string, unknown>, allowed: readonly string[], field: string, mode: Mode): void => {
  if (!mode.strict) return;
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) fail(field, `has unknown field(s): ${extra.join(", ")}`);
};

// ---------- projections (#1) ----------
const CALL_KEYS = ["callId", "sessionId", "agentId", "onBehalfOf", "declaredPlan", "server", "tool", "args", "receivedAt"] as const;
const POLICY_KEYS = ["verdict", "ruleId", "reason", "risk"] as const;
const APPROVAL_KEYS = ["callId", "decision", "approver", "reason", "decidedAt", "channel"] as const;
const OUTCOME_KEYS = ["status", "errorClass", "durationMs"] as const;
const HANDOFF_KEYS = ["kind", "proxyServerName"] as const;
const UNSEALED_KEYS = ["id", "phase", "call", "policy", "approval", "outcome", "handoff"] as const;
const SEALED_KEYS = ["parentRecordId", "prevHash", "hash", "writtenAt"] as const;

export function projectToolCall(v: unknown, field: string, mode: Mode = LENIENT): ToolCall {
  const c = obj(v, field);
  noExtra(c, CALL_KEYS, field, mode);
  const args = snapshotJsonData(obj(c.args, `${field}.args`), `${field}.args`) as Record<string, unknown>;
  return withOpt<ToolCall>({
    callId: str(c.callId, `${field}.callId`), sessionId: str(c.sessionId, `${field}.sessionId`), agentId: str(c.agentId, `${field}.agentId`),
    server: str(c.server, `${field}.server`), tool: str(c.tool, `${field}.tool`),
    args, receivedAt: instant(c.receivedAt, `${field}.receivedAt`),
  }, { onBehalfOf: optStr(c, "onBehalfOf", field), declaredPlan: optStr(c, "declaredPlan", field) });
}
export function projectPolicy(v: unknown, field: string, mode: Mode = LENIENT): PolicyDecision {
  const p = obj(v, field);
  noExtra(p, POLICY_KEYS, field, mode);
  return { verdict: oneOf(p.verdict, VERDICTS, `${field}.verdict`), ruleId: str(p.ruleId, `${field}.ruleId`), reason: str(p.reason, `${field}.reason`, { min: 0 }), risk: oneOf(p.risk, RISKS, `${field}.risk`) };
}
export function projectApproval(v: unknown, field: string, mode: Mode = LENIENT): ApprovalResult {
  const a = obj(v, field);
  noExtra(a, APPROVAL_KEYS, field, mode);
  return withOpt<ApprovalResult>({
    callId: str(a.callId, `${field}.callId`), decision: oneOf(a.decision, APPROVAL_DECISIONS, `${field}.decision`),
    decidedAt: instant(a.decidedAt, `${field}.decidedAt`), channel: oneOf(a.channel, ["slack", "hook-ask"] as const, `${field}.channel`),
  }, { approver: optStr(a, "approver", field), reason: optStr(a, "reason", field) });
}
export function projectOutcome(v: unknown, field: string, mode: Mode = LENIENT): Outcome {
  const o = obj(v, field);
  noExtra(o, OUTCOME_KEYS, field, mode);
  const out: Outcome = { status: oneOf(o.status, ["ok", "error", "blocked"] as const, `${field}.status`) };
  const errorClass = optStr(o, "errorClass", field);
  if (errorClass !== undefined) out.errorClass = errorClass;
  if (has(o, "durationMs")) {
    if (typeof o.durationMs !== "number" || !Number.isFinite(o.durationMs) || o.durationMs < 0) fail(`${field}.durationMs`, "must be a finite number >= 0");
    out.durationMs = o.durationMs as number;
  }
  return out;
}
export function projectHandoff(v: unknown, field: string, mode: Mode = LENIENT): ProxyHandoff {
  const h = obj(v, field);
  noExtra(h, HANDOFF_KEYS, field, mode);
  if (h.kind !== "to-proxy") fail(`${field}.kind`, 'must be "to-proxy"');
  return { kind: "to-proxy", proxyServerName: str(h.proxyServerName, `${field}.proxyServerName`) };
}

/** The unsealed record, validated and rebuilt field by field. `args` is a validated JSON snapshot, NOT yet redacted. */
export function projectUnsealed(v: unknown, field = "record", mode: Mode = LENIENT, alsoAllowed: readonly string[] = []): UnsealedRecord {
  const r = obj(v, field);
  noExtra(r, [...UNSEALED_KEYS, ...alsoAllowed], field, mode);
  const out: UnsealedRecord = {
    id: str(r.id, `${field}.id`), phase: oneOf(r.phase, ["intent", "outcome"] as const, `${field}.phase`),
    call: projectToolCall(r.call, `${field}.call`, mode), policy: projectPolicy(r.policy, `${field}.policy`, mode),
  };
  if (has(r, "approval")) out.approval = projectApproval(r.approval, `${field}.approval`, mode);
  if (has(r, "outcome")) out.outcome = projectOutcome(r.outcome, `${field}.outcome`, mode);
  if (has(r, "handoff")) out.handoff = projectHandoff(r.handoff, `${field}.handoff`, mode);
  return out;
}

/**
 * A stored record as read back from the file: STRICT. Unknown fields at any level are rejected, the four sealed fields
 * are validated, and the result equals the stored content, so `sha256Jcs(result minus hash)` covers every stored byte.
 */
export function projectStored(v: unknown, field = "record"): LedgerRecord {
  const r = obj(v, field);
  const base = projectUnsealed(r, field, { strict: true }, SEALED_KEYS);
  if (r.parentRecordId !== null && typeof r.parentRecordId !== "string") fail(`${field}.parentRecordId`, "must be a string or null");
  if (typeof r.prevHash !== "string" || !(HEX64.test(r.prevHash) || r.prevHash === "0")) fail(`${field}.prevHash`, 'must be 64 lowercase hex characters or "0"');
  if (typeof r.hash !== "string" || !HEX64.test(r.hash)) fail(`${field}.hash`, "must be 64 lowercase hex characters");
  const prevHash = r.prevHash as string; const hash = r.hash as string; const parentRecordId = r.parentRecordId as string | null;
  if ((parentRecordId === null) !== (prevHash === "0")) fail(field, "has parentRecordId/prevHash that disagree about being genesis");
  return { ...base, parentRecordId, prevHash, hash, writtenAt: instant(r.writtenAt, `${field}.writtenAt`) };
}
