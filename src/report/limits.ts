import type { LedgerRecord } from "../types/index.js";

// Reports materialize history and several output formats; refuse oversized evidence before rendering.
export const MAX_REPORT_RECORDS = 10_000;
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;
export function evidenceBudget(): (record: LedgerRecord) => void {
  let count = 0, bytes = 0;
  return record => {
    if (++count > MAX_REPORT_RECORDS) throw new Error("Evidence record limit exceeded");
    bytes += Buffer.byteLength(JSON.stringify(record), "utf8");
    if (bytes > MAX_REPORT_BYTES) throw new Error("Evidence byte limit exceeded");
  };
}
