**Review result: changes required before merge.** Reviewed `slice-1a-ledger` through `6f8b9dc`, including the five commits in `slice-1..HEAD`.

`npm run typecheck` passed. `npm test` failed at startup because the sandbox denied Vitest’s config-cache write. I ran direct redaction/JCS probes and exercised ledger/anchor logic with an in-memory filesystem; real filesystem contention remains untested. No files were changed.

1. **[P1] Nested metadata bypasses projection.** [src/ledger/jsonl.ts:129](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:129)  
   `policy`, `approval`, `outcome`, and `handoff` are copied wholesale. I confirmed `policy.credential.value = "RAW-SECRET"` reaches the stored line.  
   **Test:** Add extra `credential` and raw `args` properties to each nested object; assert none reach storage.  
   **Fix:** Validate and explicitly project every nested contract object. Validate scalar fields too, so an object cannot be smuggled through a nominal string field.

2. **[P1] Ordinary quoted secrets survive redaction.** [src/ledger/redact.ts:48](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:48)  
   These remain unchanged: `password="two word secret"`, `password="alpha,beta"`, and `JSON.stringify({password:"two word secret"})` inside a string. Lowercase `authorization: bearer opaqueCredential` also survives.  
   **Test:** Assert those secret values disappear, including escaped quotes and multiline values.  
   **Fix:** Parse quoted assignments with escape handling; parse bounded JSON-in-string content before redacting it. Make authentication-scheme matching case-insensitive. Require placeholders to match completely; `password=[REDACTED:fake]hunter2` currently bypasses the assignment rule.

3. **[P1] Secret-bearing keys are persisted—and copied into placeholders.** [src/ledger/redact.ts:89](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:89)  
   `{[githubToken]: "present"}` preserves the token. A key `${githubToken}_password` preserves it both as the property name and inside `[REDACTED:key:…]`.  
   **Test:** Use a recognized token or email address as a key; search the complete serialized result for it.  
   **Fix:** Inspect keys for sensitive content and omit/redact the containing entry with collision-safe handling. Never embed an untrusted original key in a placeholder.

4. **[P2] Encoded and split representations bypass the redaction boundary.** [src/ledger/redact.ts:80](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:80)  
   Confirmed survivors include `password%3Dhunter2`, base64/hex encodings of `password=hunter2`, `["--password","hunter2"]`, and `{"ｐａｓｓｗｏｒｄ":"hunter2"}`.  
   **Test:** Table-test those cases and header representations such as `["Authorization","Bearer","opaqueCredential"]`. Assert secret-bearing representations are omitted or sanitized under the chosen policy.  
   **Fix:** Add contextual handling for supported argv/header structures, Unicode compatibility normalization for key classification, and bounded decoding for supported encodings. Omit opaque fields where secrecy is required. Arbitrary encoding/splitting cannot be defeated reliably by regexes; document the remaining limit in §7 instead of promising universal secret removal.

5. **[P2] `toJSON` can reintroduce secrets after redaction.** [src/ledger/redact.ts:82](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:82)  
   An enumerable function survives traversal. I confirmed `{obj:{toJSON(){return {password:"raw-from-toJSON"}}}}` stores the raw password when canonicalization invokes it. This requires an in-process non-JSON caller, not an ordinary parsed JSON payload.  
   **Test:** Append that object and require rejection before storage; include accessors and stateful `toJSON` implementations.  
   **Fix:** Enforce the documented JSON-only boundary: reject functions, accessors and unsupported prototypes; construct plain validated data before hashing.

6. **[P1] Long benign strings block the event loop through quadratic regex work.** [src/ledger/redact.ts:48](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:48)  
   `redact({text:"x".repeat(n)})` took approximately **40 / 154 / 657 / 2,429 ms** at 10 / 20 / 40 / 80 KB. Redaction runs while holding the ledger lock, magnifying contention.  
   **Test:** Run large-input cases in a supervised child process with a hard external deadline; include a doubling-size benchmark. An in-process test timeout cannot interrupt this synchronous work.  
   **Fix:** Replace the unanchored assignment search with a linear scanner and enforce explicit size/depth limits before expensive processing.

