# ledger
**Job:** Redact, hash-chain, append, verify records
**Depends on:** types; `canonicalize` (RFC 8785 JSON Canonicalization Scheme, exact-pinned) for the bytes that get hashed
**Hash:** `hash = SHA-256(JCS(record without hash))`, lowercase hex; `prevHash` = previous record's `hash`, `parentRecordId` = its `id` (genesis: `"0"` / `null`). Same construction as draft-sharif-agent-audit-trail §6.1, which also mandates JCS. Never hand-roll canonical JSON.
**Does NOT:** allow editing or deleting records
**Spec:** docs/spec.md §4, 5, 9

Status: implemented

Implemented 2026-09-30 (Fable, branch `slice-1a-ledger`) for LOCAL MODE: `hashRecord`, `redact`, `createLedger("jsonl", path)`.
`createLedger("postgres", …)` still throws `not implemented` (Slice 2). Files: `hash.ts`, `redact.ts`, `jsonl.ts`, `contract.ts`.
Tests: `test/ledger-hash.test.ts`, `test/ledger-redact.test.ts`, `test/ledger-jsonl.test.ts` (fixtures in `test/helpers/ledger-fixtures.ts`).

## Behaviour

- **`append(unsealed)`** builds the stored record by **explicit field projection** (spec §5/§9): only the named
  `UnsealedRecord` fields are copied (`call` is projected field by field too), so a stray `credential`, `hash` or
  unknown property can never reach the file. `call.args` is passed through `redact` first. Then it seals
  `parentRecordId`, `prevHash`, `writtenAt` (the ledger's clock, ISO 8601 UTC) and `hash`, and writes one line:
  the record's JCS form plus `\n`, so a stored line is byte-for-byte the hash preimage with the `hash` member added.
  Rejects (`id` empty, unknown `phase`, `args` not an object) leave the file untouched.
- **`head()`** is the hash of the last stored record, or `"0"` for an empty or missing file (the value the next
  record's `prevHash` will take, and the value to hand to `anchor`).
- **`verify()`** streams the file and checks, per record and in order: `prevHash` equals the previous hash (`"0"` on
  the first line), `parentRecordId` equals the previous id (`null` on the first line), and the recomputed hash equals
  the stored one. It stops at the first failure: `brokenAt` is that record's `id`, or `line:<n>` when the line is not
  JSON, and `checked` counts records up to and including it. A final line without `\n` (interrupted write) is
  reported as broken. Deleting a record shows up at the next record (its parent pointer no longer matches);
  re-hashing an edited record shows up at the next record's `prevHash`; forging both is caught by `parentRecordId`.
- **`read(range)`** yields records whose `writtenAt` lies in `[from, to]` (both inclusive, compared as instants) in
  file order; it throws on an unparseable range or on a malformed line (a report must never silently skip evidence).
- **Fail-closed tail:** if the file ends in an incomplete or non-JSON line, `append` refuses ("run verify()") rather
  than chaining onto garbage. Per spec §7 the pipeline then blocks write/risky/unreviewed calls and buffers reads.
  Recovery is manual (truncate the partial line after inspection); this is a deliberate availability-for-evidence
  trade in local mode. Review question for Astra: is that the right default for a laptop?

## Redaction (spec §9)

`redact(args)` returns a new object (input never mutated) and is idempotent. Two layers, applied at every nesting
level of objects and arrays:

1. **Key layer.** The field name is normalised (lowercase, `-`, `_`, `.` and spaces removed). If it **ends with**
   `password`, `passwd`, `passphrase`, `secret`, `token`, `apikey`, `privatekey`, `accesskey`, `secretkey`,
   `clientsecret`, `authorization`, `credential(s)`, `cookie`, `setcookie`, or **equals** `pwd`, `pass`, `auth`,
   `bearer`, `key`, `ssn`, `otp`, `pin`, the WHOLE value (string, number, object or array) becomes
   `[REDACTED:key:<name>]`. So `dbPassword`, `AWS_SECRET_ACCESS_KEY`, `x-api-key`, `refresh_token` are caught; `sort_key`,
   `author`, `tokens` are not (exact-match words never match as suffixes).
2. **Value layer.** Every string is scanned; only the matching span is replaced, so the rest of a shell command or URL
   survives as evidence. In order: PEM private-key blocks (`[REDACTED:private-key]`), `scheme://user:pass@` URL
   credentials (`[REDACTED:url-credentials]`), `Bearer …` / `Basic …` auth values, JWTs (`eyJ…`.`…`.`…`), AWS access
   key ids (`AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|APKA|ASCA` + 16), GitHub tokens (`ghp_ gho_ ghu_ ghs_ ghr_ github_pat_`),
   Stripe keys (`sk_live_ sk_test_ rk_ pk_`), `sk-` / `sk-ant-` API keys, Slack tokens (`xox[abprs]-`, `xapp-`),
   Google API keys (`AIza` + 35), then generic **assignments** `name=value` / `name: value` / `"name": "value"` whose
   name contains `password|passwd|passphrase|secret|token|api_key|access_key|private_key` (`[REDACTED:assignment]`,
   value already a placeholder → skipped), then PII: e-mail addresses (`[REDACTED:email]`), US SSNs `ddd-dd-dddd`
   (`[REDACTED:ssn]`), and 13–19-digit runs that pass Luhn (`[REDACTED:card-number]`; a random 16-digit id is kept).

Not redacted on purpose (too many false positives for evidence): phone numbers, street addresses, person names,
generic high-entropy strings. Over-redaction is the accepted failure direction; a redacted `tokens: 42` in prose is
cheaper than a stored credential. Keys themselves are never redacted (they are structure, not values). Inputs are
JSON data; class instances (Date, Map) are not supported and would be flattened.
Prototype safety: output properties are added with `defineProperty`, so a JSON key `__proto__` is data, not the prototype.

## Concurrency design (JSONL)

Goal: two appends never share a `prevHash`, in one process and across processes on one machine.

1. **In-process:** a promise queue (mutex) in `JsonlLedger.serialize` runs `append`/`head` one at a time, in call
   order. `Promise.all` of 50 appends yields 50 distinct `prevHash` values (tested).
2. **Cross-process:** an exclusive **lock file** `<path>.lock`, created with Node's `wx` flag (`O_CREAT|O_EXCL`),
   containing `<pid> <iso-time>`. Waiters retry every 5–10 ms up to 5 s, then `append` rejects (fail-closed, §7).
   A lock whose pid is gone (`process.kill(pid, 0)` → `ESRCH`) or, when the pid is unreadable, whose mtime is older
   than 30 s, is treated as stale and removed. Node has no `flock`/`lockf` API [V, below], so this is the portable option.
3. **Inside the lock** the store re-reads the file's last line whenever the file size differs from what it last saw,
   so a record appended by another process becomes the parent of ours (tested with two independent store
   instances on one file). Then it writes the whole line with ONE `write(2)` on a descriptor opened with `a`
   (`O_APPEND`) and calls `fsync` before releasing the lock.

Limits (documented, not hidden):
- **Stale-lock break is racy:** two waiters can both decide a lock is stale, both unlink it and both proceed. `O_APPEND`
  still prevents overwriting, so the result is a **fork** (two records with the same `prevHash`) that `verify()` reports,
  not silent corruption. Pid reuse can make a dead holder look alive for up to 30 s; then the mtime rule applies.
- **NFS / network file systems are unsupported:** Linux documents both `O_APPEND` and `O_EXCL` as unreliable there [V].
- **Short writes:** a partial `write(2)` (disk full) is completed in a loop; between the two writes another process could
  interleave. Only reachable with the lock bypassed AND a short write, and `verify()` still catches it.
- **Durability:** `fsync` hands data to the drive; on macOS the drive's cache may still lose it on power failure
  unless `F_FULLFSYNC` is used, which Node does not expose [V]. Local mode is visibility, not audit-grade (spec §3, ADR-007).
- **A true two-process test is not in the suite** (the TS sources cannot be spawned as a child without a runner);
  the two-instance test exercises the tail re-read path but not real lock contention. Follow-up for review.
- **Trust boundary:** the user of the laptop can edit or delete the file; the chain + daily anchor make that visible, not impossible (spec §3).

## Due diligence (2026-09-30, primary sources)

- [V] Node `fs` flags: `'a'` "Open file for appending. The file is created if it does not exist."; `'wx'` "Like `'w'` but
  fails if the path exists." `fs.fsync`: "Request that all data for the open file descriptor is flushed to the storage
  device. The specific implementation is operating system and device specific." No `flock`/`lockf`/advisory-lock API
  exists in the module (grep of `doc/api/fs.md`, nodejs/node main). `fs.writeSync` returns "The number of bytes written".
- [V] POSIX `open()`: "If O_CREAT and O_EXCL are set, open() shall fail if the file exists. The check for the existence
  of the file and the creation of the file if it does not exist shall be atomic…" (pubs.opengroup.org, 9699919799).
- [V] POSIX `write()`: with `O_APPEND` "the file offset shall be set to the end of the file prior to each write and no
  intervening file modification operation shall occur between changing the file offset and the write operation."
  POSIX guarantees interleaving-freedom only for pipes (`PIPE_BUF`); for regular files it says nothing about
  interleaving between processes, hence the lock file on top of `O_APPEND`.
- [V] Linux `open(2)`: "O_APPEND may lead to corrupted files on NFS filesystems if more than one process appends data
  to a file at once"; "On NFS, O_EXCL is supported only when using NFSv3 or later on kernel 2.6 or later."
  NOTES: with O_APPEND "the modification of the file offset and the write operation are performed as a single atomic step."
- [V] macOS `fsync(2)`: "fsync() will flush all data from the host to the drive… the drive itself may not physically
  write the data to the platters for quite some time"; `F_FULLFSYNC` is the fcntl that asks the drive to flush.
- [V] RFC 8785: property names sorted as "arrays of UTF-16 code units… pure value comparisons" (§3.2.3); numbers per
  ECMA-262 `Number.prototype.toString` and "occurrences of NaN or Infinity MUST cause a compliant JCS implementation
  to terminate with an appropriate error" (§3.2.2.3); "Whitespace between JSON tokens MUST NOT be emitted" (§3.2.1).
- [V] `canonicalize` 5.1.0 (`lib/canonicalize.js`, read): sorts with `Object.keys(value).sort()` (UTF-16 code unit
  order), drops `undefined`/function/symbol-valued object members like `JSON.stringify`, turns them into `null` inside
  arrays, unwraps `toJSON`, and throws on NaN, Infinity, lone surrogates and cycles. Return type is `string | undefined`.
- [H] A single `write(2)` of one JSONL line (a few KB) on a local APFS/ext4 file opened `O_APPEND` is not interleaved
  with another process's write in practice. Widely relied on, but POSIX does not promise it; the lock file is the guarantee.
- [H] The `wx` lock file approach behaves the same on Windows (`O_EXCL` maps to `CREATE_NEW`); not tested here.
