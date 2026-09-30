# anchor: tests to write

Converted to real tests on 2026-09-30 (file backend, local mode) in `test/anchor.test.ts`:
- [x] latest() returns the last write
- [x] the file anchor is append-only

Still to write:
- [ ] s3 backend (later): write() puts an object under Object Lock (compliance mode) and latest() reads the newest; a second put with the same key is refused
