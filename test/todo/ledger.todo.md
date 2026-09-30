# ledger: tests to write

Converted to real tests on 2026-09-30 (jsonl, local mode). Each line names the test file that now holds it.
- [x] editing any one record makes verify() fail at that record → `test/ledger-jsonl.test.ts`
- [x] key order doesn't change the hash (hashRecord uses `canonicalize`, RFC 8785; compared against a hash computed by hand from the JCS string) → `test/ledger-hash.test.ts`
- [x] genesis record has parentRecordId null and prevHash "0"; every later record's parentRecordId is the previous id and prevHash the previous hash → `test/ledger-jsonl.test.ts`
- [x] verify() fails when parentRecordId continuity breaks even if the hashes still chain → `test/ledger-jsonl.test.ts`
- [x] two concurrent appends never share a prevHash → `test/ledger-jsonl.test.ts` (50 in-process; two instances) and `test/ledger-multiprocess.test.ts` (4 real processes × 100, IPC barrier)
- [x] secrets nested in objects or arrays are redacted → `test/ledger-redact.test.ts`; stored-record check in `test/ledger-jsonl.test.ts`
- [x] a JSONL chain verifies after a restart → `test/ledger-jsonl.test.ts`

Added from Astra's review (2026-09-30), all implemented:
- [x] nested projection, JSON-only boundary, strict stored-record shape, explicit-offset timestamps → `test/ledger-validate.test.ts`
- [x] quoted/JSON-in-string/scheme/placeholder/key/argv/header/encoded redaction cases → `test/ledger-redact.test.ts`
- [x] redaction time grows linearly, under a hard external deadline → `test/ledger-redact-bench.test.ts`
- [x] leftover lock fails closed and is never deleted; symlink/FIFO lock paths; tail re-read; blank lines; duplicate ids; 1e400; read() framing → `test/ledger-jsonl.test.ts`
- [x] a full re-chain passes verify(); trusted-anchor comparison catches it → `test/ledger-jsonl.test.ts`

Added from Astra's re-review (2026-09-30, round 2), all implemented:
- [x] injected stored field breaks verify/head/append; redacted-size rejection; duplicate ids under the lock → `test/ledger-jsonl.test.ts`
- [x] strict stored projection, descriptor snapshot (getters never invoked, Proxies), :60 and >3 fractional digits refused → `test/ledger-validate.test.ts`
- [x] scheme-in-value, long words (also keys/URLs), short base64/hex, one decode level, nested JSON/quotes budget, linear renaming/PEM → `test/ledger-redact.test.ts`, `test/ledger-redact-bench.test.ts`
- [x] contention proof: A holds the lock, B-D blocked (EEXIST) then land after release → `test/ledger-multiprocess.test.ts`

Still to write:
- [ ] postgres backend (Slice 2): the same chain rules over a table with an append-only role; verify() and read(range) parity with jsonl
- [ ] pipeline/report: the caller-side anchor comparison (anchored head ∈ verified chain) as a real function, once `src/report/` exists
