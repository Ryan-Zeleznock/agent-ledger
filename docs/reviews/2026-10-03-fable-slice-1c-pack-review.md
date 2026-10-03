# Fable review of Slice 1c Package B (Astra): redaction P2, evidence pack, timing isolation, DEMO

Date: 2026-10-03. Reviewer: Fable (did not build this). Range: `git diff 1243ab6..3858ecd` on `slice-1c-pack`
(4 commits: `5096423` redaction, `f4b18da` report, `2a002b0` timing isolation, `3858ecd` DEMO). Worktree clean at HEAD.
Not committed; companion to the vault handoff `handoffs/2026-10-03-fable-to-astra-slice-1c-pack-review.md`.
Binding: `docs/slices/slice-1c-pins.md` (pins 6, 8, 9, 10, 11; acceptance bar B), ADR-010 (accepted).
Coordinator decision, not a finding: the `pipeline-init` helper / ADR-011 seam (Fable already did it on the other branch).

## What I ran

- `perl -e 'alarm shift; exec @ARGV' 900 npm test` twice, idle machine (run 2 overlapped with my probes). Both exit 0:
  unit phase 28 files, 975 passed / 7 skipped (7.3 s / 7.2 s); timing phase 2 files (`hooks-watchdog`,
  `ledger-redact-bench`), 77 passed (25.7 s / 25.8 s); wall 33.7 s each. No timing file appears in the unit phase;
  `test:timing` runs with `--no-file-parallelism --maxWorkers=1`. Nothing hung. Logs:
  `/private/tmp/claude-501/review-1c-pack/npm-test-run{1,2}.log`.
- Redaction probe on the compiled `.test-build/src/ledger/redact.js` (scratch only): 13 shapes (exact digest, trailing
  newline, uppercase scheme, uppercase hex, 63/65 hex, leading space, three placeholder shapes, uppercase placeholder,
  non-BMP suffix, Arabic-Indic digit) under `password`, in a `{name:"Authorization", value}` header object and in
  `["password", v]` / `["Authorization", v]` arrays; each checked for `redact(redact(x)) === redact(x)`.
- Hostile-record pack probe on `.test-build/src/report/contract.js` with a mock `LedgerStore`: every string field
  (agentId, sessionId, agentSessionId, ruleId, approver, args, heartbeat `source`/`interpreter`/`watchdogCheck`,
  outcome errorClass) = `=HYPERLINK("http://x")<script>alert(1)</script>"';\)(` + newline/CR/tab + `+1 @cmd -2` +
  a 64-hex `hmac-sha256:` digest + `é 😀 \u0000`; 48 records incl. heartbeat with bypass mode, deny-verdict + ok
  outcome, Slack-denied + ok outcome, blocked outcome with unknown errorClass; `context.anchor = ancestor`.
  Output in `/private/tmp/claude-501/review-1c-pack/pack-*/`.
- PDF checks: `pdfinfo` (poppler) parses: 81 pages, 792x612, PDF 1.4; Python-free Node check of `startxref` →
  `xref`, all 166 xref entries exactly 20 bytes, every `n` offset → `N 0 obj`, every `/Length` = stream bytes,
  `/Count` = `/Kids` = page objects = 81, zero non-ASCII bytes, all 3,086 `(…) Tj` strings parse with the test's
  reader; page 1 carries the trust-boundary sentence and the anchor line.
- Codex handoff probe: `handoff-to-proxy` intent + hook outcome with the same callId, no proxy record.
- DEMO.md checked line by line against pin 5 / pin 11 and the CLI source on this branch (`main.ts` paths,
  `realpathSync.native` guard, `HOOK_TIMEOUT_S = 30`, `DEFAULT_DEADLINE_MS = 25 s`, report exit-code table).

## Held (verified)

- **Pin 10** `src/ledger/redact.ts:39,476-477`: `isProtected` is exactly `/^hmac-sha256:[0-9a-f]{64}$/`; both object-pass
  uses redact every near miss (trailing `\n`, case, 63/65 hex, leading space, non-BMP suffix) and every placeholder shape to
  `[REDACTED:key:password]` / `[REDACTED:pair]`; exact lowercase digest survives both; idempotent in all 13 shapes.
  The value layer's `PLACEHOLDER_FULL` passes (lines 283, 306, 358, 420) are unchanged as pinned. New tests assert exactly this.
