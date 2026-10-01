# anchor: tests to write

Converted to real tests on 2026-09-30 (file backend, local mode) in `test/anchor.test.ts`:
- [x] latest() returns the last write
- [x] the file anchor is append-only

Added from Astra's review (2026-09-30), implemented in `test/anchor.test.ts`:
- [x] a torn tail makes the next write reject without changing a byte; latest() reports it
- [x] `at` must carry an explicit offset and a real calendar day
- [x] a held lock file fails the write closed in bounded time and is never deleted

Added from Astra's re-review (2026-09-30, round 2), implemented in `test/anchor-multiprocess.test.ts`:
- [x] 4 real writer processes; contention proof (A holds, B-D blocked, release, all land)

Added from Astra's round 3 (2026-09-30), implemented in `test/anchor.test.ts`:
- [x] `at` rejects `:60` and more than 3 fractional digits on write; a stored entry with either makes latest()/write() refuse

Added for Slice 1c (Fable, 2026-10-01; pin 5), implemented in `test/cli.test.ts` "anchor", `test/cli-process.test.ts` and `test/e2e-slice-1c.test.ts`:
- [x] CLI `anchor` refuses broken/empty/changed: a failed chain → exit 1 `chain-failed` with no line written; the genesis head → exit 1 `empty-ledger`; a head that moves during verify → exit 1 `ledger-changed`; a torn anchor file → exit 1, nothing written, no exception text on stderr; healthy → exit 0, one canonical line (`line` equals the file's new last line), `previous` carried, the ledger byte-identical, `verify` then `head`/exit 0 and after one more record `ancestor`/exit 0; re-anchoring the same head appends another line

Still to write:
- [ ] s3 backend (later): write() puts an object under Object Lock (compliance mode) and latest() reads the newest; a second put with the same key is refused
- [ ] injected short write (needs a fault-injection seam)
