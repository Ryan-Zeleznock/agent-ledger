# ledger
**Job:** Redact, hash-chain, append, verify records
**Depends on:** types; `canonicalize` (RFC 8785 JSON Canonicalization Scheme, exact-pinned) for the bytes that get hashed
**Hash:** `hash = SHA-256(JCS(record without hash))`, lowercase hex; `prevHash` = previous record's `hash`, `parentRecordId` = its `id` (genesis: `"0"` / `null`). Same construction as draft-sharif-agent-audit-trail §6.1, which also mandates JCS. Never hand-roll canonical JSON.
**Does NOT:** allow editing or deleting records
**Spec:** docs/spec.md §4, 5, 9

Status: implemented

Implemented 2026-09-30 (Fable, branch `slice-1a-ledger`) for LOCAL MODE, then hardened after Astra's cross-review the same
day (`docs/reviews/2026-09-30-astra-ledger-review.md`, 13 findings, all addressed; see "Review resolutions").
`createLedger("postgres", …)` still throws `not implemented` (Slice 2). Files: `hash.ts`, `validate.ts`, `redact.ts`,
`jsonl.ts`, `contract.ts`. Tests: `test/ledger-hash.test.ts`, `test/ledger-validate.test.ts`, `test/ledger-redact.test.ts`,
`test/ledger-jsonl.test.ts`, `test/ledger-multiprocess.test.ts` (4 real processes), `test/ledger-redact-bench.test.ts`
(supervised child); fixtures in `test/helpers/`.

## Behaviour

- **`append(unsealed)`**: `validate.projectUnsealed` rebuilds the record **field by field at every level** (`call`,
  `policy`, `approval`, `outcome`, `handoff`; scalars type-checked, enums checked, timestamps parsed), so a smuggled
  `credential`, `hash`, or any unnamed property can never reach the file. `call.args` must be **JSON data**
  (`assertJsonData`: plain objects/arrays, finite numbers, well-formed strings; no functions, accessors, `toJSON`,
  class instances, `undefined`, bigint; ≤ 64 levels, ≤ 256 KiB per string, ≤ 4 MiB of string content), then goes
  through `redact`. Sealing adds `parentRecordId`, `prevHash`, `writtenAt` (ledger clock, ISO 8601 UTC) and `hash`, and
  writes one line: the record's JCS form plus `\n`. Rejections leave the file untouched.
- **`head()`** is the hash of the last stored record (re-read and self-hash-checked every call), or `"0"` for an empty
  or missing file: the value the next record's `prevHash` takes and the value to hand to `anchor`.
- **`verify()`** streams the file and stops at the first line that fails any of: parses as JSON; passes
  `projectStored` (full shape, RFC 3339 `writtenAt`, 64-hex `hash`, genesis-consistent `prevHash`/`parentRecordId`);
  unique `id`; `prevHash` = previous hash; `parentRecordId` = previous id; recomputed hash = stored hash (a
  canonicalisation failure such as `1e400` is a broken record, not an exception). Blank lines and a final line without
  `\n` are broken too. `brokenAt` is the record's `id`, or `line:<n>`; `checked` counts records up to and including it.
- **`read(range)`** requires `from`/`to` as RFC 3339 with an explicit offset, refuses an unframed file, throws on any
  invalid line or timestamp (a report must fail, never silently skip), and yields records with `writtenAt` in
  `[from, to]` (inclusive, compared as instants), in file order.
- **Fail-closed tail (confirmed by Astra):** if the file ends in an incomplete or invalid line, `append` and `head`
  refuse ("run verify()") rather than chain onto damage; nothing is ever auto-truncated. Per spec §7 the pipeline
  then blocks write/risky/unreviewed calls and buffers reads. Recovery is a manual, recorded step: keep the damaged
  original, verify the complete prefix, compare with the trusted anchor, then resume.

## What verify() cannot see (residual limit, Astra #13)

