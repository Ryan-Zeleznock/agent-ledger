# anchor
**Job:** Record the chain head daily somewhere hard to edit
**Depends on:** types only (it receives the head hash; it never reads the ledger itself)
**Does NOT:** store records
**Spec:** docs/spec.md §4

Status: implemented

Implemented 2026-09-30 (Fable, branch `slice-1a-ledger`) for LOCAL MODE and hardened after Astra's reviews the same day
(round 1 #11, #12; round 3: timestamp parity with the ledger). `createAnchor("s3", …)` still throws `not implemented`
(later: S3 Object Lock, server mode).
Files: `file.ts`, `contract.ts`. Tests: `test/anchor.test.ts`.

## Behaviour

- **`write({hash, at})`** validates the entry BEFORE anything is queued: `hash` is 64 lowercase hex characters (a
  ledger head) or `"0"` (an empty chain), `at` is RFC 3339 **with an explicit offset** (`Z` or `±hh:mm`) naming a real
  calendar day, with at most 3 fractional digits and no `:60` (`"0"`, `2026-09-30T00:00:00`, February 30, leap seconds
  and sub-millisecond fractions are refused; the ledger README "Timestamps" says why), and no other field is allowed. Then, under the
  lock, it checks the existing file's framing and last entry: a file that does not end with `\n`, or whose last line
  is not a valid entry, makes the write **reject without changing a byte** (Astra #11: a torn write is preserved for
  recovery, never joined into a new line and hidden). Only then does it append ONE line, the entry's RFC 8785 form plus
  `\n`, on a descriptor opened with `a` (`O_APPEND`), continuing short writes, failing on zero progress, then `fsync`.
- **`latest()`** returns the last complete line, parsed and re-validated, or `null` when the file is missing or empty;
  a torn or invalid last line makes it throw.
- **Append-only:** the API has exactly `write` and `latest` (tested against the prototype). Anchoring the same head
  twice adds a second line on purpose: the anchor is a time series of "at time T the head was H".

## Concurrency

In-process promise queue plus the same exclusive lock file as the ledger: `<path>.lock`, `wx` (`O_CREAT|O_EXCL`),
bounded by `AGENT_LEDGER_LOCK_TIMEOUT_MS` (default 5000) on a monotonic clock, **never reclaimed automatically**
(a leftover lock fails closed with instructions; the holder is described via an `O_NOFOLLOW|O_NONBLOCK` bounded read).
The lock, not the single write, is the interleaving guarantee (a logical line can take more than one `write(2)` on
a short write). Limits: NFS unsupported (Linux documents `O_APPEND`/`O_EXCL` as unreliable there); macOS `fsync`
does not force the drive cache (`F_FULLFSYNC` not exposed by Node). Sources: ledger README "Due diligence" [V].
The anchor may not import the ledger module (only `pipeline/` imports across modules), so the lock and timestamp
helpers are duplicated here on purpose. Tested across real processes (`test/anchor-multiprocess.test.ts`): 4 writers ×
25 entries → 100 complete lines; and a contention proof: while A holds `<path>.lock`, B–D report it held by A's pid and
write nothing; after release all 30 entries land.

## Trust boundary and what this anchor proves

"Hard to edit" is relative in local mode: the anchor file sits on the same machine as the ledger, so the machine's
user can rewrite both consistently (spec §3, ADR-007). Its value is that hiding a change now requires editing two
files consistently, and that the anchor can be copied off-machine (git, e-mail, S3) by a cron job. **`verify()` on the
ledger never compares against the anchor**; the caller must check that an anchored head appears in the verified
chain (ledger README "What verify() cannot see"; test in `test/ledger-jsonl.test.ts`). Records after the last anchor
are unprotected until the next one. Server mode replaces the file with S3 Object Lock (WORM), where audit-grade claims start.
[H] A daily anchor copied to a second location is enough for the SOC 2 CC7.2 evidence story: to be tested in the Gate 1/2 calls.


Security round C7/C8 (2026-10-05): data opens use `O_NOFOLLOW | O_NONBLOCK`, reject non-regular
files on the opened descriptor, and use that same descriptor for validation and append. New files
use mode 0600. `latest` reads at most 4098 tail bytes, accepts at most a 4096-byte line and decodes
UTF-8 fatally; it no longer loads the complete anchor history. Oversized or damaged tails fail closed.
The CLI owns ADR-018 chain membership checks because the anchor API receives no ledger. Tests:
`C7: anchor refuses symlink reads and writes without touching the target`, the descriptor-replacement
case, and `C8: ledger line and anchor tail reads are bounded` (`test/core-security.test.ts`).
