# cli

Status: implemented

Local process composition root for Slices 1b and 1c. Build with `npm run build`; run
`node /absolute/repo/dist/cli/main.js ...`. The package bin is `agent-ledger` → `dist/cli/main.js`.
`main(argv, overrides)` returns an exit code and accepts injected I/O, hooks and module factories;
importing it never launches a command. The entry guard resolves argv[1] through realpath, so npm-bin
symlinks and macOS /tmp aliases execute normally. Coordinator-authorized dependency correction
(review #2): `yaml` moved to runtime dependencies, still pinned at 2.9.1, with no version drift.

## Commands and layout

```text
agent-ledger init [--dir d]
agent-ledger hook --agent claude-code|codex --event pre|post|session-start|denied [--dir d]
agent-ledger anchor [--dir d]
agent-ledger verify [--dir d]
agent-ledger report --from RFC3339 --to RFC3339 --out directory [--dir d]
agent-ledger install-hooks --print [--dir d]
```

`--dir` defaults to `./.agent-ledger`, resolved against the caller's working directory. `init`
creates a new directory (0700) and refuses any existing directory, including a partial prior init:

| Path beneath `--dir` | Purpose |
| --- | --- |
| `registry.yaml` | YAML-compatible JSON copied from the reviewed `policies/tools.example.yaml` server rows. Original reviewer/date retained. Example Codex proxy identity omitted until a real proxy is configured. |
| `agents.yaml` | File identity registry: `local-agent`, local credential's SHA-256 digest only. |
| `credential` | Random 32-byte credential encoded as 64 hex characters plus newline, 0600. |
| `hmac.key` | Independent 32 random **binary** bytes, 0600. Never overwritten or printed. |
| `ledger/records.jsonl` | JSONL ledger, created lazily on first append; directory is created at init. |
| `anchors.jsonl` | Local file anchor: written by `anchor`, read by `verify` and `report`. No scheduler; the demo runs `anchor` after the agent exits. |

The example has reviewed **Bash = risky**, with no clear argument fields. Review the example policy
before adopting it outside the sandbox; initializing does not constitute a new review. Identity is
one local configured agent, not a claim that a terminal user's approval identity was authenticated.
Keep `policies/` alongside `dist/` when moving the checkout. `init` reads that shipped asset by an
absolute module-relative path, never a policy file in the calling project's working directory.

## Hook wiring

Pre: bounded stdin → parse for configured agent → credential/incoming call → pipeline `decide` →
formatter → one stdout line, exit 0. Every exception is nonzero so the **watchdog** can deny. The CLI
upstream stub throws if called; this handler never runs a tool. Pipeline dependencies include
`hook-ask`, the configured agent and the binary HMAC key (`argsHmacKey`, checked with `satisfies PipelineDeps`).

Post: parse (PostToolUse or PostToolUseFailure) → outcome adapter → `recordOutcome(tool_use_id, outcome)`.
Nothing on stdout; operational failures go to stderr as one fixed line and still exit 0.

**Record-only handlers never see a watchdog clock (ADR-011, Slice 1c).** `createPipeline` no longer reads
`AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS`; `decide()` checks it on every call. So `post`, `session-start`
and `denied` construct the pipeline with both clock variables absent (the Slice 1b construction-only
shim is deleted; `test/cli.test.ts` "ADR-011" proves it), and a `pre` handler started outside the
watchdog can only answer a deny line (`WATCHDOG_DEADLINE_DENY_REASON`; under the watchdog that is exit 2).
Pre never manufactures a deadline.

Session-start (Slice 1c, ADR-010, pin 5): parse (must be SessionStart) → the configuration checks above →
**probe** → `toHeartbeat` → `pipeline.recordHeartbeat(hb, credential)`. The probe measures this process:
`interpreter = realpathSync(process.execPath)`, `nodeOptionsSet = NODE_OPTIONS is non-empty` (the value
is never read into a record), and `watchdogCheck`, a **self-test** that runs the real compiled
`<dist>/hooks/watchdog-main.js --agent <agent> --deadline-ms 1000 --timeout-s 3 -- <node> -e '<one valid
allow line>'` under a 3 s hard cap: exit 0 AND output that passes the hooks module's strict
`validateHandlerOutput` with decision `allow` → `ok`; ENOENT on the watchdog file → `missing`; anything else
(non-zero exit; output the validator rejects: missing reason, extra/duplicate keys, several values, deny/ask,
oversized, empty; the cap; a spawn failure) → `failed` (Astra 1c P2 #2). The watchdog is spawned as its own
process-group leader and every terminal path kills that group, destroys the probe's pipe handles and unrefs the
child, plus a 500 ms grace between the watchdog's `exit` and `close`: a descendant that inherited the watchdog's
stdio can neither hold this handler open past the cap nor outlive it (Astra 1c P2 #1; Node `close` needs every
shared stdio stream closed, nodejs.org/api/child_process.html#event-close, read 2026-10-03; pinned by the
real-process sidecar test in `test/cli-process.test.ts`). The probe runs only after the key, credential and
registry checks passed, so a broken configuration spawns nothing.
**This handler prints NOTHING on stdout, ever**: Claude Code adds a SessionStart hook's plain-text stdout
to Claude's context (Claude Code hooks reference, https://code.claude.com/docs/en/hooks, read 2026-10-01;
Codex adds it "as extra developer context", https://learn.chatgpt.com/docs/hooks, same date). Failures
are one fixed stderr line, exit 0 always. Registered WITHOUT the watchdog. Cost: one watchdog round trip
per session start (observed 100-350 ms in `test/e2e-slice-1c.test.ts`), repeated on `compact`/`clear`.

Denied (Slice 1c): parse (must be Claude Code's auto-mode PermissionDenied) → `toOutcome` →
`recordOutcome(tool_use_id, { status: "blocked", errorClass: "permission-denied:auto-mode" })`. Silent,
exit 0 always, WITHOUT the watchdog (Claude Code ignores its exit code and stderr anyway). The event's
`reason` is display text and is never stored. Claude Code only: `--agent codex --event denied` is a usage
error (exit 2) because Codex has no such event. A manual denial at the permission prompt fires no hook
event at all (same reference, 2026-10-01), so it cannot be recorded by anything in this CLI.

`install-hooks --print` prints only a JSON `hooks` snippet for **Claude Code**. It uses absolute Node,
CLI, watchdog and ledger-directory paths, POSIX shell quoting, all-tools matcher, PreToolUse via the
watchdog with pinned 25 s deadline/30 s timeout, and direct PostToolUse, PostToolUseFailure, SessionStart
and PermissionDenied commands (five events; only PreToolUse decides, so only it runs under the watchdog).
It never opens a settings file. Paste only into a sandbox project's `.claude/settings.json` for the
demo. Codex parsing is wired, but this command does not install Codex settings; `hook-ask` cannot approve
risky Codex calls. The proxy/Slack setup is outside this CLI slice. See [the demo](../../docs/DEMO.md).

## Anchor

`anchor` reads `before = ledger.head()`, runs `ledger.verify()`, and **refuses** (exit 1, one JSON line
`{ anchored: false, reason, chain }`) with `chain-failed` when the chain does not verify, `empty-ledger`
when the head is the genesis `0`, or `ledger-changed` when the head moved during verification (an agent
is still writing: exit it first, then retry). Otherwise it appends `{ hash: before, at: now }` through
the anchor module (`anchors.jsonl`, O_APPEND + fsync + lock; a torn anchor file makes the module throw →
exit 1, never a truncation) and prints ONE JSON line: `{ anchored: true, entry: { hash, at }, line:
"<the canonical JSON line appended, without its newline>", previous: <AnchorEntry | null>, chain,
path: "<absolute anchors.jsonl>", note }`. `anchor` never changes the ledger. Re-anchoring the same head
appends another line on purpose: the file is a time series of "the chain ended here at this time".

**Honesty note (printed as `note`).** The anchor is one line in a local file that this machine's owner can
edit, so by itself it proves nothing to anyone else. Copy `line` off-machine now (git, e-mail, S3) for it
to mean anything; it detects tail truncation only relative to the copy you keep, and establishes no
enforcement (ADR-007 local-mode trust boundary). The server-mode S3 Object Lock backend is not in this slice.

## Exit codes and verification

| Code | Meaning |
| --- | --- |
| 0 | Command completed; hook `pre` successfully formatted a decision (including deny); `post`, `session-start` and `denied` are always non-blocking (exit 0 even when nothing was recorded; stderr says so). Anchor: one line appended. Verify: chain passed and a non-genesis latest anchor matches head or a retained ancestor. Report: export completed with chain verification passing. |
| 1 | Operational/configuration failure, chain failure (including a completed report whose chain failed), or latest anchor absent from the retained chain. Anchor refused (`chain-failed`, `empty-ledger`, `ledger-changed`) or a torn anchor file. Pre failures are converted to deny by the watchdog. |
| 2 | CLI usage error (including `--agent codex --event denied`). The watchdog separately uses exit 2 for a blocked pre call. |
| 3 | Verify: chain passed, but no non-genesis anchor is available. Distinct from fully checked verification. |

Verify prints JSON containing the full `ledger.verify()` result, observed head, and `anchor: { status,
latest }` with status `head`, `ancestor`, `missing`, `mismatch` or `untrusted` (chain failed); `report`
computes the same object through the same function (`anchorState`) and prints it too. An ancestor
anchors only a prefix; its existence does not anchor subsequent records. Genesis `0` anchors no records
and is reported as `missing`/exit 3, even for an empty ledger. Verify never creates an anchor or changes
the ledger. A fresh init returns **3** until `anchor` has run. A valid chain alone cannot detect removal
of its tail. Pause writers for verify/report/anchor; changed heads fail. Local anchors offer no
independent tamper resistance.

Report writes `report.html`, `report.pdf`, `records.csv` to a fresh output directory and prints paths,
the report's own `chain` verification result and the `anchor` status as JSON. Before rendering, the CLI
takes the head and runs its own `verify()` pass to compute `anchor` exactly as `verify` would, then hands
`{ anchor }` to `generateReport(ledger, range, outDir, context)` (pin 6; the report renders the anchor
line from it) and the report verifies again itself, so stdout `chain` is the report's result; if the head
moved in between, exit 1 (`Ledger changed; retry`). Explicit-offset timestamps are inclusive; invalid
calendar dates or times return usage/exit 2. A readable ledger with a failed chain still produces a
diagnostic pack, prints `chain.ok: false` and `anchor.status: "untrusted"`, and returns exit 1. Exit 0
requires a passing chain. No mode, collector or external-anchor attestation is added. See
[report semantics](../report/README.md).

Errors deliberately omit raw parser/registry exception text that might contain secrets. Hook private
files must be regular, nonsymlink, owned by the current user, and mode 0600. All operations remain
within the local-mode visibility/best-effort-gating trust boundary on a user-controlled machine.

Tests: injected contracts in `test/cli.test.ts`; built real-process commands and a directly written
JSONL ledger in `test/cli-process.test.ts`; the demo paths end to end with the built artifacts in a
private build root in `test/e2e-slice-1b.test.ts` and `test/e2e-slice-1c.test.ts` (five-event snippet,
silent heartbeat with `watchdogCheck: "ok"`, auto-mode denial chained, anchor → verify `head` →
`ancestor` → truncation `mismatch`, report `anchor.status`, fail-closed and leak sweep).
Full gate: `npm run typecheck && npm test`.


## Review residuals (Fable, 2026-09-30)

- **#8:** Handoff matching and record finding lookups still use quadratic scans in the worst case.
  Large ledgers can be slow; indexed joins and streaming need a later change. No 50k-record runtime
  bound is claimed.
- **#10:** The AICPA primary PDF and printed pages were read by Astra. Fable could not independently
  retrieve the mirror (403) or account-gated publisher download. Ryan should spot-check the cited
  pages; candidate evidence mappings and auditor acceptance remain [H].
- **#11:** Printed hooks still use the valid, tested shell command form. Moving to the documented
  exec/args form is deferred; existing POSIX quoting and hostile-path tests remain applicable.

## Slice 2a: `--ledger <postgres url>` on `anchor`, `verify`, `report` (Fable, 2026-10-03; pin 7, ADR-013)

```text
agent-ledger anchor | verify | report ... [--ledger postgres://user@host:port/db]
```

With `--ledger` (the value must start with `postgres://` or `postgresql://`, else usage/exit 2) the command uses
`createLedger("postgres", url)` instead of the jsonl file and skips the `<dir>/ledger` existence check; `--dir` still
holds `anchors.jsonl` and is created (0700) when absent, so the Mac keeps the anchor: the off-machine copy the Postgres
ledger needs. **The password is not on the command line**: the URL carries the user only and `pg` reads `PGPASSWORD`
from the environment (libpq variables). [H] until B cites the node-postgres "connecting" page in `src/ledger/README.md`
(`pg` honours `PGPASSWORD`, `PGHOST`, `PGUSER`, `PGDATABASE`, `PGPORT` like libpq); the Postgres e2e run is the check.
The URL is never printed: stdout carries the same JSON as the jsonl form (`head`, `chain`, `anchor`, `path`), stderr the
fixed failure line. `hook`, `init` and `install-hooks` refuse `--ledger` (strict option parsing: usage, exit 2). Exit
codes are unchanged. `test/cli.test.ts` "--ledger" covers parsing, the refusal rows and the no-URL output with a fake
`createLedger` injected through `CliDeps`; `test/e2e-slice-2a.test.ts` step 10 runs the real binary (`--ledger` form when
`AGENT_LEDGER_E2E_LEDGER` is set, jsonl form otherwise).
