# ledger
**Job:** Redact, hash-chain, append, verify records
**Depends on:** types; `canonicalize` (RFC 8785 JSON Canonicalization Scheme, exact-pinned) for the bytes that get hashed
**Hash:** `hash = SHA-256(JCS(record without hash))`, lowercase hex; `prevHash` = previous record's `hash`, `parentRecordId` = its `id` (genesis: `"0"` / `null`). Same construction as draft-sharif-agent-audit-trail §6.1, which also mandates JCS. Never hand-roll canonical JSON.
**Does NOT:** allow editing or deleting records
**Spec:** docs/spec.md §4, 5, 9

Status: implemented

Implemented 2026-09-30 (Fable, branch `slice-1a-ledger`) for LOCAL MODE, then hardened after Astra's cross-review
(`docs/reviews/2026-09-30-astra-ledger-review.md`, 13 findings), re-review (`…-astra-ledger-rereview.md`, 9 findings) and
round 3 (`…-astra-ledger-round3.md`, 4 defects); see "Review resolutions" for all rounds.

**Design note: redaction is best-effort defence in depth, never the only secret control.** Pattern matching cannot
prove the absence of a secret. The ledger's actual controls are: credentials never enter a `ToolCall` (explicit
projection, spec §5); every stored value passes the JSON-only boundary before AND after redaction; unknown fields in
stored records are rejected so the hash covers every stored byte; and over-redaction is the accepted failure direction.
Spec §9's "raw args are never persisted" holds for the args AFTER redaction; what redaction cannot recognise (see
"Residual") is stored, hashed and visible in the report like any other argument.
`createLedger("postgres", url)` is implemented for Slice 2a (validation status below). Files: `hash.ts`, `validate.ts`, `redact.ts`,
`jsonl.ts`, `contract.ts`. Tests: `test/ledger-hash.test.ts`, `test/ledger-validate.test.ts`, `test/ledger-redact.test.ts`,
`test/ledger-jsonl.test.ts`, `test/ledger-multiprocess.test.ts` (4 real processes), `test/timing/ledger-redact-bench.test.ts`
(supervised child); fixtures in `test/helpers/`.

## Behaviour

- **`append(unsealed)`**: `validate.projectUnsealed` rebuilds the record **field by field at every level** (`call`,
  `policy`, `approval`, `outcome`, `handoff`; scalars type-checked, enums checked, timestamps parsed), so a smuggled
  `credential`, `hash`, or any unnamed property can never reach the file. `call.args` must be **JSON data**
  (`assertJsonData`: plain objects/arrays, finite numbers, well-formed strings; no functions, accessors, `toJSON`,
  class instances, `undefined`, bigint; ≤ 64 levels, ≤ 256 KiB per string, ≤ 4 MiB of string content), then goes
  through `redact`, and the REDACTED args are validated against the same limits again (redaction can expand text;
  a record the store could not read back is never written). Duplicate `id`s are refused under the lock (an amortised id
  index reads only the bytes appended since its last refresh). Sealing adds `parentRecordId`, `prevHash`, `writtenAt`
  (ledger clock, ISO 8601 UTC, milliseconds) and `hash`, and writes one line: the record's JCS form plus `\n`.
  Rejections leave the file untouched. Getters are never invoked anywhere: `snapshotJsonData` (args) and the contract
  object snapshot (record, call, policy, approval, outcome, handoff) read every value once through its property
  descriptor and reject accessors, holes, Proxies and class instances, so the values validated are the values sealed.
  Right before writing, the sealed record is serialised, pushed through the SAME strict read path (`parseStored`) and
  re-hashed; only a line that `verify()` will accept is written.
- **`head()`** is the hash of the last stored record (re-read and self-hash-checked every call), or `"0"` for an empty
  or missing file: the value the next record's `prevHash` takes and the value to hand to `anchor`.
