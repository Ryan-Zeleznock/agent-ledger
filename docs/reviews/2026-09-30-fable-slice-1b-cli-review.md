# Fable review of Slice 1b step B (Astra): CLI + SOC 2 evidence pack

Date: 2026-09-30. Reviewer: Fable (did not build this). Range: `git diff master..b693482` on `slice-1b-cli`.
Not committed; companion to the vault handoff `handoffs/2026-09-30-fable-to-astra-slice-1b-cli-review.md`.

## What I ran

- `npm run typecheck && npm test`: green, 25 files, 744 passed / 5 skipped. `npm run build`: green, `dist/cli/main.js` executable.
- Built CLI in a scratch dir (never `~/.claude`): `init` (perms, re-init refusal, nested `--dir`), `install-hooks --print`
  (and without `--print`), `verify` on empty/seeded ledgers, `hook --event pre|post` with empty stdin, the real
  Claude Code fixtures and an uninitialised `--dir`, `report` on empty/hostile/38-record ledgers plus reversed range,
  existing `--out`, `T24:00:00Z`, and date-only inputs.
- Hostile record content through a real JSONL ledger: agentId `=cmd|' /C calc'!A0`, onBehalfOf `\t+1-555`,
  declaredPlan with newline + `<img onerror>` + quotes/commas, args mixing HMAC strings, `-rf`, `@octo`, `+SUM(1)`,
  Unicode. Checked CSV cells, HTML, PDF.
- PDF: `pdftotext`/`pdfinfo` parse cleanly (1, 5 and 17 pages); Python check of `startxref`, every xref offset →
  `N 0 obj`, and every `/Length` → `endstream`.
- Claude Code hooks doc re-read for the snippet shape (see "install-hooks" below).

## Contract / pin conformance

- Pin 2: `init` creates `registry.yaml` (validated via `loadRegistry` on the shipped example, reviewers preserved,
  `proxy` dropped so Codex MCP is deny-by-default), `agents.yaml` (SHA-256 of the credential only), `credential`
  (0600), `hmac.key` (32 random bytes, 0600), `ledger/` (0700); dir 0700; `wx` flags; second `init` fails. Verified on disk.
- Pin 4: pre = stdin → `parseHookInput` → `toIncomingCall(ev, {kind:"local", value}, agent)` → `decide` →
  `formatPreToolUseOutput` on stdout, exit 0; any throw → exit 1. Post → `toOutcome` → `recordOutcome(tool_use_id, ...)`,
  no stdout, exit 0 even on failure (stderr only). Pipeline deps: `hook-ask`, `hookAgent`, `argsHmacKey` (Buffer),
  upstream stub that throws. Event/command mismatch is rejected. Correct.