- **Pin 6** `src/report/contract.ts`: `AnchorStatus`, `ReportContext`, optional 4th parameter; 3-arg callers still valid.
- **Pin 8** `src/report/render.ts`: six `<section id>`s in order with the pinned titles, same titles/order in the PDF;
  `#summary` has range, generated, head, chain PASS/FAIL + checked, the anchor line for all five statuses + "not supplied
  to this report", each followed by "local file anchor, editable by this machine's owner", the trust sentence, all eight
  pinned counts, findings list / "No findings". `#cc6-1`, heartbeat, sessions-without-heartbeat, launch-warning (with the
  bypass sentence), orphan ("intent gap"), handoff and `#cc8-1` tables have the pinned columns verbatim. The nine
  `evidence_class` labels are produced byte-exact; the denial sentence matches pin 8 character for character and appears
  under the CC8.1 table and in `#legend` with the heartbeat sentence. Heartbeats: `policy.ruleId === "heartbeat:session-start"`
  (= A's `HEARTBEAT_RULE_ID`), excluded from CC6.1/CC8.1/no-outcome, CSV criteria `CC7.2` only. Heartbeat coverage uses
  the whole ledger history; pre-1c records labelled and never flagged. CSV: 25 original columns unchanged, then
  `agent_session_id, evidence_class, anchor_status`; `anomalies` gains `session without heartbeat` on the first tool record.
- **Secrets / display**: every record string reaches HTML through `esc(display(…))`, CSV through `csvCell(display(…))`,
  PDF through `wrap→ascii→escape`; no raw `hmac-sha256:` in any of the three files; the digest is always labelled
  "HMAC-SHA256 digest (argument withheld)". `<script>` never appears raw; zero CSV cells start with `= + - @` or
  whitespace/tab/CR/LF; PDF strings have balanced escaped parens/backslashes; the footer is static text only.
  Output files still `wx` + 0600, dir 0700, HTML written last.
- **Trust boundary**: `trust` sentence is the 7th line of the summary (page 1 of the PDF, top of the HTML); no
  enforcement claim; README and DEMO repeat it; anchor wording says "local file … editable" on every status.
- **Pin 9**: scripts as pinned; `vitest.config.ts` `maxWorkers: 2`; only the two pinned files moved, `../../src` imports
  fixed; watchdog test replaced the sandbox-refused `ps` with `process.kill(-pid, 0)` and now reaps owned/escapee groups
  on abort (two new regressions). 2/2 here + Astra's 3/3 solo and 3/3 concurrent (logged in `ledger.todo.md`).
- **Pin 11 / DEMO**: step order matches (build → init → print+paste 5 events → start Claude, show heartbeat → approve →
  deny with honest wording → optional `exit 7` → exit → `anchor` saved to the pack dir + off-machine copy → `verify`
  exit 0 `head` → `report` → walk the four sections); sandbox-only warning and "never paste into real config" kept;
  commands match pin 5 syntax; `records.jsonl`/`anchors.jsonl` paths, 25 s / 30 s, realpath claim and the report
  exit-1-with-diagnostic-pack claim all match the CLI source/README on this branch; the `node -e` argv index is right.
- **Todo files**: pin 10 and load-sensitivity items ticked with mechanism + vitest docs cited; `report.todo.md` lists the
  section/finding items; AICPA [V]/[H] kept; Ryan's spot-check still open.

## Findings

### P2

**#1 `src/report/render.ts:73-74` — the "executed" labels ignore a recorded deny.** `evidenceClass` tests
`o?.status === "ok"` first, so an intent with `policy.verdict === "deny"` followed by an `ok` outcome is labelled
`executed (allowed)`, and a Slack `denied`/`timeout` ask followed by an `ok` outcome is labelled `executed after ask`.
Repro (probe `rec-3`, `rec-4`): CSV `evidence_class` = `executed (allowed)` / `executed after ask`; no finding line.
That is the one record an auditor must see (gating said no, execution was observed: a bypassed hook, a runtime bug or an
edited ledger) and the pack says the policy allowed it. Only tampering or a bug produces it today, which is exactly
when the pack must not lie. Fix: check `verdict === "deny"` / `approval.decision ∈ {denied, timeout, unavailable, no-channel}`
before the `ok` branch, label it (pin 8 has no label: propose `executed despite deny` to the coordinator as a pin
amendment; until then `""` plus a summary finding `executed despite deny: <id>`), count it under findings, add fixtures
for both shapes to `test/report-slice-1c.test.ts`.

**#2 `src/report/render.ts:104-111` — orphan semantics regressed for Codex handoff outcomes.** 1b used every intent's
callId (`intentIds`); 1c fills `intents` from `isToolIntent` only (`!r.handoff`). A `governed-by-proxy` call's hook
outcome chains to its `handoff-to-proxy` intent (`src/pipeline/pipeline.ts:76`), so when the proxy record is absent
(proxy down, or a hook-side ledger) the outcome is now reported as **orphan outcome** on top of **unreconciled handoff**
(probe: findings `orphan outcome: rec-2; call call-1` + `unreconciled handoff: rec-1; call call-1`, "Orphan outcomes (1)").
That contradicts the pack's own vocabulary ("no preceding intent for their callId in available ledger history") and pin 8
("unreconciled handoffs (unchanged)"). Fix: register handoff intents too (`r.phase === "intent" && !isHeartbeat(r)`; the
later proxy record with the same callId overwrites the map entry, and `evidenceClass` already returns `""` for a handoff
intent), and add a test: handoff + outcome, no proxy → one unreconciled-handoff finding, zero orphans.

### P3

**#3 `src/ledger/redact.ts:442`** — the array header-pair pass still keeps any `[REDACTED:…]`-shaped value
(`["password", "[REDACTED:anything]"]` → unchanged) while an exact digest there becomes `[REDACTED:pair]`. Pin 10's letter
scopes the fix to the object pass, but its sentence "the ONLY exempt value … or a header-pair value" is not met for array
pairs. The charset `[a-z0-9:#_-]*` is unbounded, so a placeholder-shaped string can carry text. One-line fix:
`isProtected(x) || scheme ? x : PLACEHOLDER("pair")`, plus one test row.

**#4 `src/report/render.ts:80`** — a `blocked` outcome without a recognised cause yields `evidence_class = ""` (probe
`rec-5`). Documented in the README, but pin 8 says "exactly these labels"; an empty cell reads as a rendering gap.
Suggest `blocked, cause not recorded` as a pin amendment, or keep `""` and say so in `#legend`.

