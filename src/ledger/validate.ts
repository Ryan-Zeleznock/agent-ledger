import { APPROVAL_DECISIONS, RISKS, VERDICTS } from "../types/index.js";
import type { ApprovalResult, LedgerRecord, Outcome, PolicyDecision, ProxyHandoff, ToolCall, UnsealedRecord } from "../types/index.js";

/**
 * Strict runtime validation shared by sealing, tail inspection, verify() and read() (Astra review 2026-09-30, #1, #5,
 * #9, #10, #12). Everything the ledger stores or trusts passes through here: the JSON-only boundary, RFC 3339
 * timestamps with an explicit offset, and explicit field-by-field projection of every nested contract object.
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
const HEX64 = /^[0-9a-f]{64}$/;
/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one (RFC 8785 refuses both). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormed = (s: string) => !LONE_SURROGATE.test(s);

// ---------- timestamps (#12) ----------
/**
 * RFC 3339 `date-time` with an EXPLICIT offset (`Z` or `±hh:mm`), real calendar validity, up to 9 fractional digits.
 * Returns epoch milliseconds. Timezone-free strings are refused: `Date.parse` interprets them in the host zone
 * (ECMA-262 §21.4.3.2), which made the same range include a record under TZ=UTC and exclude it under New York.
 */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;
export function parseInstant(value: unknown, field: string): number {
  if (typeof value !== "string") return fail(field, "must be an RFC 3339 timestamp string");
  const m = RFC3339.exec(value);
  if (!m) return fail(field, `must be an RFC 3339 timestamp with an explicit offset (got ${JSON.stringify(value.slice(0, 64))})`);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 60) return fail(field, "has an out-of-range date or time component");
  const utc = Date.UTC(y, mo - 1, d, h, mi, s === 60 ? 59 : s);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return fail(field, "names a day that does not exist");
  let ms = utc + (m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0);
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
 * Accepts exactly what JSON.parse can produce: null, finite numbers, well-formed strings, booleans, plain arrays and
 * plain objects (prototype Object.prototype or null) whose properties are plain data properties. Rejects functions,
 * symbols, bigint, undefined, accessors, class instances (Date, Map, ...) and own `toJSON` functions, so nothing can
 * change between redaction and canonicalisation. Enforces depth and size limits before any expensive processing.
 */
export function assertJsonData(v: unknown, field: string, depth = 0, budget: Budget = { chars: 0 }): void {
  if (depth > MAX_DEPTH) fail(field, `is nested deeper than ${MAX_DEPTH} levels`);
  switch (typeof v) {
    case "string":
      if (v.length > MAX_STRING_CHARS) fail(field, `is longer than ${MAX_STRING_CHARS} characters`);
      if (!wellFormed(v)) fail(field, "contains a lone surrogate");
      budget.chars += v.length;
      if (budget.chars > MAX_TOTAL_CHARS) fail(field, `pushes the record past ${MAX_TOTAL_CHARS} characters of string content`);
      return;
    case "number": if (!Number.isFinite(v)) fail(field, "is not a finite number"); return;
    case "boolean": return;
    case "object":
      if (v === null) return;
      if (isPlainArray(v)) {
        v.forEach((x, i) => { if (x === undefined) fail(`${field}[${i}]`, "is undefined"); assertJsonData(x, `${field}[${i}]`, depth + 1, budget); });
        return;
      }
      if (!isPlainObject(v)) fail(field, "is not a plain object (class instances, Date, Map, etc. are not JSON data)");
      for (const key of Object.keys(v)) {
        const desc = Object.getOwnPropertyDescriptor(v, key)!;
        if (!("value" in desc)) fail(`${field}.${key}`, "is an accessor property, not data");
        if (desc.value === undefined) fail(`${field}.${key}`, "is undefined");
        if (!wellFormed(key)) fail(`${field}.${key}`, "has a key with a lone surrogate");
        budget.chars += key.length;
        assertJsonData(desc.value, `${field}.${key}`, depth + 1, budget);
      }
      return;
    default: fail(field, `is a ${typeof v}, which is not JSON data`);
  }
}

// ---------- scalar helpers ----------
const str = (v: unknown, field: string, { min = 1 } = {}): string => {
  if (typeof v !== "string") return fail(field, "must be a string");
  if (v.length < min) return fail(field, "must not be empty");
  if (v.length > MAX_SCALAR_CHARS) return fail(field, `is longer than ${MAX_SCALAR_CHARS} characters`);
  if (!wellFormed(v)) return fail(field, "contains a lone surrogate");
  return v;
};
const optStr = (o: Record<string, unknown>, key: string, field: string): string | undefined =>
  Object.hasOwn(o, key) && o[key] !== undefined ? str(o[key], `${field}.${key}`, { min: 0 }) : undefined;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], field: string): T => {
  if (typeof v !== "string" || !allowed.includes(v as T)) return fail(field, `must be one of ${allowed.join("|")}`);
  return v as T;
};
const obj = (v: unknown, field: string): Record<string, unknown> => (isPlainObject(v) ? v : fail(field, "must be a plain object"));
const instant = (v: unknown, field: string): string => { parseInstant(v, field); return v as string; };
const withOpt = <T extends object>(base: T, extras: Record<string, unknown>): T => {
  for (const [k, val] of Object.entries(extras)) if (val !== undefined) (base as Record<string, unknown>)[k] = val;
  return base;
};

