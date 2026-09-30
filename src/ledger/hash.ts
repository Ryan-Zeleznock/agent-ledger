import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { LedgerRecord } from "../types/index.js";

/**
 * `hash = SHA-256(JCS(record without hash))`, lowercase hex (spec §5). The input's own `hash` property, if any, is
 * dropped by name so the preimage can never contain the hash it produces. `canonicalize` (RFC 8785) sorts keys by
 * UTF-16 code unit, drops `undefined`-valued properties like JSON.stringify, emits no whitespace, and throws on NaN,
 * Infinity, lone surrogates and cycles (RFC 8785 §3.2.2.3 says a JCS implementation MUST error on NaN/Infinity;
 * verified against lib/canonicalize.js 5.1.0, 2026-09-30).
 */
export function sha256Jcs(record: Omit<LedgerRecord, "hash">): string {
  const { hash: _dropped, ...preimage } = record as Omit<LedgerRecord, "hash"> & { hash?: unknown };
  void _dropped;
  const jcs = canonicalize(preimage);
  if (typeof jcs !== "string") throw new Error("ledger.hashRecord: record has no JSON representation");
  return createHash("sha256").update(jcs, "utf8").digest("hex");
}