- **`verify()`** streams the file and stops at the first line that fails any of: parses as JSON; passes
  `projectStored` (STRICT: an unknown field at any level of record/call/policy/approval/outcome/handoff is a broken
  record, so an injected field can never be dropped before re-hashing; RFC 3339 `writtenAt`, 64-hex `hash`,
  genesis-consistent `prevHash`/`parentRecordId`); **is byte-for-byte the RFC 8785 serialisation of that record**
  (round 3: one rule that rejects duplicate member names, which `JSON.parse` would silently collapse, as well as
  whitespace, reordering and escape variants, so the bytes on disk are exactly the bytes the hash covers);
  unique `id`; `prevHash` = previous hash; `parentRecordId` = previous id; recomputed hash = stored hash (a
  canonicalisation failure such as `1e400` is a broken record, not an exception). Blank lines and a final line without
  `\n` are broken too. `brokenAt` is the record's `id`, or `line:<n>`; `checked` counts records up to and including it.
- **Timestamps** (`writtenAt`, `receivedAt`, `decidedAt`, ranges, anchor `at`): RFC 3339 with an EXPLICIT offset, a real
  calendar day, and at most 3 fractional digits. Refused on purpose: timezone-free strings (`Date.parse` reads them in
  the host zone, ECMA-262 §21.4.3.2); `:60` (ECMAScript time values have no leap-second representation, ECMA-262
  §21.4.1.1, so accepting one would silently shift it onto :59); more than 3 fractional digits (they cannot be kept
  exactly in epoch milliseconds, so `.000000001Z` and `.000Z` would compare equal). Our clock writes exactly 3.
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
   `accesskey`, `secretkey`, `clientsecret`, `authorization`, `credential(s)`, `cookie`, `setcookie`, equals `pwd`,
   `pass`, `auth`, `bearer`, `key`, `ssn`, `otp`, `pin`, or **contains** `password|passwd|passphrase|secret|token|
   apikey|privatekey|accesskey|authorization|credential|cookie` anywhere (`db_password_value`, `api_key_value`,
   `tokens_list`), the WHOLE value becomes `[REDACTED:key:<keyword>]`, where `<keyword>` is the matched word from
   **our** list: the caller's key is never copied into a placeholder. A key that itself carries a secret or PII shape
   (a token, an e-mail) is renamed `[REDACTED:key#n]`, collision-safe within the object.
2. **Structure layer.** argv: a flag whose bare name is sensitive (`--password`, `--token`, `--secret`, `--auth`, `-p`,
   `-u`, `--key`, `--db-token`, …) makes the NEXT element `[REDACTED:pair]`, even if it starts with `-`; a `--flag=value`
   carries its own value and is redacted as an assignment. `["Authorization", "Bearer", "x"]` and `["X-Api-Key", "x"]`
   → `[REDACTED:pair]` (scheme word kept); header objects `{name|key|header|field: "Cookie", value: "x"}` → `value` redacted.
