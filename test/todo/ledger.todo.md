# ledger: tests to write after Gate 2
- [ ] editing any one record makes verify() fail at that record
- [ ] key order doesn't change the hash
- [ ] two concurrent appends never share a prevHash
- [ ] secrets nested in objects or arrays are redacted
- [ ] a JSONL chain verifies after a restart
