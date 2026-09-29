# ledger
**Job:** Redact, hash-chain, append, verify records
**Depends on:** types; `canonicalize` (RFC 8785 JSON Canonicalization Scheme, exact-pinned) for the bytes that get hashed
**Hash:** `hash = SHA-256(JCS(record without hash))`, lowercase hex; `prevHash` = previous record's `hash`, `parentRecordId` = its `id` (genesis: `"0"` / `null`). Same construction as draft-sharif-agent-audit-trail §6.1, which also mandates JCS. Never hand-roll canonical JSON.
**Does NOT:** allow editing or deleting records
**Spec:** docs/spec.md §4, 5, 9