3. **Value layer.** A string that parses as a JSON object/array (≤ 64 KiB, and only within the remaining depth budget,
   measured iteratively) is redacted **structurally** and re-serialised. Every other string goes through a
   **linear, recursion-free tokeniser** (whitespace, words, placeholders, punctuation including quotes; `,` and `&`
   are word characters) and **format-aware rules** (round 3):
   - **Sensitive assignments** `NAME=VALUE`, `NAME:VALUE`, `NAME: VALUE`, `NAME = VALUE`, `"NAME": "VALUE"` (NAME
     sensitive by the key-layer rule): a quoted value is redacted to its closing quote (backslash escapes honoured,
     unterminated = to the end, quotes kept so JSON stays JSON); an **unquoted value is redacted to the end of the
     line**, or to the closing quote of the enclosing quoted context (`-H "Authorization: Bearer x" https://…` keeps
     the URL). That single boundary covers `Authorization: <any scheme> <credential>` (the scheme goes too),
     `Cookie: a=b; c=d` and `Set-Cookie` (every cookie), `PASSWORD=alpha,beta`, `PASS=x`, `?pwd=x`, and
     `export TOKEN=x && echo done` (the tail is lost: accepted over-redaction).
   - **CLI flags** in text: `--password a,b`, `--password -x`, `--auth x`, `-p x`, `--token=x`: the next argument
     (one word or one quoted span), even if it starts with `-`.
   - **URLs** anywhere in a word, also after `DATABASE_URL=`: userinfo replaced entirely (`user:alpha,beta@` →
     `[REDACTED:url-credentials]@`); each sensitive query parameter (`api_key`, `pwd`, `token`, …) redacted up to the
     next `&` or `#`, other parameters kept.
   - **Prose** auth schemes `bearer|basic|digest|negotiate` (case-insensitive) → the following value; vendor shapes
     (JWT, AWS access key ids, GitHub, Stripe, `sk-`/`sk-ant-`, Slack, Google; glued suffixes still match); e-mail
     (hand-rolled, linear); words that are percent-, base64/base64url- (≥ 8 chars) or hex-encoded (≥ 8 chars) text whose
     **decoded** form carries a secret → `[REDACTED:encoded]`, with EXACTLY one level of decoding.
   - **Words longer than 1 KiB are replaced whole** (`[REDACTED:long-word]`), wherever they appear: fail safe rather
     than leave a long word unscanned.
   - On the whole string only linear scans run: PEM private-key blocks (indexOf-based, every search starts where the
     last stopped, a missing footer is remembered) and bounded-quantifier regexes for US SSNs and Luhn-valid card numbers.
   **ADR-009 digests pass through the key layer** (2026-09-30): a value that is exactly `hmac-sha256:<64 hex>` is what
   the pipeline stores for a non-allowlisted argument; the key layer keeps it even under a sensitive field name so the
   evidence stays verifiable with the key. Nothing else is exempt (a partial or padded token is redacted as before). Placeholder-shaped values under sensitive keys or header-pair values are replaced by the deterministic key/pair placeholder (Slice 1c pin 10; array-pair extension, review #3, 2026-10-03). Exact lowercase digests survive object and array pairs; recognized auth-scheme tokens still frame header triples. The value scanner still preserves its own placeholders.
   `test/ledger-redact.test.ts` holds one parameterised table with all of Astra's round-3 shapes (headers, cookies, env
   lines, JSON keys, URLs, CLI flags), each checked in a string, an array and a nested object, and for idempotency.

