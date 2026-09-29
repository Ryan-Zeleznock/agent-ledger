import type { DateRange, LedgerRecord, UnsealedRecord, VerifyResult } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface LedgerStore {
  append(record: UnsealedRecord): Promise<LedgerRecord>;
  verify(): Promise<VerifyResult>;
  head(): Promise<string>;
  read(range: DateRange): AsyncIterable<LedgerRecord>;
}
export function createLedger(kind: "jsonl" | "postgres", target: string): LedgerStore { throw notImplemented("ledger.createLedger"); }
export function redact(args: Record<string, unknown>): Record<string, unknown> { throw notImplemented("ledger.redact"); }
/** SHA-256 hex over canonicalize(record) (RFC 8785 JCS); `record` already carries parentRecordId and prevHash. Spec §5. */
export function hashRecord(record: Omit<LedgerRecord, "hash">): string { throw notImplemented("ledger.hashRecord"); }
