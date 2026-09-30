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

Still to write:
- [ ] s3 backend (later): write() puts an object under Object Lock (compliance mode) and latest() reads the newest; a second put with the same key is refused
- [ ] injected short write (needs a fault-injection seam)
