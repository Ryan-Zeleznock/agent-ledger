# Agent Ledger: local evidence demo

This demo shows **visibility, tamper-evident logging and best-effort gating on governed paths**.
It does not show server enforcement or establish SOC 2 compliance. A machine owner can bypass local
hooks or alter local evidence. The generated pack says this on its cover.

**Integration checkpoint:** use the reviewed, integrated Slice 1c checkout. Package A supplies the
five-event collector and `anchor`; Package B supplies this pack. Separate builder branches use
fixtures and do not establish the live demo. Ryan merges; the coordinator runs
`test/e2e-slice-1c.test.ts` after integration. Do not present fixture/direct-ledger records as
observed agent activity. This demo is **sandbox-only: never paste into real config**.

## 1. Build and create a disposable sandbox

From the integrated repo checkout, using the installed dependency set:

```sh
npm run check
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
and four direct hooks: PostToolUse, PostToolUseFailure, SessionStart and PermissionDenied —
**five events total**. SessionStart and PermissionDenied must not run under the watchdog.
Paths are absolute. Check the entry exists:

```sh
test -f "$LEDGER_DEMO_REPO/dist/hooks/watchdog-main.js"
```

If that test fails, stop: the integrated collector has not been built into this checkout.

## 3. Start Claude Code inside the sandbox

```sh
cd "$LEDGER_DEMO_DIR"
claude
```

Accept the sandbox project trust/configuration prompt as appropriate. Use normal interactive
permissions; do not use a bypass-permissions mode. The exact prompt UI depends on the installed
Claude Code version [H]; the adapter contract is pinned to the fixtures and spec in this repo.
Before the first prompt, the SessionStart hook writes a heartbeat. In a second terminal, inspect
only that health record in the sandbox ledger (the handler itself prints no stdout):

```sh
# Set LEDGER_DEMO_DIR to the same disposable sandbox path from the setup shell.
# Keep this terminal outside Claude; use the installed Node executable.
node -e 'const fs = require("node:fs"); for (const line of fs.readFileSync(process.argv[1], "utf8").trim().split("\n")) { if (!line) continue; const r = JSON.parse(line); if (r.policy.ruleId === "heartbeat:session-start") console.log(JSON.stringify({ id: r.id, session: r.call.agentSessionId, health: r.call.args })); }' "$LEDGER_DEMO_DIR/.agent-ledger/ledger/records.jsonl"
```

Show `watchdogCheck: "ok"`, the agent session id, interpreter, permission mode and the boolean
`nodeOptionsSet` (never the NODE_OPTIONS value). A heartbeat proves only that the SessionStart
hook reached the ledger; it does not prove every later call was hooked. If missing or unhealthy,
investigate before presenting the collector as healthy.

Tell the audience that the registry classifies **the entire Bash tool**, not regex guesses about a
particular command's harmlessness.

## 4. Approve one harmless Bash call

Ask Claude:

> Use Bash to run exactly `printf 'approved sandbox demo\n'`. Do not substitute another tool.

The registry classifies Bash as risky; the pipeline records an intent with `require_approval` and
`approval.decision = delegated`; the hook asks. **Approve this one call** in the terminal. Confirm
its output. The post hook should add an outcome `ok` (or `error` if actual execution failed).

The ledger does **not** record the terminal human as a named approver. The evidence is an ask followed
by observed execution. Do not describe `delegated` as a Slack-style recorded approval.

## 5. Deny a second harmless Bash call

Ask Claude:

> Use Bash to run exactly `printf 'denied sandbox demo\n'`. Make one attempt; do not retry if denied.

**Deny this one call** at the prompt. The intent should remain with a delegated ask and **no observed
outcome**. Claude Code permission denial does not fire PostToolUseFailure under the pinned contract.
The report labels this **"asked, no outcome observed"**. A manual denial fires no hook event:
cancellation, an interrupted session or lost telemetry looks the same. Only auto-mode denials
are recorded as `permission-denied:auto-mode`; this interactive demo does not exercise auto mode.
Explain the live denial using the visible terminal prompt, and show the report's honest wording.
No destructive command, real repository, network resource or customer data is needed.

Optional execution-error example: approve `exit 7` in Bash; PostToolUseFailure should record an error
outcome. This is an execution failure, not a permission denial. Exit Claude before exporting so no
new hook records arrive during verify/report.

## 6. Anchor, verify and export the evidence pack

Exit Claude first so no new hook records arrive during anchoring/export. In the original setup
shell, create the pack directory and preserve the command's printed JSON alongside the pack:

```sh
mkdir -p "$LEDGER_DEMO_DIR/evidence-pack"
"$LEDGER_DEMO_NODE" "$LEDGER_DEMO_REPO/dist/cli/main.js" anchor > "$LEDGER_DEMO_DIR/evidence-pack/anchor-result.json"
cat "$LEDGER_DEMO_DIR/evidence-pack/anchor-result.json"
"$LEDGER_DEMO_NODE" "$LEDGER_DEMO_REPO/dist/cli/main.js" verify
LEDGER_DEMO_VERIFY_CODE=$?
printf 'verify exit code: %s\n' "$LEDGER_DEMO_VERIFY_CODE"
```

Check `anchored: true` before continuing. Empty, changed or broken ledgers refuse anchoring;
a torn anchor file is an error. Expect verify **exit 0**, `chain.ok: true`, a nonzero checked count
and anchor status **`head`**. An `ancestor` status means records were added after anchoring;
those later records are unprotected by that saved anchor. Investigate errors rather than
present a failed chain as verified.

The anchor is a **local file editable by this machine's owner**. Save the exact canonical
`line` from `anchor-result.json` off-machine. For this demo, Ryan keeps the copy in the private
off-machine review repository alongside the exported pack (record the repository/commit in
the demo run note). Saving it only in the sandbox or on the same laptop is not independent
anchoring. This walkthrough does not upload anything automatically. Tail truncation is
detectable only relative to the saved copy you retain.

Choose UTC boundaries covering the session. For a demo on the task date:

```sh
"$LEDGER_DEMO_NODE" "$LEDGER_DEMO_REPO/dist/cli/main.js" report \
  --from 2026-10-01T00:00:00Z --to 2026-10-02T00:00:00Z \
  --out "$LEDGER_DEMO_DIR/evidence-pack"
