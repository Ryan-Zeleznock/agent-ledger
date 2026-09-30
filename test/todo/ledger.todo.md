# ledger: tests to write

Converted to real tests on 2026-09-30 (jsonl, local mode). Each line names the test file that now holds it.
- [x] editing any one record makes verify() fail at that record → `test/ledger-jsonl.test.ts`
- [x] key order doesn't change the hash (hashRecord uses `canonicalize`, RFC 8785; compared against a hash computed by hand from the JCS string) → `test/ledger-hash.test.ts`
- [x] genesis record has parentRecordId null and prevHash "0"; every later record's parentRecordId is the previous id and prevHash the previous hash → `test/ledger-jsonl.test.ts`
- [x] verify() fails when parentRecordId continuity breaks even if the hashes still chain → `test/ledger-jsonl.test.ts`
- [x] two concurrent appends never share a prevHash → `test/ledger-jsonl.test.ts` (50 in-process appends; two independent store instances on one file)
- [x] secrets nested in objects or arrays are redacted → `test/ledger-redact.test.ts`; stored-record check in `test/ledger-jsonl.test.ts`
- [x] a JSONL chain verifies after a restart → `test/ledger-jsonl.test.ts`

Still to write:
- [ ] two REAL processes appending to one JSONL file never share a prevHash (needs a child-process runner for the TS sources; the lock-file contention path is untested in-process)
- [ ] postgres backend (Slice 2): the same chain rules over a table with an append-only role; verify() and read(range) parity with jsonl
