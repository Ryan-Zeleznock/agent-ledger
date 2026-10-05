import canonicalize from "canonicalize";
import type { LedgerRecord, UnsealedRecord, VerifyResult } from "../types/index.js";
import { sha256Jcs } from "./hash.js";
import { redactArgs } from "./redact.js";
import { MAX_LEDGER_LINE_BYTES, assertJsonData, projectStored, projectUnsealed } from "./validate.js";

export const GENESIS_HASH = "0";
export interface Tail { id: string | null; hash: string }
const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * Parses and strictly validates one stored line; returns the record or the reason it is not one. The line must be
 * EXACTLY the RFC 8785 serialisation of the validated record (round 3): that one rule rejects duplicate member names
 * (JSON.parse keeps the last, so a duplicate could carry unhashed text), whitespace, and reordering, so the bytes on
 * disk are exactly the bytes the hash covers.
 */
/** Best-effort `id` of a damaged line, for `brokenAt`; never trusted for anything else. */
function idOf(raw: string): { id?: string } {
  try {
    const p: unknown = JSON.parse(raw);
    const id = typeof p === "object" && p !== null ? (p as { id?: unknown }).id : undefined;
    return typeof id === "string" ? { id } : {};
  } catch { return {}; }
}
export function parseStored(raw: string): { rec: LedgerRecord; err?: undefined } | { rec?: undefined; err: string; id?: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_LEDGER_LINE_BYTES) return { err: "ledger line size limit exceeded" };
  if (raw.length === 0) return { err: "blank line" };
  // Physical framing first, before any parsing (JSON.parse would tolerate a trailing `\r` as whitespace):
  // records are LF-framed canonical JSON, which never contains a raw CR, so `\r\n` or a stray `\r` is damage.
  if (raw.includes("\r")) return { err: "line contains a carriage return; records are LF-framed only", ...idOf(raw) };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { err: "not JSON" }; }
  const id = typeof parsed === "object" && parsed !== null && typeof (parsed as { id?: unknown }).id === "string" ? (parsed as { id: string }).id : undefined;
  let rec: LedgerRecord;
  try { rec = projectStored(parsed); } catch (e) { return { err: message(e), ...(id !== undefined && { id }) }; }
  let canonical: string | undefined;
  try { canonical = canonicalize(rec); } catch (e) { return { err: `not canonicalisable: ${message(e)}`, id: rec.id }; }
  if (canonical !== raw) return { err: "line is not the canonical (RFC 8785) serialisation of its record: duplicate members, whitespace or reordering", id: rec.id };
  return { rec };
}

// ---------- sealing ----------

/**
 * Validate + project (nothing unnamed survives), redact args, re-validate the REDACTED args against the storage limits
 * (redaction can expand text: `a@b.co` → `[REDACTED:email]`; a record the store could not read back must never be
 * written; re-review P1 "successful append can disable subsequent appends"), then seal.
 */
export function sealRecord(record: UnsealedRecord, tail: Tail): LedgerRecord {
  const u = projectUnsealed(record);
  const args = redactArgs(u.call.args);
  try { assertJsonData(args, "record.call.args"); } catch (e) { throw new Error(`ledger.append: after redaction, ${message(e).replace(/^ledger: /, "")}; nothing was written`); }
  const preimage: Omit<LedgerRecord, "hash"> = {
    ...u,
    call: { ...u.call, args },
    parentRecordId: tail.id,
    prevHash: tail.hash,
    writtenAt: new Date().toISOString(),
  };
  return { ...preimage, hash: sha256Jcs(preimage) };
}

/**
 * The exact line to write, proven readable first (round 3): the sealed record is serialised, then pushed through the
 * SAME strict read path (`parseStored`) and its hash recomputed. Only bytes that verify() will accept are written.
 */
export function sealedLine(sealed: LedgerRecord): string {
  const line = canonicalize(sealed);
  if (typeof line !== "string") throw new Error("ledger.append: sealed record has no JSON representation; nothing was written");
  const p = parseStored(line);
  if (p.err !== undefined) throw new Error(`ledger.append: sealed record fails stored validation (${p.err}); nothing was written`);
  const { hash, ...preimage } = p.rec;
  if (sha256Jcs(preimage) !== hash || hash !== sealed.hash) throw new Error("ledger.append: sealed record does not re-hash to itself; nothing was written");
  return line;
}

/** A tail must be canonical, shape-valid, and hash to itself before another record can follow it. */
export function checkStoredLine(raw: string): LedgerRecord {
  const p = parseStored(raw);
  if (p.err !== undefined) throw new Error(`ledger: invalid stored line (${p.err}); refusing to append. Run verify()`);
  const { hash, ...preimage } = p.rec;
  if (sha256Jcs(preimage) !== hash) throw new Error("ledger: stored record fails its own hash; refusing to append. Run verify()");
  return p.rec;
}

/** Internal consistency only: a deleted suffix needs an independently retained anchor to detect it. */
export async function verifyLines(lines: AsyncIterable<string>): Promise<VerifyResult> {
  let checked = 0;
  let prevId: string | null = null;
  let prevHash = GENESIS_HASH;
  const ids = new Set<string>();
  for await (const raw of lines) {
    checked++;
    const broken = (id?: string): VerifyResult => ({ ok: false, checked, brokenAt: id ?? `line:${checked}` });
    const p = parseStored(raw);
    if (p.err !== undefined) return broken(p.id);
    const rec = p.rec;
    if (ids.has(rec.id) || rec.prevHash !== prevHash || rec.parentRecordId !== prevId) return broken(rec.id);
    try { checkStoredLine(raw); } catch { return broken(rec.id); }
    ids.add(rec.id); prevId = rec.id; prevHash = rec.hash;
  }
  return { ok: true, checked };
}
