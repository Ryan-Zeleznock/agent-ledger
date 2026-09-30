# anchor
**Job:** Record the chain head daily somewhere hard to edit
**Depends on:** types only (it receives the head hash; it never reads the ledger itself)
**Does NOT:** store records
**Spec:** docs/spec.md §4

Status: implemented

Implemented 2026-09-30 (Fable, branch `slice-1a-ledger`) for LOCAL MODE: `createAnchor("file", path)`.
`createAnchor("s3", …)` still throws `not implemented` (later: S3 Object Lock, server mode). Files: `file.ts`, `contract.ts`.
Tests: `test/anchor.test.ts` (both `test/todo/anchor.todo.md` items plus reopen, validation, concurrency).

## Behaviour

- **`write({hash, at})`** validates the entry BEFORE anything is queued: `hash` must be 64 lowercase hex characters
  (a ledger head) or `"0"` (the head of a still-empty chain), `at` must parse as a date, and no other field is
  allowed. Then it appends ONE line, the entry's RFC 8785 form (`{"at":…,"hash":…}`) plus `\n`, with a single
  `write(2)` on a descriptor opened with the `a` flag (`O_APPEND`) followed by `fsync`. Parent directories are created.
- **`latest()`** returns the last complete line, parsed and re-validated, or `null` when the file is missing or empty.
  A final line without `\n`, non-JSON, or an invalid entry makes it throw instead of guessing.
- **Append-only:** the API has exactly `write` and `latest` (tested against the prototype). Nothing truncates or rewrites.
  Anchoring the same head twice adds a second line, on purpose: the anchor is a time series of "at time T the head was H".

## Concurrency

Writes are serialised in-process (promise queue). Across processes there is no lock file: each write is one
`O_APPEND` write, so lines never overwrite each other, and the ORDER of two anchors written in the same instant is
not meaningful (each carries its own `at`). Limits: NFS is unsupported (Linux documents `O_APPEND` as unreliable
there) and `fsync` on macOS does not force the drive cache (`F_FULLFSYNC`, not exposed by Node). See the ledger
README "Due diligence" for the [V] sources; the same facts apply here.

## Trust boundary

"Hard to edit" is relative in local mode: the anchor file sits on the same machine as the ledger, so the machine's
user can rewrite both (spec §3, ADR-007). Its value is that the ledger and the anchor must be changed
CONSISTENTLY to hide tampering, and that the anchor can be copied off-machine (e-mail, git, S3) by a cron job.
Server mode replaces it with S3 Object Lock (WORM), which is where audit-grade claims start.
[H] A daily anchor copied to a second location is enough for the SOC 2 CC7.2 evidence story: to be tested in the Gate 1/2 calls.