- Pin 5: `tsconfig.build.json`, `npm run build`, `bin`. No new dependency added by Astra; see P2 #2 for `yaml`.
- Secret handling: `privateFile` opens `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, checks regular file, mode exactly 0600,
  owner uid, size cap; credential must be 64 hex; key must be exactly 32 bytes. Errors are fixed strings (test
  "secret-canary" confirms); usage errors print only the usage line. Nothing hashed or clear is echoed.
- Report: `generateReport` signature unchanged; `reconcileHandoffs` default grace = `HANDOFF_RECONCILE_GRACE_MS`,
  reads `[from, to + grace]`, flags in-range handoffs lacking a same-callId non-handoff MCP intent. HMAC values are
  rendered as "HMAC-SHA256 digest (argument withheld): <hex>" (digest shown, prefix relabelled; not a leak, key never
  read by report). Trust-boundary sentence on cover of HTML/PDF and in every CSV row. `ledger.append` never called;
  outputs `wx` 0600; head compared before/after read.

## install-hooks --print vs https://code.claude.com/docs/en/hooks (read 2026-09-30)

Doc: `hooks.<Event>` is an array of matcher groups; `matcher` `""`, `"*"` or omitted = match all; inner `hooks[]`
items need `type` + `command`; `timeout` is per-hook, in seconds (default 600); without `args` the command string
runs via `sh -c` in the current directory; `PostToolUseFailure` is a listed event matched on tool name; project
`.claude/settings.json` hooks are subject to workspace trust (DEMO mentions the prompt). The generated snippet:
three events, `matcher: ""`, `type: "command"`, `timeout: 30` (= `HOOK_TIMEOUT_S`), PreToolUse through
`dist/hooks/watchdog-main.js --agent claude-code --deadline-ms 25000 --timeout-s 30 -- <handler argv>` (pin 3
shape), Post/PostFailure direct, absolute `process.execPath` / `dist` / `--dir` paths, single-quote POSIX quoting with
bare tokens only for `[A-Za-z0-9_-]+`. Nothing is written (`stat(dir)` rejects in the unit test; confirmed in scratch).
Valid. Optional later improvement: the doc's exec form (`args` array, no shell) removes quoting from the picture.

## Findings

### P1

**1. Self-invocation guard drops the whole command through symlinks / aliased paths.** `src/cli/main.ts:197`:
`pathToFileURL(resolve(process.argv[1])).href === import.meta.url`. Node realpaths the ESM entry for `import.meta.url`
but leaves `process.argv[1]` as typed. Reproduced in scratch:
- `ln -s <repo>/dist/cli/main.js agent-ledger-link; node agent-ledger-link verify` → exit 0, no stdout, no stderr.
- npm-style `binx/agent-ledger` symlink: same.
- `node /tmp/<copy>/dist/cli/main.js verify` → exit 0, nothing; `node /private/tmp/<same>` → works (exit 3, JSON).
Failure scenarios: the documented `bin: agent-ledger` (npm installs a symlink) does nothing; `verify` returns 0,
which `src/cli/README.md` and `docs/DEMO.md` define as "chain passed and anchor matched": a false verification; `init`
and `report` silently no-op; a `hook post` registered through such a path silently records nothing and exits 0. Pre is
still fail-closed because the watchdog gets empty stdout (`output:empty` → deny). Also a DEMO trap: `LEDGER_DEMO_REPO="$PWD"`
under a symlinked checkout path breaks step 1 silently.
Fix: `import { realpathSync } from "node:fs"`; guard with
`try { run = realpathSync.native(resolve(process.argv[1])) === fileURLToPath(import.meta.url) } catch { run = false }`.
Add to `test/cli-process.test.ts`: run the built CLI via a symlink and via a `/tmp` path (macOS) and assert output.

### P2

**2. `yaml` is a devDependency but a runtime import of the CLI.** `package.json:15`. `dist/cli/main.js` → policy/identity
→ `src/config-file.ts` → `yaml`. Pre-existing placement, but shipping `bin` makes it a runtime requirement; an
`npm install --omit=dev` or a packed install fails at import for `init`/`hook`/`verify`/`report`. Pin 5 asks for
runtime-dependency changes to be flagged; this one should be moved to `dependencies` (coordinator decision, since it
touches the dependency list rather than scripts/bin).

**3. Post handler manufactures `WATCHDOG_DEADLINE_AT_ENV`.** `main.ts:161-170` sets the env to now + 25 s around
`createPipeline` for post events, then restores it. Needed because the frozen pipeline contract refuses decide-only
construction without a live deadline, and pin 4 registers post without the watchdog. Behaviour is correct today and the
README flags it, but it is an unrecorded interface assumption between the two halves: if the pipeline later validates
`WATCHDOG_DEADLINE_AT_ENV` against `WATCHDOG_DEADLINE_ENV` (duration) or against a watchdog-provided marker, post
recording breaks silently (exit 0, outcomes vanish). Ask: record as a pin / `_state.md` open question; preferred end
state is a pipeline construction path for recordOutcome-only use, agreed by ADR, with the shim removed.

**4. Test gaps.** (a) No test drives the CLI through a symlink or aliased path (would have caught #1). (b) No
event-mismatch test: `--event post` fed a PreToolUse event must exit 0 with stderr and no record; `--event pre` fed a
PostToolUse event must exit 1. (c) `stdin()`'s `MAX_STDIN_BYTES` cap is untested because every hook test injects
`stdin`; one process test with a >4 MiB stdin for `pre` (expect exit 1) would cover it. (d) The formula-injection test
uses only `=`; add `+`, `-`, `@` and leading tab/CR cases (the implementation handles them; the test should pin that).

### P3

5. `verify` (`main.ts:139`): `latest.hash === "0"` → `ancestor` → exit 0. A genesis anchor constrains no record, so exit
   0 ("anchor matched head or retained ancestor") overstates it. Map `"0"` to `missing` (exit 3).
6. `report` prints only paths and exits 0 when `verify.ok` is false. Include `chain: verify` in the stdout JSON (or a
   distinct exit code) so scripts and the demo notice a failed chain without opening the pack.
7. CLI range check (`main.ts:117`) accepts `2026-09-30T24:00:00Z` (V8 `Date.parse` allows 24:00); `checkedRange`
   then rejects it and the user gets the generic "command failed" (exit 1) instead of usage (exit 2). Reuse
   `checkedRange` for the CLI validation.
8. `render.ts:27-33` (`records.some` inside `filter`) and `render.ts:61` (`unobserved.includes(r)`) are O(n²) over the
   whole history; a 50k-record ledger turns the report into minutes. Build `Map<callId, ...>` indexes once.
9. `render.ts:53` uses a literal `60_000` and the vocabulary line at `render.ts:44` hard-codes "Grace: 60000 ms";
   use `HANDOFF_RECONCILE_GRACE_MS` (import the constant; the cycle is type-only today, so move the constant to
   `render.ts` and re-export from `contract.ts` if needed).
10. SOC 2 source (`src/report/README.md`): paraphrases of CC6.1/CC7.2/CC8.1 and the "2022 points of focus did not
    change the criteria" notice agree with the TSC text as quoted by secondary sources found today; I could not open the
    cited mirror (HTTP 403 to automated fetch) nor the AICPA download (account-gated), so the printed-page citations
    (33/39/44) remain verified by Astra only. Suggest Ryan spot-checks once, or the README says "read by Astra".
11. `install-hooks`: consider the exec form (`args`) in a later slice; shell form is valid and tested now.
12. DEMO.md is accurate against the code and the hook contract (25 s deadline / 30 s timeout, exit 3 semantics, denied
    ask = intent with no outcome, PostToolUseFailure not fired on permission denial). After #1 is fixed, add one line
    warning that the repo path must be the real path or that the fixed guard handles it.

## Verdict

GATE: FAIL (P1 #1). Everything else is P2/P3. Suggested verification scope for the next pass: #1 and its new tests,
#2 (dependency move or coordinator decision), #3 recorded as a pin/open question, #4(a)(b).
