# ledger: tests to write

Converted to real tests on 2026-09-30 (jsonl, local mode). Each line names the test file that now holds it.
- [x] editing any one record makes verify() fail at that record → `test/ledger-jsonl.test.ts`
- [x] key order doesn't change the hash (hashRecord uses `canonicalize`, RFC 8785; compared against a hash computed by hand from the JCS string) → `test/ledger-hash.test.ts`
- [x] genesis record has parentRecordId null and prevHash "0"; every later record's parentRecordId is the previous id and prevHash the previous hash → `test/ledger-jsonl.test.ts`
- [x] verify() fails when parentRecordId continuity breaks even if the hashes still chain → `test/ledger-jsonl.test.ts`
- [x] two concurrent appends never share a prevHash → `test/ledger-jsonl.test.ts` (50 in-process; two instances) and `test/ledger-multiprocess.test.ts` (4 real processes × 100, IPC barrier)
- [x] secrets nested in objects or arrays are redacted → `test/ledger-redact.test.ts`; stored-record check in `test/ledger-jsonl.test.ts`
- [x] a JSONL chain verifies after a restart → `test/ledger-jsonl.test.ts`

Added from Astra's review (2026-09-30), all implemented:
- [x] nested projection, JSON-only boundary, strict stored-record shape, explicit-offset timestamps → `test/ledger-validate.test.ts`
- [x] quoted/JSON-in-string/scheme/placeholder/key/argv/header/encoded redaction cases → `test/ledger-redact.test.ts`
- [x] redaction time grows linearly, under a hard external deadline → `test/timing/ledger-redact-bench.test.ts`
- [x] leftover lock fails closed and is never deleted; symlink/FIFO lock paths; tail re-read; blank lines; duplicate ids; 1e400; read() framing → `test/ledger-jsonl.test.ts`
- [x] a full re-chain passes verify(); trusted-anchor comparison catches it → `test/ledger-jsonl.test.ts`

Added from Astra's re-review (2026-09-30, round 2), all implemented:
- [x] injected stored field breaks verify/head/append; redacted-size rejection; duplicate ids under the lock → `test/ledger-jsonl.test.ts`
- [x] strict stored projection, descriptor snapshot (getters never invoked, Proxies), :60 and >3 fractional digits refused → `test/ledger-validate.test.ts`
- [x] scheme-in-value, long words (also keys/URLs), short base64/hex, one decode level, nested JSON/quotes budget, linear renaming/PEM → `test/ledger-redact.test.ts`, `test/timing/ledger-redact-bench.test.ts`
- [x] contention proof: A holds the lock, B-D blocked (EEXIST) then land after release → `test/ledger-multiprocess.test.ts`

Added from Astra's round 3 (2026-09-30), all implemented:
- [x] stored line must equal its canonical JCS serialisation (duplicate members, whitespace, reordering, escapes) → `test/ledger-jsonl.test.ts`
- [x] accessors/Proxies in any contract object rejected before writing; sealed record validated through the read path → `test/ledger-jsonl.test.ts`, `test/ledger-validate.test.ts`
- [x] common-format redaction table (headers, cookies, env lines, JSON keys, URLs, CLI flags) → `test/ledger-redact.test.ts`

Still to write:
- [ ] postgres backend (Slice 2): the same chain rules over a table with an append-only role; verify() and read(range) parity with jsonl
- [ ] pipeline/report: the caller-side anchor comparison (anchored head ∈ verified chain) as a real function, once `src/report/` exists
- [x] (Astra verification P2, 2026-09-30) `redact.ts` key-layer exemption also keeps arbitrary `[REDACTED:…]` strings under sensitive keys; narrow it to exact `hmac-sha256:[0-9a-f]{64}` only, with a test that a sensitive-key value shaped like a placeholder is redacted
- [x] (coordinator, 2026-09-30) full suite is load-sensitive: `ledger-redact-bench` and several real-process watchdog timing tests fail when another suite runs concurrently on the same machine (idle: 3/3 green). Isolate timing suites (vitest project with `fileParallelism: false`, or a separate `npm run test:timing`)

Slice 1c pin 10: `test/ledger-redact.test.ts` covers placeholder values, inexact digests, exact lowercase digests and nested-key/header-object idempotence. Test-first run: the placeholder cases failed before the key-layer fix.


