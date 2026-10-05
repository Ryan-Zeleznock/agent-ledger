// Bound retained evidence, not ledger lifetime. History scans pay only the per-record check.
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;
export const MAX_REPORT_RECORD_BYTES = 8 * 1024 * 1024;
export function checkEvidenceRecord(record: unknown): void {
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_REPORT_RECORD_BYTES) throw new Error("Evidence record byte limit exceeded");
}
/** Conservative serialized-size accounting with an allowance for small-object/map overhead. */
export function evidenceBudget() {
  let bytes = 0;
  return {
    add(value: unknown): number {
      const size = Math.max(512, Buffer.byteLength(JSON.stringify(value), "utf8"));
      bytes += size;
      if (bytes > MAX_REPORT_BYTES) throw new Error("Selected evidence byte limit exceeded; choose a narrower report range");
      return size;
    },
    release(size: number): void { bytes -= size; },
  };
}
export function evidenceMap<K, V>(budget: ReturnType<typeof evidenceBudget>) {
  const entries = new Map<K, { value: V; size: number }>();
  return {
    get: (key: K) => entries.get(key)?.value,
    has: (key: K) => entries.has(key),
    set(key: K, value: V) {
      const old = entries.get(key); if (old) budget.release(old.size);
      const size = budget.add([key, value]);
      entries.set(key, { value, size });
    },
  };
}