7. **[P1] Stale-lock reclamation and release can delete another owner’s lock.** [src/ledger/jsonl.ts:55](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:55), [src/ledger/jsonl.ts:59](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:59)  
   Both paths unlink by pathname without establishing ownership. I reproduced a stale decision deleting a replacement live lock. Two writers can then seal against the same parent.  
   **Test:** Barrier-control two reclaimers: both inspect the old lock; A replaces it; B performs its stale unlink. Also test an old holder releasing after replacement. Require exclusive ownership throughout.  
   **Fix:** Use an OS-backed lock or a single writer. The conservative interim fix is to disable automatic stale reclamation and require quiescent recovery. A separate inode/token check followed by `unlink` still has a race.  
   **Detection:** An intact two-record fork **is detected** by `verify()` at the second branch record. I confirmed that. Detection afterward does not make successful conflicting appends safe.

8. **[P2] The five-second lock timeout is not enforced on every path.** [src/ledger/jsonl.ts:34](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:34), [src/ledger/jsonl.ts:59](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:59)  
   A stale lock whose unlink returns `EPERM` loops through `continue`, skipping both timeout and sleep. Separately, synchronous unbounded `readFileSync` follows symlinks and can block on a FIFO.  
   **Test:** Mock dead PID + unlink `EPERM`; require bounded rejection. In a supervised process, test `.lock` as a FIFO and as a symlink to one.  
   **Fix:** Check a monotonic deadline on every retry, propagate non-recoverable unlink errors, and use bounded reads from a verified regular file opened without following symlinks. Protect the containing directory. `wx` itself prevents creating through an existing symlink; the unsafe follow occurs during inspection. [Node filesystem documentation](https://nodejs.org/api/fs.html#file-system-flags).  
   **PID correction:** A live/reused PID never reaches the 30-second rule. An old lock containing a live PID keeps causing five-second failures until that PID exits. Test this and correct README line 82; do **not** “fix” it by expiring genuinely live owners solely by age. `kill(...,0)` returning `EPERM` appropriately does not establish death.

9. **[P2] Tail and record validation accept invalid ledger evidence.** [src/ledger/jsonl.ts:166](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:166), [src/ledger/jsonl.ts:201](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:201)  
   Confirmed: `{"id":"bad","hash":"x"}\n` permits append; a correctly hashed record containing only `id`, `prevHash`, and `parentRecordId` passes verification; duplicate IDs pass; blank lines are skipped. `1e400` in parsed data makes verification throw instead of returning a broken record.  
   **Test:** Add each case, plus missing required fields, invalid enums, and lone surrogates.  
   **Fix:** Share strict runtime record validation across sealing, tail inspection, verification and reading. Enforce ID uniqueness, reject interior/leading blank lines, and convert record canonicalization failures into contextual verification failures.  
   Also test a same-size tail replacement: the size-only cache at line 161 returns the old head. Re-read the tail under the lock rather than treating equal size as proof of unchanged content.

10. **[P2] `read()` accepts incomplete tails and silently drops invalid timestamps.** [src/ledger/jsonl.ts:231](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:231)  
    Removing only the final newline makes `verify()` fail but `read()` still yields the record. A record with `writtenAt:"garbage"` silently disappears because comparisons against `NaN` are false.  
    **Test:** Require iteration to reject both cases rather than complete successfully.  
    **Fix:** Share framing/completeness checks and schema validation with verification; explicitly reject invalid timestamps. Reports must discard partial results when iteration fails.

11. **[P2] Anchor writes conceal earlier torn-write damage.** [src/anchor/file.ts:56](/Users/ryanzeleznock/agent-ledger-fable/src/anchor/file.ts:56)  
    Start with `{"hash":"`, then perform two valid writes. Both writes succeed; the first joins the fragment into invalid JSON, while the second makes `latest()` return normally, hiding that corruption.  
    **Test:** Require the first write after a malformed/incomplete tail to reject without changing bytes. Inject short writes and interleave two writers too.  
    **Fix:** Validate existing framing under cross-process exclusion before append. Preserve interrupted tails for recovery. The short-write loop means a logical entry can use multiple writes, so the README’s unconditional “single write” justification is insufficient. Reject zero-progress writes rather than looping indefinitely.

12. **[P2] Date parsing accepts ambiguous or invalid evidence timestamps.** [src/ledger/jsonl.ts:229](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:229), [src/anchor/file.ts:24](/Users/ryanzeleznock/agent-ledger-fable/src/anchor/file.ts:24)  
    Anchor accepts `at:"0"` and normalizes February 30 through `Date.parse`. A timezone-free September 30 range included a `02:00Z` record under `TZ=UTC` but excluded it under `TZ=America/New_York`.  
    **Test:** Run range cases in both timezones; reject timezone-free timestamps, impossible calendar dates and `"0"`; accept equivalent explicit offsets consistently.  
    **Fix:** Require a validated timestamp format with an explicit offset and real calendar validity. Compare parsed instants afterward. This timezone dependence is specified JavaScript behavior, not a platform accident. [ECMAScript Date.parse](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-date.parse).

13. **[P2] The README overstates forgery detection.** [src/ledger/README.md:29](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/README.md:29)  
    **A full re-chain is undetectable without trusted external evidence.** I edited record 1, recomputed every subsequent hash/link, and got `{ok:true,checked:3}`. Parent IDs are attacker-editable too.  
    **Test:** Add an explicit residual-limit test demonstrating that full rewriting passes internal verification, followed by a separate trusted-anchor comparison that fails.  
    **Fix:** Correct the documentation. The caller must compare a verified chain’s anchored prefix against an independently protected anchor. A same-machine anchor can be rewritten consistently; later unanchored records remain rewritable. `verify()` currently performs no anchor comparison.

Other requested checks: CRLF records and a last record larger than 64 KiB worked in the in-memory probes. `pass_word` is redacted. Tested redaction cases remained idempotent, including the leaking cases—idempotency alone establishes no secrecy guarantee. Prototype-key handling preserves `__proto__` as data.

JCS behavior looked correct for the tested primitives: `-0` becomes `0`; NaN, Infinity, BigInt and lone surrogates reject. Large numeric literals may already have rounded before hashing; use strings where exact large integers matter. Undefined object members disappear, while undefined array entries become null; reject undefined required fields at validation. Add UTF-16 sorting and composed/decomposed Unicode tests without normalizing hash inputs. These semantics follow [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html).

**Fable’s multi-process test:** compile a child fixture and its imports with the existing TypeScript compiler, then launch multiple compiled fixtures using `child_process.fork()`. Emit into a temporary directory beneath the repo so ESM/package dependency resolution remains intact. For example:

```sh
npm exec -- tsc --noEmit false --rootDir . --outDir .test-build
```

Each child should create its own ledger instance, announce `ready`, await an IPC `go`, append 100 uniquely prefixed records, and report completion. Release all children together; assert distinct PIDs, successful exits, exactly 400 records for four children, unique IDs/parent hashes, valid linkage, and successful verification after reopening. Add deterministic IPC barriers around stale-lock inspection/removal for the race regression; ordinary stress alone may miss it. Kill and reap children on timeout and remove build/test artifacts. `fork()` provides separate processes and IPC; Vitest’s transforms are not inherited. [Node child-process documentation](https://nodejs.org/api/child_process.html#child_processforkmodulepath-args-options).

**Fable’s incomplete-tail question:** yes, fail-closed is the right default for append. Preserve §7’s write/risky/unreviewed blocking and read buffering. Recovery should explicitly preserve the damaged original, verify the complete prefix, compare available trusted anchors, and record the recovery action before resuming. Do not silently truncate—even valid JSON missing its final newline represents an uncertain append boundary.

The read-only sandbox prevented saving the review handoff or updating vault session notes. Fable still needs to implement the fixes and run the filesystem and multi-process regressions.