Pin 9 mechanism (verified 2026-10-01, Vitest 4.1.11): `test:unit` excludes `test/timing/**`;
`test:timing` selects that path with `--no-file-parallelism --maxWorkers=1`; `test` runs unit
then timing and `check` remains unchanged. Unit file workers are capped at two in `vitest.config.ts`
to leave capacity for subprocesses and a concurrent checkout. Both scripts use verbose reporting. Primary docs: [CLI exclude/filter](https://vitest.dev/guide/cli),
[fileParallelism](https://vitest.dev/config/fileparallelism) (false forces one worker),
[maxWorkers](https://vitest.dev/config/maxworkers). Only the two pinned files move.
The initial isolation-only attempts were not green: `ps` was refused by the sandbox, and assertion
failure cleanup killed only the watchdog, leaving its detached infinite-loop handler alive. A new
regression reproduced that leak (1 failed / 74 filtered tests); cleanup now tracks each invocation's
PID file and stderr child ids, kills owned groups/escapees, destroys pipes and settles pending waits.
A second regression covers a detached child retaining pipes after its parent exits. The test runner
has a 15 s deadline independent of the watchdog; production deadlines/assertions are unchanged.
The process-group assertion now checks `process.kill(-pid, 0)` and subsequent watchdog reaping,
instead of invoking `ps`. [V] [Node process.kill](https://nodejs.org/api/process.html#processkillpid-signal)
and [kill(2)](https://man7.org/linux/man-pages/man2/kill.2.html), read 2026-10-01: negative pid addresses
a process group; signal zero checks existence/permission without sending a signal. No test is skipped.
Only the pinned two files moved; no production watchdog, helper fixture or shared shape was edited.

All resumed executions use `perl -e 'alarm shift; exec @ARGV' 300 ...` for file-level tests and
600 seconds for `npm test`/`npm run check`. Concurrency trials use independent copies (including
separate dependencies and build roots), preserve dependency symlinks, and record all fixed trials.
Early copy attempts with flattened symlinks or omitted dependency `dist` directories were invalid
harness attempts, not concurrency passes; their logs remain under `/tmp/astra-1c-invalid-*`.


Pin 9 acceptance, fixed trials after cleanup repair (2026-10-01, macOS / Node 25.8.2):
Every run below: unit 975 passed / 7 skipped; timing 77 passed; total **1,052 passed / 7 skipped**.
The second checkout's full `npm test` starts simultaneously with the primary in each concurrent trial.

| Trial | Primary elapsed (s) | Concurrent copy elapsed (s) | Result |
| --- | ---: | ---: | --- |
| solo 1 | 42.72 | — | PASS |
| solo 2 | 42.31 | — | PASS |
| solo 3 | 42.09 | — | PASS |
| concurrent 1 | 43.50 | 44.52 | PASS |
| concurrent 2 | 43.53 | 43.94 | PASS |
| concurrent 3 | 43.09 | 43.08 | PASS |

Solo **3/3**, concurrent **3/3** (both checkouts green in each pair), no retries within these trials.
Command: `perl -e 'alarm shift; exec @ARGV' 600 npm test`; both npm phases select verbose reporting.
Logs: `/tmp/astra-1c-bounded-{solo|concurrent}-{1|2|3}-{primary|secondary}.log`; machine-readable
results `/tmp/astra-1c-bounded-results.json`. Earlier failures were retained, diagnosed and fixed,
not discarded as acceptance passes. Revert-check: the detached-handler cleanup regression fails
against the old cleanup, passes after the fix; report/redaction first run was 27 failed / 53 passed.

Integration follow-up (ADR-011, coordinator): the retained watchdog `pipeline-init/slack-timeout`
case in `test/timing/hooks-watchdog.test.ts` and its existing `test/helpers/hooks-handler.ts`
fixture assert constructor-time clock rejection on B's pinned base. After A's deadline amendment,
update that fixture to exercise `decide()` and assert a deny decision instead. The shared helper
is outside Package B ownership; these standalone 3/3 results do not establish merged-tree parity.


Fable review 2026-10-03:
- [x] #3 array-pair exemptions now preserve only exact lowercase digests, alongside structural auth-scheme tokens;
  placeholder/inexact/uppercase values normalize to `[REDACTED:pair]`, including nested arrays and header triples.
- [ ] #9 two independent Vitest phases each run globalSetup; retain fresh child builds until safe shared-build
  invalidation exists (residual documented in `src/report/README.md`).
