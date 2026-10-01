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

Added from Astra's round 3 (2026-09-30), all implemented:
- [x] stored line must equal its canonical JCS serialisation (duplicate members, whitespace, reordering, escapes) → `test/ledger-jsonl.test.ts`
- [x] accessors/Proxies in any contract object rejected before writing; sealed record validated through the read path → `test/ledger-jsonl.test.ts`, `test/ledger-validate.test.ts`
- [x] common-format redaction table (headers, cookies, env lines, JSON keys, URLs, CLI flags) → `test/ledger-redact.test.ts`

Still to write:
- [ ] postgres backend (Slice 2): the same chain rules over a table with an append-only role; verify() and read(range) parity with jsonl
- [ ] pipeline/report: the caller-side anchor comparison (anchored head ∈ verified chain) as a real function, once `src/report/` exists
- [x] (Astra verification P2, 2026-09-30) `redact.ts` key-layer exemption also keeps arbitrary `[REDACTED:…]` strings under sensitive keys; narrow it to exact `hmac-sha256:[0-9a-f]{64}` only, with a test that a sensitive-key value shaped like a placeholder is redacted
- [ ] (coordinator, 2026-09-30) full suite is load-sensitive: `ledger-redact-bench` and several real-process watchdog timing tests fail when another suite runs concurrently on the same machine (idle: 3/3 green). Isolate timing suites (vitest project with `fileParallelism: false`, or a separate `npm run test:timing`)

Slice 1c pin 10: `test/ledger-redact.test.ts` covers placeholder values, inexact digests, exact lowercase digests and nested-key/header-object idempotence. Test-first run: the placeholder cases failed before the key-layer fix.