open "$LEDGER_DEMO_DIR/evidence-pack/report.html"
```

Use the actual dates if running later. Report stdout includes `chain` and `anchor`; exit 1
with `chain.ok: false` means a diagnostic pack was written. `open` is the macOS opener;
elsewhere use the browser's Open File action. Existing pack files are never replaced; for
another export choose a fresh output directory. PDF and CSV links open the sibling files.

Walk these sections in order on the **real sandbox pack**:

1. `#summary` **Executive summary**: range, counts, observed head, chain PASS, anchor head/time,
   local-file warning, trust boundary and findings. A session without a heartbeat is a finding;
   do not infer that absence of findings proves complete hook coverage.
2. `#cc6-1` **CC6.1 logical access**: tool-intent identity, agent session, risk, verdict and rule.
   The heartbeat is not a tool authorization and does not appear in this table.
3. `#cc7-2` **CC7.2 monitoring**: the SessionStart row, watchdog/environment observations,
   missing-heartbeat sessions, orphan intent gaps and unreconciled handoffs. This Claude builtins
   demo should have no orphan outcomes or handoffs; investigate if it does.
4. `#cc8-1` **CC8.1 change management**: approved terminal Bash = `executed after ask`;
   manually denied Bash = `asked, no outcome observed`; optional `exit 7` = `execution error`.
   Read the exact denial caveat below the table. Other tool activity may add records, so do not
   promise an exact count. A terminal ask is not a named recorded approval.

Then open PDF to check the same section order, tables, page footers and per-record evidence.
CSV appends agent session id, evidence class and anchor status; heartbeat criteria are CC7.2 only.
The HMAC key is never in the pack. Shell commands appear as labeled withheld-argument digests;
allowlisted fields on other tools can remain readable. The [V] criterion scopes and [H] candidate
evidence mappings are supporting material for an auditor, not a generated audit opinion.

## Integration validation

```sh
cd "$LEDGER_DEMO_REPO"
npm run check
npx vitest run test/e2e-slice-1c.test.ts
```

The coordinator adds pack assertions (pins' e2e steps 8–10) after both package reviews and runs
that real-process integration test three times. Package B's `test/report-slice-1c.test.ts` covers
the interfaces with fixtures; it does not establish live Claude behavior. Only the integrated
sandbox run and these live steps establish the demo. Never modify a real agent config to test it.
