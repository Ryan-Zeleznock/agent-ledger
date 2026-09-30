# cli

Status: implemented

Local process composition root for Slice 1b. Build with `npm run build`; run
`node /absolute/repo/dist/cli/main.js ...`. The package bin is `agent-ledger` → `dist/cli/main.js`.
`main(argv, overrides)` returns an exit code and accepts injected I/O, hooks and module factories;
importing it never launches a command. The entry guard resolves argv[1] through realpath, so npm-bin
symlinks and macOS /tmp aliases execute normally. Coordinator-authorized dependency correction
(review #2): `yaml` moved to runtime dependencies, still pinned at 2.9.1, with no version drift.

## Commands and layout

```text
agent-ledger init [--dir d]
agent-ledger hook --agent claude-code|codex --event pre|post [--dir d]
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
| `anchors.jsonl` | Optional local file anchor, read by verify; no scheduler/anchor-writing command in this slice. |

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

Post: parse → outcome adapter → `recordOutcome(tool_use_id, outcome)`. Nothing on stdout; operational
failures go to stderr and still exit 0. The frozen pipeline constructor requires an absolute deadline
for decide-only instances even when only `recordOutcome` will be used. The direct post handler supplies
a construction-only deadline of now + DEFAULT_DEADLINE_MS, then restores the environment immediately.
It does not make a decision or claim watchdog supervision. Pre never manufactures a deadline.
Coordinator decision (2026-09-30, review #3): retain this shim instead of changing the contract.
The recordOutcome-only construction question remains open for Ryan. A conditional process test
activates when both hooks and pipeline READMEs say `Status: implemented`; it requires a real
outcome append with both watchdog environment variables absent. It is skipped on this stub branch.

`install-hooks --print` prints only a JSON `hooks` snippet for **Claude Code**. It uses absolute Node,
CLI, watchdog and ledger-directory paths, POSIX shell quoting, all-tools matcher, PreToolUse via the
watchdog with pinned 25 s deadline/30 s timeout, and direct PostToolUse/PostToolUseFailure commands.
It never opens a settings file. Paste only into a sandbox project's `.claude/settings.json` for the
demo. Codex parsing is wired, but this command does not install Codex settings; `hook-ask` cannot approve
risky Codex calls. The proxy/Slack setup is outside this CLI slice.

Hooks and pipeline still throw `not implemented` on this branch until Fable's half lands, and the
watchdog entry point is owned by Fable. A printed PreToolUse snippet must not be treated as installed
protection before that file exists. See [the demo](../../docs/DEMO.md).

## Exit codes and verification

| Code | Meaning |
| --- | --- |
| 0 | Command completed; hook pre successfully formatted a decision (including deny); valid post command is always non-blocking. Verify: chain passed and a non-genesis latest anchor matches head or a retained ancestor. Report: export completed with chain verification passing. |
| 1 | Operational/configuration failure, chain failure (including a completed report whose chain failed), or latest anchor absent from the retained chain. Pre failures are converted to deny by the watchdog. |
| 2 | CLI usage error. The watchdog separately uses exit 2 for a blocked pre call. |
| 3 | Verify: chain passed, but no non-genesis anchor is available. Distinct from fully checked verification. |

Verify prints JSON containing the full `ledger.verify()` result, observed head, `anchor.latest()` and
status `head`, `ancestor`, `missing`, `mismatch` or `untrusted` (chain failed). An ancestor anchors only
a prefix; its existence does not anchor subsequent records. Genesis `0` anchors no records and is reported as `missing`/exit 3, even for an empty ledger. Verify
never creates an anchor or changes the ledger. A fresh init normally returns **3**: this slice does
not schedule anchor writes. A valid chain alone cannot detect removal of its tail. Pause writers for
verify/report; changed heads fail. Local anchors offer no independent tamper resistance.

Report writes `report.html`, `report.pdf`, `records.csv` to a fresh output directory and prints paths
and the report's own `chain` verification result as JSON. Explicit-offset timestamps are inclusive;
invalid calendar dates or times return usage/exit 2. A readable ledger with a failed chain still
produces a diagnostic pack, prints `chain.ok: false`, and returns exit 1. Exit 0 requires a passing chain. No mode, collector or external-anchor
attestation is added. See [report semantics](../report/README.md).

Errors deliberately omit raw parser/registry exception text that might contain secrets. Hook private
files must be regular, nonsymlink, owned by the current user, and mode 0600. All operations remain
within the local-mode visibility/best-effort-gating trust boundary on a user-controlled machine.

Tests: injected contracts in `test/cli.test.ts`; built real-process commands and a directly written
JSONL ledger in `test/cli-process.test.ts`. Full gate: `npm run typecheck && npm test`.


## Review residuals (Fable, 2026-09-30)

- **#8:** Handoff matching and record finding lookups still use quadratic scans in the worst case.
  Large ledgers can be slow; indexed joins and streaming need a later change. No 50k-record runtime
  bound is claimed.
- **#10:** The AICPA primary PDF and printed pages were read by Astra. Fable could not independently
  retrieve the mirror (403) or account-gated publisher download. Ryan should spot-check the cited
  pages; candidate evidence mappings and auditor acceptance remain [H].
- **#11:** Printed hooks still use the valid, tested shell command form. Moving to the documented
  exec/args form is deferred; existing POSIX quoting and hostile-path tests remain applicable.
