# Agent Ledger: local evidence demo

This demo shows **visibility, tamper-evident logging and best-effort gating on governed paths**.
It does not show server enforcement or establish SOC 2 compliance. A machine owner can bypass local
hooks or alter local evidence. The generated pack says this on its cover.

**Dependency checkpoint:** build/init/print/verify/report and direct-ledger smoke tests work on Astra's
`slice-1b-cli` branch. The **live Claude Code steps 3–5 require Fable's hooks, pipeline, PIN-1 amendment
and `dist/hooks/watchdog-main.js`**, integrated and independently reviewed. Until then hooks/pipeline
throw `not implemented`; a missing watchdog cannot protect a call. Ryan merges the reviewed halves.
Do not present simulated/directly-written ledger records as observed agent activity.

## 1. Build and create a disposable sandbox

From the integrated repo checkout, using the installed dependency set:

```sh
npm run typecheck && npm test
npm run build
export LEDGER_DEMO_REPO="$PWD"
export LEDGER_DEMO_NODE="$(command -v node)"
export LEDGER_DEMO_DIR="$(mktemp -d /tmp/agent-ledger-demo.XXXXXX)"
cd "$LEDGER_DEMO_DIR"
"$LEDGER_DEMO_NODE" "$LEDGER_DEMO_REPO/dist/cli/main.js" init
```

The CLI resolves its entry path, including symlinked checkouts and macOS `/tmp` → `/private/tmp` aliases.
This creates `.agent-ledger/` in the sandbox only. The registry starts from the reviewed examples;
both agents' **Bash is risky**, so even harmless shell commands request approval. Bash command text
is withheld as an HMAC digest, not stored in cleartext. `init` refuses to replace an existing setup.
Keep the sandbox, keys and credential private; share the generated evidence pack, not the directory.

## 2. Print settings, then paste into this sandbox project

```sh
"$LEDGER_DEMO_NODE" "$LEDGER_DEMO_REPO/dist/cli/main.js" install-hooks --print
mkdir -p "$LEDGER_DEMO_DIR/.claude"
```

Copy the printed JSON into **`$LEDGER_DEMO_DIR/.claude/settings.json`** with an editor. This is the
sandbox project's settings file. Never paste it into `~/.claude/settings.json`, `~/.codex`, a real
project, or any global configuration. The CLI prints only; it never writes any agent settings.

The snippet contains PreToolUse through the watchdog (25-second deadline; 30-second agent timeout),
and direct PostToolUse and PostToolUseFailure hooks. Paths are absolute. Check the entry exists:

```sh
test -f "$LEDGER_DEMO_REPO/dist/hooks/watchdog-main.js"
```

If that test fails, stop the live demo here: Fable's half has not been built into this checkout.

## 3. Start Claude Code inside the sandbox (requires Fable)

```sh
cd "$LEDGER_DEMO_DIR"
claude
```

Accept the sandbox project trust/configuration prompt as appropriate. Use normal interactive
permissions; do not use a bypass-permissions mode. The exact prompt UI depends on the installed
Claude Code version [H]; the adapter contract is pinned to the fixtures and spec in this repo.
Tell the audience that the registry classifies **the entire Bash tool**, not regex guesses about a
particular command's harmlessness.

## 4. Approve one harmless Bash call (requires Fable)

Ask Claude:

> Use Bash to run exactly `printf 'approved sandbox demo\n'`. Do not substitute another tool.

The registry classifies Bash as risky; the pipeline records an intent with `require_approval` and
`approval.decision = delegated`; the hook asks. **Approve this one call** in the terminal. Confirm
its output. The post hook should add an outcome `ok` (or `error` if actual execution failed).

The ledger does **not** record the terminal human as a named approver. The evidence is an ask followed
by observed execution. Do not describe `delegated` as a Slack-style recorded approval.

## 5. Deny a second harmless Bash call (requires Fable)

Ask Claude:

> Use Bash to run exactly `printf 'denied sandbox demo\n'`. Make one attempt; do not retry if denied.

**Deny this one call** at the prompt. The intent should remain with a delegated ask and **no observed
outcome**. Claude Code permission denial does not fire PostToolUseFailure under the pinned contract.
The report therefore cannot prove the user's denial: cancellation or lost telemetry looks the same.
Explain the live denial using the visible terminal prompt, and show the report's honest wording.
No destructive command, real repository, network resource or customer data is needed.

Optional execution-error example: approve `exit 7` in Bash; PostToolUseFailure should record an error
outcome. This is an execution failure, not a permission denial. Exit Claude before exporting so no
new hook records arrive during verify/report.

## 6. Verify and export the evidence pack

In the same shell after Claude exits:

```sh
"$LEDGER_DEMO_NODE" "$LEDGER_DEMO_REPO/dist/cli/main.js" verify
LEDGER_DEMO_VERIFY_CODE=$?
printf 'verify exit code: %s\n' "$LEDGER_DEMO_VERIFY_CODE"
```

Expect `chain.ok: true` and a nonzero checked count after the live steps. **Exit 3 is expected when
no non-genesis local anchor exists**: it means the chain passed, but no saved anchor was available to check tail
truncation. Exit 1 is a verification/configuration failure; investigate before continuing. Exit 0
means an existing anchor also matched the head or a retained ancestor. The CLI never writes an
anchor just to make verification pass; periodic/independent anchoring is not wired in this slice.

Choose UTC boundaries covering the session. For a demo on the task date:

```sh
"$LEDGER_DEMO_NODE" "$LEDGER_DEMO_REPO/dist/cli/main.js" report \
  --from 2026-09-30T00:00:00Z --to 2026-10-01T00:00:00Z \
  --out "$LEDGER_DEMO_DIR/evidence-pack"
open "$LEDGER_DEMO_DIR/evidence-pack/report.html"
```

Report stdout includes `chain`; exit 1 with `chain.ok: false` means a failed-chain diagnostic pack
was written. Investigate it before presenting the evidence as verified.

Use the actual dates if running later. `open` is the macOS opener; elsewhere use the browser's Open
File action. For another export, choose a new output directory: existing pack files are never
replaced. PDF and CSV links in the HTML open the other two files in the same directory.

Show the cover trust boundary and full-ledger verify result first. Then show CC6.1 identity/policy,
CC7.2 chain links and anomaly sections, and CC8.1 asks/approvals/denials for candidate change evidence.
Expect the unreconciled-handoff section to be empty in this Claude builtins demo. There should be no
orphan outcomes in a healthy run. The denied terminal attempt appears among intents with no observed
outcome. Other Claude tool activity may add records; do not promise an exact count.

The pack does not include the HMAC key. The shell command is a labeled withheld-argument digest;
allowlisted identifying fields on other tools can be readable. It is supporting evidence for an
auditor to assess [H], not a generated audit opinion.

## Smoke test before Fable's integration

```sh
cd "$LEDGER_DEMO_REPO"
npx vitest run test/cli.test.ts test/cli-process.test.ts test/report.test.ts
```

The process test builds `dist`, initializes temporary directories, writes a real JSONL ledger directly
with `createLedger("jsonl", ...)`, checks anchors/verification, and reads all three exports. It also
checks malformed pre/post failure behavior. It does **not** prove that live Claude hooks work; only
steps 3–5 on the integrated implementation establish that part of the demo.