Performance (Astra #6, re-review P1): no unanchored keyword regex over the whole string, no `Array#includes` per
renamed key, no PEM rescans, no recursion on quotes. Measured on the compiled build, 2026-09-30, Apple silicon:
benign 80 KB **1.6 ms** (Astra's baseline for round 0: 2,429 ms); 160 KB of words 17 ms, alternating quotes 6 ms,
`-----BEGIN ` runs 14 ms, 2 KiB words 1.6 ms, `password="a b"` runs 4 ms; an object with **80,000 e-mail keys 137 ms**
(Astra's round-1 measurement: 4,331 ms; 10k/20k/40k/80k = 21/31/63/137 ms, linear). `test/timing/ledger-redact-bench.test.ts`
runs 16 shapes × 10–160 KB in a forked child under a 20 s hard deadline and enforces < 1 s at 160 KB and < 8× growth
from 40 KB to 160 KB.

**Residual (Astra #4; spec §7 should list it, spec is frozen so it is recorded here):** arbitrary or nested encodings
(only ONE decode level is applied: `password%253Dhunter2` stays), splitting a secret across unrelated fields or
messages, secrets in binary blobs, and secret-bearing text that matches none of the shapes above cannot be defeated by
pattern matching. Redaction reduces exposure; it is not a guarantee of secrecy (see the design note at the top). Also
not redacted on purpose: phone numbers, street addresses, person names, generic high-entropy strings shorter than 1 KiB.
Over-redaction is the accepted failure direction, and round 3 widened it on purpose: a key or name that merely
CONTAINS a sensitive word (`tokens_list`, `authorization_url`, `secretary`), the rest of a line after an unquoted
sensitive assignment (`TOKEN=x && echo done` loses `&& echo done`), the argument after `-p`/`-u`/`--key`, and any word
over 1 KiB (a long path, a data URI). Strings over 256 KiB, or records whose redacted args exceed the limits, are rejected before
anything is written.

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
one genesis, chain verifies after reopen, no lock left behind); and a **contention proof**: process A takes the lock
(the store's own `wx` protocol) and holds it while B–D try to append with a 400 ms timeout: each reports the lock as
held by A's pid, appends nothing, and leaves A's lock alone; after A releases, all 60 appends land and verify.
The anchor has the same two tests (`test/anchor-multiprocess.test.ts`).

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

Re-review (Astra, 2026-09-30, round 2: `docs/reviews/2026-09-30-astra-ledger-rereview.md`):

| Finding | Resolution |
|---|---|
| P1 schemes inside assignment values; tokens after 1 KiB words (also keys); long URL userinfo | `authorization:bearer X` handled; words > 1 KiB replaced whole, everywhere |
| P1 quadratic: 80k e-mail keys 4.3 s (`keys.includes`); repeated `-----BEGIN ` rescans | Set-based renaming (137 ms); monotonic PEM scan with remembered missing footer; both in the supervised benchmark |
| P1 stored modifications bypass hashing (projection dropped injected fields) | `projectStored` is strict at every level; hash covers the complete stored line; tests inject at record/policy/call |
| P1 successful append can disable later appends (redaction grew args past limits) | redacted args re-validated before writing; rejected with the file untouched |
| P2 array getters restore the toJSON leak | `snapshotJsonData`: descriptors only, getters never invoked, Proxies/holes/extra props rejected, snapshot used |
| P2 short base64/hex survive; triple-percent decoded; 10k nested arrays → RangeError | ≥ 8-char base64/base64url/hex; exactly one decode level; iterative depth check + tokeniser fallback |
| P2 `:60` accepted and shifted; sub-ms ordering; leap seconds | `:60` refused (documented); > 3 fractional digits refused; ms kept exact |
| P2 duplicate ids at append | refused under the lock via the id index; also across instances and after reopen |
| P2 4-process test did not prove contention | hold/blocked/release tests for ledger and anchor |

Round 3 (Astra, 2026-09-30: `docs/reviews/2026-09-30-astra-ledger-round3.md`):

| Defect | Resolution |
|---|---|
| duplicate JSON members in a stored line bypass verify (`JSON.parse` keeps the last) | a stored line must equal `canonicalize(record)` exactly (tail/verify/read); sealed line proven through the same path before writing |
| common formats leak (`Authorization: ApiKey x`, full Cookie, `PASSWORD=a,b`, `PASS=`, `DATABASE_URL=…u:p@`, `*_password_value`, URL userinfo/params with commas, `?pwd=`, `--password a,b`, `--password -x`, `--auth x`) | format-aware boundaries above; parameterised table |
| `outcome.durationMs` accessor: append succeeds, verify rejects | every contract object is a descriptor snapshot (accessors/Proxies rejected at any level); sealed record validated and re-hashed right before writing |
| anchor accepted `:60` and > 3 fractional digits | anchor `isInstant` matches the ledger rule; write + read regressions |

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

## Slice 2a shared chain (2026-10-03)

`chain.ts` owns sealing, strict parsing, self-hash checks and streaming verification. JSONL retains its physical
LF framing and file lock. ADR-012 `channel: none` is accepted and round-trips; the validator uses `APPROVAL_CHANNEL_KINDS` from `src/types`
(swapped in from the temporary `PIN-2A` literal at integration).
Test-first: the new no-channel regression failed against the old enum (1 failed / 1075 passed / 7 skipped).

## Postgres (Slice 2a, ADR-013)

`createLedger("postgres", url)` returns a `PostgresLedger`, with one max-4 `pg.Pool`. The concrete class exposes
`close(): Promise<void>` for shutdown; use it in the server composition root. This is a lifecycle extension on the
implementation, not a change to the frozen `LedgerStore` interface. Repeated close calls share the same promise.
The driver loads only on construction of a Postgres store, preserving the local JSONL CLI's dependency path.

`deploy/sql/001_init.sql` stores one canonical JCS line, plus indexed columns derived from it. Appends acquire the
transaction advisory lock `hashtext('agent-ledger.records')`, revalidate the tail and every redundant column, seal
with the shared chain functions, INSERT, then COMMIT on the **same connection**. Unique ids/hashes are database
constraints. Failures rollback/release the connection and expose only the operation name and run-verify instruction,
never the underlying exception, URL, SQL values or a nested cause. Statement timeout is 30 seconds; connection timeout
is 5 seconds. Idle pool errors evict connections without logging secrets; a later operation reconnects or fails.

The app role has SELECT+INSERT; reader has SELECT only. Triggers refuse UPDATE/DELETE/TRUNCATE even for the superuser
while enabled. Superusers can still disable/drop protections, rewrite/re-chain rows, or remove a complete suffix:
keep independently protected anchors on the Mac. The SQL is forward-only and idempotent for empty/populated databases;
existing role passwords are not rotated on rerun. Kubernetes mounts only the .sh initializer in initdb.d so the .sql
is never run again without its password variables. A byte-identical SQL copy under k8s/config is checked offline.

Verification uses the same `verifyLines` as JSONL and checks every indexed value against the line. The sequence cursor
is a bigint **string**, never a JS number. Both verify/read use a stable read-only repeatable-read snapshot and keyset
pages of at most 1000 rows, releasing the connection even on early iterator exit. Verification is O(n) in records,
with O(n) memory for the shared duplicate-id set; page memory depends on row size. Append reads only the tail and
uses unique indexes, with no full-history scan. Range reads validate explicit-offset millisecond timestamps and use
`written_at BETWEEN ... ORDER BY seq`. They reject a mismatching selected row, including sub-millisecond DB timestamp
changes; as with any indexed range query, an administrator moving its timestamp outside the range can hide the row
from that query. Call verify() before report reads (the report/CLI already do). `read` validates structure/canonical
bytes and columns; `verify` additionally checks the complete hash chain.

Credentials: prefer password-free URLs plus PGPASSWORD for CLI operations. If constructing a password-bearing URL,
encode the password once with `encodeURIComponent` (`@`, `%`, `:` must not become URL syntax); never print the URL.
The server reads `ledger.password` and does this insertion. New runtime dependency is **pg 8.23.1**, accepted in ADR-013
and installed by the coordinator at 6523c57; @types/pg 8.23.1 is development-only. No dependency install ran here.

Tests: `ledger-postgres.test.ts`, `ledger-chain-parity.test.ts`, `timing/ledger-postgres-process.test.ts`, harness
`helpers/pg-cluster.ts` (Homebrew Postgres 16, Unix socket, private temp directory, explicit teardown + exit fallback).
Missing initdb/pg_ctl/psql produces a visible skip; a present but broken/denied installation fails. Set
AGENT_LEDGER_PG_BIN to the directory containing the three binaries. With `AGENT_LEDGER_TEST_PG_HOST` set to an absolute
Unix socket directory, the harness instead connects as `postgres` to a coordinator-owned server. It creates a unique
`al_test_<uuid>` database per suite, applies the same init SQL, and drops only that database in teardown (including an
exit fallback); it NEVER starts, stops or reconfigures the external server. Shared ledger_app/ledger_reader roles are
created if absent and retained; their existing passwords are unchanged. Migrations serialize role creation using an
advisory transaction lock in the common `postgres` maintenance database, since database-local locks would not prevent
cross-suite role races. The test-only `agent_ledger_test` URL alias maps to the external `postgres` superuser.
Configured external-server failures are failures, never skips. The cluster image is 17.11: the Ryan-run integration
Job is still required to establish image/version parity. This sandbox denies both initdb's shmget and connections to
the supplied external socket. The coordinator verified this tree outside the sandbox on 2026-10-03 against PostgreSQL
16.13: one `npm run check` (typecheck + tests + build) and two additional `npm test` runs, all exit 0. Each run passed
1118 unit tests (7 existing skips) and 79 timing tests, including all real-Postgres cases. No test databases remained.
These are coordinator-reported results; timings were not supplied. No behavior changed after that verified run.

The no-channel regression was demonstrated failing before implementation; the earlier real-Postgres test-first
attempts were blocked at setup by the sandbox. A Postgres-specific revert-check has not been demonstrated.


Primary-source diligence, 2026-10-03:
- [V] [node-postgres transactions](https://node-postgres.com/features/transactions): use one acquired client throughout
  BEGIN/queries/COMMIT; pool.query does not provide transaction affinity.
- [V] [node-postgres connecting](https://node-postgres.com/features/connecting): supports Unix sockets, connection URIs,
  and libpq-style PGPASSWORD for both clients and pools.
- [V] [Postgres 16 locking](https://www.postgresql.org/docs/16/explicit-locking.html): transaction advisory locks release
  automatically on transaction end; pg_locks can prove a real competing writer is waiting.
- [V] [pool API](https://node-postgres.com/apis/pool): release checked-out clients; end drains the pool; listen for idle
  client errors. [H] These local tests cannot establish worker-disk durability or the deployed network boundary.

ADR-015 amendment (2026-10-05): optional `approval.approverName` is a normal bounded string in both append projection and strict read. Existing records remain valid; the additive field is covered by the record hash. Tests: `ADR-015 optional approverName` and `round-trips and hashes optional approverName alongside older approvals`.

Release compatibility (fixes-2b, ADR-015): older CLIs reject records containing `approval.approverName` as an unknown field during strict read/verification. Upgrade auditor/read-only CLIs to fixes-2b or later before reading ledgers written with names; the new CLI continues to accept older records without names.


Security round C6–C8 (2026-10-05): JSONL reads decode UTF-8 fatally, preserving BOM bytes for canonical
validation; invalid byte sequences cannot impersonate hashed U+FFFD characters. Each operation opens
with `O_NOFOLLOW | O_NONBLOCK`, rejects non-regular files with `fstat`, and uses that descriptor for
its checks and reads/writes. New ledgers use exclusive creation and mode 0600. Ancestor-directory
ownership remains part of the local trust boundary; these checks protect the final data pathname.

Stored lines are capped at 8 MiB before parsing, including tail reads and incremental ID scans.
Argument validation caps structure at 100,000 JSON nodes, includes keys in the 4 MiB aggregate
character budget even for numeric/null values, and caps individual keys at 256 KiB like strings.
The ID index remains proportional to ledger history; refreshes read bounded chunks rather than
allocating the entire appended suffix. File replacement/shrink resets that index. Shared stored-line
validation also applies the byte cap to Postgres rows. Strict reads/verification reject oversized or malformed evidence explicitly; retain the original
files for recovery. The append-only ID-recovery exception is documented below. Tests: `test/core-security.test.ts`,
`test/ledger-jsonl.test.ts`, and the existing multi-process suite. Postgres needs coordinator validation.


Verification R2, coordinator decision (2026-10-05): append availability depends on the **last physical
line**, which must be complete, within 8 MiB, valid UTF-8, canonical, shape-valid and self-hash-valid.
A damaged/torn final line refuses append without altering evidence. Earlier malformed JSON, invalid
shape/UTF-8, joined/torn records or oversized lines do not block new logging when the tail is sound.
The ID scan skips unreadable interior lines using bounded buffers, preserves recoverable bounded IDs
and continues indexing subsequent lines; known duplicate IDs remain refused. No damaged bytes are
removed or repaired. `verify()` still fails on that damage, and strict `read()` still refuses it.
Tests: `R2: earlier %s damage preserves append availability and remains detectable` and
`R2: final %s damage blocks append without changing evidence` (`test/core-security.test.ts`).

Scale consideration R5 (documented, no further optimization in this round): each fresh hook process
rebuilds its ID index by scanning the ledger and calling `parseStored` for each bounded historical line.
This performs more validation/canonicalization than the original JSON.parse-only index scan. Cost is
O(history) time per fresh process and O(recoverable IDs) index memory; a long-lived store incrementally
indexes new bytes. Repeated short-lived hooks can therefore accumulate quadratic total scan work as
history grows. A persistent collector/index needs a separate design and scale benchmark; streaming
report correlation does not remove ledger verification or ID-index costs.