**#5 `src/report/pdf.ts:5`** — `wrap` runs after `ascii`, so a `\uXXXX` escape can straddle two lines (44 line ends in the
probe, e.g. `\u00` / `e9`). Still reconstructible by joining lines, but the README's "reversible `\uXXXX`" is weaker than
stated and a cell boundary can hide it. Fix: wrap on escaped-token boundaries (treat `\uXXXX` as one unit) or wrap first.

**#6 `test/report-slice-1c.test.ts:122`** — "unsplit record block" assertion (`page has record_id → page has received_at`)
passes even when a block is split, because another complete record on the same page supplies `received_at:`. Assert equal
counts of `record_id:` and `received_at:` lines per page. Also no test validates PDF structure (xref offsets, `/Length`,
`/Count`): a 10-line check like the one in this review would catch the next hand-written offset bug.

**#7 `src/report/render.ts:56`** — heartbeat discrimination is `ruleId` alone (as pinned). A registry rule id
`heartbeat:session-start` would make Bash intents vanish from CC6.1/CC8.1. Inside the trust boundary (owner-editable
registry), but cheap to tighten: also require `call.tool === "SessionStart"` and `server.startsWith("builtin:")`, and
report any record where they disagree.

**#8 `docs/DEMO.md:118-119`** — `mkdir -p evidence-pack` creates the pack directory with the shell umask (0755) before
`report` can create it 0700; the files stay 0600. Either create it via `report` first or `chmod 700` it; otherwise fine.

**#9 `package.json`** — `npm test` now runs `globalSetup` (the `.test-build` compile) twice; negligible today (~1 s) but
worth a note in `ledger.todo.md` so nobody "fixes" it by merging the phases back.

## Tests (checklist 6)

Each new test asserts its claim: section order in HTML and in `pdfText`; six anchor variants; exactly-one session finding
with the right id; pre-1c label; CC7.2-only via the quoted `"CC7.2"` cell; all nine labels in HTML and CSV; escaping in all
three outputs; repeated headers across pages; footer per page. Gaps: #1, #2 scenarios; #6 weakness; PDF structure.
Timing suites: stable 2/2 here under alarm, sequential, no hangs; the watchdog cleanup changes are test-only.

## Verdict

No P1. The pack is honest on the pinned surfaces, the escaping and PDF hold on hostile records, the timing split is
real and stable, DEMO matches pin 5. Fix #1 and #2 (both small, both testable) in the fix round; #3-#9 may become todo
items after the verification pass.

GATE: PASS