// ---------- projections (#1) ----------
export function projectToolCall(v: unknown, field: string): ToolCall {
  const c = obj(v, field);
  const args = obj(c.args, `${field}.args`);
  assertJsonData(args, `${field}.args`);
  return withOpt<ToolCall>({
    callId: str(c.callId, `${field}.callId`), sessionId: str(c.sessionId, `${field}.sessionId`), agentId: str(c.agentId, `${field}.agentId`),
    server: str(c.server, `${field}.server`), tool: str(c.tool, `${field}.tool`),
    args, receivedAt: instant(c.receivedAt, `${field}.receivedAt`),
  }, { onBehalfOf: optStr(c, "onBehalfOf", field), declaredPlan: optStr(c, "declaredPlan", field) });
}
export function projectPolicy(v: unknown, field: string): PolicyDecision {
  const p = obj(v, field);
  return { verdict: oneOf(p.verdict, VERDICTS, `${field}.verdict`), ruleId: str(p.ruleId, `${field}.ruleId`), reason: str(p.reason, `${field}.reason`, { min: 0 }), risk: oneOf(p.risk, RISKS, `${field}.risk`) };
}
export function projectApproval(v: unknown, field: string): ApprovalResult {
  const a = obj(v, field);
  return withOpt<ApprovalResult>({
    callId: str(a.callId, `${field}.callId`), decision: oneOf(a.decision, APPROVAL_DECISIONS, `${field}.decision`),
    decidedAt: instant(a.decidedAt, `${field}.decidedAt`), channel: oneOf(a.channel, ["slack", "hook-ask"] as const, `${field}.channel`),
  }, { approver: optStr(a, "approver", field), reason: optStr(a, "reason", field) });
}
export function projectOutcome(v: unknown, field: string): Outcome {
  const o = obj(v, field);
  const out: Outcome = { status: oneOf(o.status, ["ok", "error", "blocked"] as const, `${field}.status`) };
  const errorClass = optStr(o, "errorClass", field);
  if (errorClass !== undefined) out.errorClass = errorClass;
  if (Object.hasOwn(o, "durationMs") && o.durationMs !== undefined) {
    if (typeof o.durationMs !== "number" || !Number.isFinite(o.durationMs) || o.durationMs < 0) fail(`${field}.durationMs`, "must be a finite number >= 0");
    out.durationMs = o.durationMs as number;
  }
  return out;
}
export function projectHandoff(v: unknown, field: string): ProxyHandoff {
  const h = obj(v, field);
  if (h.kind !== "to-proxy") fail(`${field}.kind`, 'must be "to-proxy"');
  return { kind: "to-proxy", proxyServerName: str(h.proxyServerName, `${field}.proxyServerName`) };
}

/** The unsealed record, validated and rebuilt field by field. `args` are validated JSON data, NOT yet redacted. */
export function projectUnsealed(v: unknown, field = "record"): UnsealedRecord {
  const r = obj(v, field);
  const out: UnsealedRecord = {
    id: str(r.id, `${field}.id`), phase: oneOf(r.phase, ["intent", "outcome"] as const, `${field}.phase`),
    call: projectToolCall(r.call, `${field}.call`), policy: projectPolicy(r.policy, `${field}.policy`),
  };
  if (Object.hasOwn(r, "approval") && r.approval !== undefined) out.approval = projectApproval(r.approval, `${field}.approval`);
  if (Object.hasOwn(r, "outcome") && r.outcome !== undefined) out.outcome = projectOutcome(r.outcome, `${field}.outcome`);
  if (Object.hasOwn(r, "handoff") && r.handoff !== undefined) out.handoff = projectHandoff(r.handoff, `${field}.handoff`);
  return out;
}

/** A stored record as read back from the file: the unsealed projection plus the four sealed fields, all validated. */
export function projectStored(v: unknown, field = "record"): LedgerRecord {
  const r = obj(v, field);
  const base = projectUnsealed(r, field);
  if (r.parentRecordId !== null && typeof r.parentRecordId !== "string") fail(`${field}.parentRecordId`, "must be a string or null");
  if (typeof r.prevHash !== "string" || !(HEX64.test(r.prevHash) || r.prevHash === "0")) fail(`${field}.prevHash`, 'must be 64 lowercase hex characters or "0"');
  if (typeof r.hash !== "string" || !HEX64.test(r.hash)) fail(`${field}.hash`, "must be 64 lowercase hex characters");
  const prevHash = r.prevHash as string; const hash = r.hash as string; const parentRecordId = r.parentRecordId as string | null;
  if ((parentRecordId === null) !== (prevHash === "0")) fail(field, "has parentRecordId/prevHash that disagree about being genesis");
  return { ...base, parentRecordId, prevHash, hash, writtenAt: instant(r.writtenAt, `${field}.writtenAt`) };
}
