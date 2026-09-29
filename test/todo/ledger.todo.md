# ledger: tests to write after Gate 2
- [ ] editing any one record makes verify() fail at that record
- [ ] key order doesn't change the hash (hashRecord uses `canonicalize`, RFC 8785; compare against a hash computed by hand from the JCS string)
- [ ] genesis record has parentRecordId null and prevHash "0"; every later record's parentRecordId is the previous id and prevHash the previous hash
- [ ] verify() fails when parentRecordId continuity breaks even if the hashes still chain
- [ ] two concurrent appends never share a prevHash
- [ ] secrets nested in objects or arrays are redacted
- [ ] a JSONL chain verifies after a restart