`verify()` checks **internal consistency only**. Whoever can write the file can edit any record and recompute every
later `prevHash`, `parentRecordId` and `hash`; that re-chained file passes `verify()` (test: "a FULL re-chain …
passes verify()"). Tamper evidence therefore rests on the **anchor**: the caller (report/pipeline) must check that an
independently protected anchored head appears in the verified chain, and records written after the last anchor are
not yet protected at all. A same-machine anchor file can be rewritten consistently with the ledger (spec §3 local-mode
trust boundary); copy it off-machine, or use server mode (S3 Object Lock). `verify()` performs no anchor comparison.

## Redaction (spec §9)

`redact(args)` validates the JSON-only boundary, then returns a new object (input never mutated); it is idempotent.
Placeholders are `[REDACTED:<kind>]` and count only when they are the **complete** value (`[REDACTED:x]hunter2` is
still a secret). Layers, at every nesting level:

1. **Key layer.** The field name is NFKC-normalised (fullwidth `ｐａｓｓｗｏｒｄ` → `password`), lowercased,
   separators removed. If it ends with `password`, `passwd`, `passphrase`, `secret`, `token`, `apikey`, `privatekey`,
   `accesskey`, `secretkey`, `clientsecret`, `authorization`, `credential(s)`, `cookie`, `setcookie`, or equals `pwd`,
   `pass`, `auth`, `bearer`, `key`, `ssn`, `otp`, `pin`, the WHOLE value becomes `[REDACTED:key:<keyword>]`, where
   `<keyword>` is the matched word from **our** list: the caller's key is never copied into a placeholder. A key that
   itself carries a secret or PII shape (a token, an e-mail) is renamed `[REDACTED:key#n]`, collision-safe within the object.
2. **Structure layer.** argv pairs `["--password", "x"]` → `[REDACTED:argv]`; `["Authorization", "Bearer", "x"]` and
   `["X-Api-Key", "x"]` → `[REDACTED:pair]` (scheme word kept); header objects `{name|key|header|field: "Authorization",
   value: "x"}` → `value` redacted.
3. **Value layer.** A string that parses as a JSON object/array (≤ 64 KiB) is redacted **structurally** and
   re-serialised. Every other string goes through a **linear tokeniser** (whitespace, words, quoted spans with
   backslash escapes, placeholders, punctuation) and token rules: assignments `name=value`, `name: value`,
   `"name": "value"`, `name = value`, `--flag value` whose name contains `password|passwd|passphrase|secret|token|
   apikey|privatekey|accesskey|authorization|credential|cookie` (value may be quoted, multi-word, comma-separated,
   escaped, or unterminated → `[REDACTED:assignment]`, quotes kept so JSON stays JSON); auth schemes `bearer|basic|
   digest|negotiate` (case-insensitive) → the following credential; URL userinfo (`scheme://user:pass@` →
   `[REDACTED:url-credentials]`) and secret query parameters; vendor shapes on words ≤ 1 KiB (JWT, AWS access key ids,
   GitHub, Stripe, `sk-`/`sk-ant-`, Slack, Google; glued suffixes still match); e-mail (hand-rolled, linear); words that
   are percent-, base64- or hex-encoded text whose **decoded** form carries a secret → `[REDACTED:encoded]` (one level
   of decoding). On the whole string, only bounded-quantifier regexes run: PEM private-key blocks (indexOf-based),
   US SSNs, Luhn-valid 13–19-digit card numbers.

Performance (Astra #6): no unanchored `[...]*keyword` regex over the whole string. Measured on the compiled build,
2026-09-30, Apple silicon: benign 80 KB **1.5 ms** (Astra's baseline for the old code: 2,429 ms); 160 KB of
words 16 ms, quotes 12 ms, `eyJ` runs 1.6 ms, `password="a b"` runs 3.4 ms. `test/ledger-redact-bench.test.ts`
enforces < 1 s at 160 KB and < 8× growth from 40 KB to 160 KB under a 20 s hard deadline in a forked child.

**Residual (Astra #4; spec §7 should list it, spec is frozen so it is recorded here):** arbitrary encodings, splitting
a secret across unrelated fields or messages, secrets in binary blobs, and encodings nested more than one level cannot
be defeated by pattern matching. Redaction reduces exposure; it is not a guarantee of secrecy. Also not redacted on
purpose: phone numbers, street addresses, person names, generic high-entropy strings. Over-redaction (`tokens: 42` in
prose, `authorization_url`) is the accepted failure direction. Keys are structure and are renamed, not scanned into
placeholders. Strings over 256 KiB are rejected, not partially redacted.

## Concurrency design (JSONL)

Goal: two appends never share a `prevHash`, in one process and across processes on one machine.

1. **In-process:** a promise queue (mutex) runs `append`/`head` one at a time, in call order.
2. **Cross-process:** an exclusive **lock file** `<path>.lock`, created with Node's `wx` flag (`O_CREAT|O_EXCL`),
   containing `<pid> <iso-time>` for humans. Waiters retry every 5–10 ms until `AGENT_LEDGER_LOCK_TIMEOUT_MS`
   (default 5000, integer 1–600000) measured on a monotonic clock and checked on every iteration; then `append`
   rejects with the holder's description (read with `O_NOFOLLOW|O_NONBLOCK`, ≤ 256 bytes, regular files only, so a
   symlink or FIFO planted at the lock path is reported, never followed or blocked on).
   **No automatic stale-lock reclaim** (Astra #7): every unlink-by-pathname races with a fresh holder and can fork
   the chain, so a lock that outlives its process fails closed with the message "stale lock … remove the lock file
   manually". Release unlinks only after our own successful `wx` create.
3. **Inside the lock** the store always **re-reads, validates and self-hash-checks the last record** (no size-based
   cache: a same-size replacement is seen), so another process's record becomes the parent of ours. Then it writes
   the whole line with ONE `write(2)` on a descriptor opened with `a` (`O_APPEND`), fsyncs, and releases.

Tested: 50 concurrent in-process appends; two store instances on one file; **four real processes × 100 appends**
released together by an IPC barrier (`test/ledger-multiprocess.test.ts`: 400 records, unique ids/prevHash/parents,
one genesis, chain verifies after reopen, no lock left behind).

Limits (documented, not hidden):
- **A lock file whose holder died stays until an operator removes it**; until then every append fails closed. A
  lock file holding a live or reused pid is not special: it is simply held. There is no age-based expiry (Astra #8).
- **NFS / network file systems are unsupported:** Linux documents both `O_APPEND` and `O_EXCL` as unreliable there [V].
- **Short writes:** a partial `write(2)` (disk full) is continued; a zero-progress write is an error. A logical line
  can then take more than one write; the lock, not the single write, is the interleaving guarantee.
- **Durability:** `fsync` hands data to the drive; on macOS the drive's cache may still lose it on power failure
  unless `F_FULLFSYNC` is used, which Node does not expose [V]. Local mode is visibility, not audit-grade (spec §3, ADR-007).
- **Trust boundary:** the user of the laptop can edit or delete the file; the chain + an off-machine anchor make that visible, not impossible.

## Review resolutions (Astra, 2026-09-30)

| # | Finding | Resolution |
|---|---|---|
| 1 | nested policy/approval/outcome/handoff copied wholesale | `validate.ts` projections, field by field, scalars typed |
| 2 | quoted / JSON-in-string / lowercase scheme / placeholder-prefix bypasses | tokeniser + JSON-in-string + complete-placeholder rule |
| 3 | secrets in keys persisted or copied into placeholders | keys renamed `[REDACTED:key#n]`, placeholders carry our keyword only |
| 4 | encoded / split representations | argv pairs, header triples/objects, NFKC keys, percent/base64/hex decoding; rest documented above |
| 5 | `toJSON` / accessors after redaction | `assertJsonData` JSON-only boundary before redaction |
| 6 | quadratic regex, 2.4 s at 80 KB | linear scanner, limits; 1.5 ms at 80 KB; supervised benchmark |
| 7 | stale-lock reclaim/release deletes a live lock | automatic reclaim removed; fail closed with instructions; 4-process test |
| 8 | timeout not enforced on every path; unsafe lock inspection; pid note | monotonic deadline every iteration; O_NOFOLLOW/O_NONBLOCK bounded read; README corrected |
| 9 | weak tail/record validation; same-size cache | `projectStored` everywhere; unique ids; blank lines; canonicalisation failures; tail re-read under lock |
| 10 | read() yields unframed tails, drops bad timestamps | framing check; strict timestamps; throws |
| 11 | anchor conceals torn writes; zero-progress writes | see `src/anchor/README.md` |
| 12 | timezone-free / impossible dates | `parseInstant`: RFC 3339 with explicit offset, real calendar |
| 13 | README overstated forgery detection | "What verify() cannot see" + residual-limit test with anchor comparison |

## Due diligence (2026-09-30, primary sources)

- [V] Node `fs` flags: `'a'` "Open file for appending. The file is created if it does not exist."; `'wx'` "Like `'w'` but
  fails if the path exists." `fs.fsync`: "Request that all data for the open file descriptor is flushed to the storage
  device. The specific implementation is operating system and device specific." No `flock`/`lockf`/advisory-lock API
  exists in the module (grep of `doc/api/fs.md`, nodejs/node main). `fs.writeSync` returns "The number of bytes written".
- [V] POSIX `open()`: "If O_CREAT and O_EXCL are set, open() shall fail if the file exists. The check for the existence
  of the file and the creation of the file if it does not exist shall be atomic…" (pubs.opengroup.org, 9699919799).
- [V] POSIX `write()`: with `O_APPEND` "the file offset shall be set to the end of the file prior to each write and no
  intervening file modification operation shall occur between changing the file offset and the write operation."
  Interleaving-freedom is promised only for pipes (`PIPE_BUF`), not regular files, hence the lock file.
- [V] Linux `open(2)`: "O_APPEND may lead to corrupted files on NFS filesystems if more than one process appends data
  to a file at once"; "On NFS, O_EXCL is supported only when using NFSv3 or later on kernel 2.6 or later."
- [V] macOS `fsync(2)`: "fsync() will flush all data from the host to the drive… the drive itself may not physically
  write the data to the platters for quite some time"; `F_FULLFSYNC` is the fcntl that asks the drive to flush.
- [V] RFC 8785: property names sorted as "arrays of UTF-16 code units… pure value comparisons" (§3.2.3); numbers per
  ECMA-262 and "occurrences of NaN or Infinity MUST cause a compliant JCS implementation to terminate with an
  appropriate error" (§3.2.2.3); "Whitespace between JSON tokens MUST NOT be emitted" (§3.2.1). No Unicode normalisation
  is performed (test: NFC and NFD inputs hash differently).
- [V] `canonicalize` 5.1.0 (`lib/canonicalize.js`, read): `Object.keys(value).sort()` (UTF-16 code unit order), drops
  `undefined`/function/symbol members like `JSON.stringify`, `null` for them inside arrays, unwraps `toJSON` (which is
  why the JSON-only boundary rejects `toJSON` before hashing), throws on NaN, Infinity, lone surrogates and cycles.
- [V] ECMA-262 §21.4.3.2 `Date.parse`: date-only forms are UTC, date-time forms without an offset are LOCAL time, so
  timezone-free strings are refused (Astra #12 reproduced the TZ-dependent range bug).
- [H] A single `write(2)` of one JSONL line on a local APFS/ext4 file opened `O_APPEND` is not interleaved with another
  process's write in practice; POSIX does not promise it, and the lock file is the actual guarantee.
- [H] The `wx` lock file behaves the same on Windows (`O_EXCL` maps to `CREATE_NEW`); not tested here.
