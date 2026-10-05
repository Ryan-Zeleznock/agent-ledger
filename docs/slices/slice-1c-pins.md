# Slice 1c: demo-ready evidence pack. Work split and interface pins (architect, 2026-10-01)

Goal (Ryan, 2026-10-01): the pack is what Gate 2 sells (a $1k+ hand-built evidence pack by 2026-10-25), and the demo
ends cleanly: `anchor` → `verify` exit 0 → `report` with an executive summary and per-criterion tables that carry the
new anchor, heartbeat and denial evidence, all inside the ADR-007 trust boundary (local = visibility + tamper-evident
logging + best-effort gating). Master `22225bf` (tag `slice-1b`). Format follows `slice-1b-pins.md`.

Both builders code against these pins. Neither edits the other's folders. If a pin is wrong, STOP and say so in your
final report; do not silently diverge. Items marked **ADR-010** / **ADR-011** change a frozen contract and are
implemented only after Ryan accepts the ADR (`~/Desktop/AgentLedger/decisions/`). Everything else is buildable now.

## 0. Due-diligence findings this slice is designed around

All read on **2026-10-01** from the primary docs. Quotes are verbatim.

**Claude Code hooks reference, https://code.claude.com/docs/en/hooks**
- A user's manual denial at the permission prompt fires NO hook event. `PermissionDenied`: "Runs when auto mode denies
  a tool call … This hook only fires in auto mode: it doesn't run when you manually deny a permission dialog, when a
  `PreToolUse` hook blocks a call, or when a `deny` rule matches." `PostToolUseFailure`: "Permission denials fire
  `PreToolUse` but not this event; see PermissionDenied." `PermissionRequest` "Runs when Claude Code is about to ask you
  for permission" and its input arrives "like PreToolUse hooks, but without `tool_use_id`"; it carries the question, not
  the answer. `Notification` `permission_prompt` fires only after "the prompt has waited about six seconds", carries no
  decision and no `tool_use_id`. `Stop` input is `stop_hook_active`, `last_assistant_message`, `background_tasks`,
  `session_crons`: no permission decisions. **Verdict: the demo's manual denial is unobservable; the report wording
  stays honest (pin 8) and no build item may claim otherwise.**
- `PermissionDenied` IS observable for **auto mode**: "PermissionDenied hooks receive `tool_name`, `tool_input`,
  `tool_use_id`, and `reason`"; exit code and stderr "are ignored because the denial already occurred". `tool_use_id`
  lets it chain to our intent record → build item (pin 2, pin 5), fires only in auto mode, never in the demo.
- `SessionStart`: "Runs when Claude Code starts a new session or resumes an existing session." Input: common fields
  (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, optional `permission_mode`, `prompt_id` "Absent until the
  first user input") plus "`source` and optionally `model`, `agent_type`, and `session_title`"; `source` ∈ `startup`,
  `resume`, `clear`, `compact`, `fork`. "Only `type: "command"` and `type: "mcp_tool"` hooks are supported." Exit 2
  "Shows stderr to user only" and the session proceeds. **Trap:** "`SessionStart` … where Claude Code adds plain-text
  stdout as context that Claude can see and act on" → the heartbeat handler must write NOTHING to stdout.
  Hooks "run in the background. You can type right away … Claude's first response still waits for the hooks to finish".
- `permission_mode` values: `"default"`, `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`;
  "Not all events receive this field."

**Codex hooks, https://learn.chatgpt.com/docs/hooks (2026-10-01)**
- `SessionStart` exists: `source` is "`startup`, `resume`, `clear`, or `compact`"; common fields `session_id`,
  `transcript_path` (nullable), `cwd`, `hook_event_name`, `model`, plus `permission_mode` (no `turn_id`: it is
  turn-scoped). Same trap: "Plain text on `stdout` is added as extra developer context." Cheap → included (pin 2).
- `PermissionRequest` under Codex fires before the prompt and has no `tool_use_id`; there is no `PermissionDenied`.
  Codex denials remain as spec §6 says (not adopted).

**Record shape gap found in our own code.** Tool records carry OUR per-process `call.sessionId`
(`identity.startSession` runs once per hook process), not the agent's `session_id`. The spec §7 check "a session with
tool calls and no heartbeat" cannot be computed per agent session without a field for it. Keeping the frozen shape would
make the check silently weak (a session that never heartbeated is invisible whenever any other session did), which the
architect brief treats as a silent-failure mode → **ADR-010** adds `agentSessionId?` (pin 1). If Ryan rejects it, the
fallback is a per-ledger ordering check ("tool records before the first heartbeat"), labelled as such in the report.

## Ownership (disjoint)

- **Package A, Fable (Claude Code), role brief `.claude/agents/backend-builder.md`** (branch `slice-1c-collector`,
  worktree `~/agent-ledger-fable`): `src/types/**` (ONLY the ADR-010 amendment in pin 1), `src/hooks/**`,
  `src/pipeline/**`, `src/cli/**` (handlers, `anchor`, `install-hooks --print`, README), `src/ledger/validate.ts`
  (ONLY the one-field amendment in pin 4; no other ledger file), `test/fixtures/claude-code-sessionstart.json`,
  `test/fixtures/claude-code-permissiondenied.json`, `test/fixtures/codex-sessionstart.json`, `test/hooks-collector.test.ts`,
  `test/hooks-fixtures.test.ts`, `test/pipeline*.test.ts`, `test/cli*.test.ts`, `test/types.test.ts`,
  `test/e2e-slice-1c.test.ts` (new; its half, see "Integration"), `test/todo/hooks.todo.md`, `test/todo/pipeline.todo.md`,
  `test/todo/anchor.todo.md`. A does NOT touch `test/hooks-watchdog.test.ts` this slice (B moves it, pin 9).
- **Package B, Astra (Codex), role briefs `frontend-builder.md` (report), `ledger-engineer.md` (redaction),
  `test-engineer.md` (timing isolation)** (branch `slice-1c-pack`, worktree `~/agent-ledger-astra`): `src/report/**`,
  `src/ledger/redact.ts` + `src/ledger/README.md`, `test/report*.test.ts`, `test/ledger*.test.ts`, `test/timing/**`
  (new), `vitest.config.ts`, `package.json` (scripts only), `docs/DEMO.md`, `test/todo/report.todo.md`,
  `test/todo/ledger.todo.md`.
- **Nobody touches:** `docs/spec.md`, `src/anchor/**`, `src/identity/**`, `src/policy/**`, `policies/**`, other modules'
  implementations, `~/.claude`, `~/.codex`, any real agent config.

## Pin 1: `src/types` amendment (A writes; **ADR-010**)

```ts
// IncomingCall and ToolCall each gain ONE optional field (the agent runtime's own session id, verbatim from the hook
// event's `session_id`; absent in proxy mode where no hook event exists):
agentSessionId?: string;
// Heartbeat facts, stored as `call.args` of the heartbeat record (pin 7). Our own observations, never agent-supplied
// text (ADR-009's "no clear args for unreviewed tools" is about tool arguments; this is not a tool call).
export interface SessionHeartbeat {
  agentSessionId: string;                        // hook event session_id
  hookAgent: HookAgent;                          // "claude-code" | "codex"
  source: string;                                // startup | resume | clear | compact | fork (Claude Code); no fork under Codex
  permissionMode?: string;                       // the event's permission_mode when present, verbatim
  interpreter: string;                           // realpath of process.execPath of the handler
  nodeOptionsSet: boolean;                       // NODE_OPTIONS non-empty in the handler's env; the VALUE is never stored
  watchdogCheck: "ok" | "missing" | "failed";    // pin 5: the self-test result
}
export const HEARTBEAT_TOOL = "SessionStart" as const;             // call.tool of a heartbeat record
export const HEARTBEAT_RULE_ID = "heartbeat:session-start" as const; // policy.ruleId; the report's discriminator
export const HEARTBEAT_REASON = "agent-ledger: session heartbeat written by the SessionStart hook; a health record, not a tool decision" as const;
export const PERMISSION_DENIED_ERROR_CLASS = "permission-denied:auto-mode" as const; // Outcome.errorClass, pin 7
```
Nothing else in `src/types` changes. `Phase`, `LedgerRecord`, `Outcome`, `HookDecision` are untouched.

## Pin 2: hooks module (A)

- `HOOK_EVENT_NAMES` becomes `["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "PermissionDenied"]`;
  `CODEX_HOOK_EVENT_NAMES` becomes `["PreToolUse", "PostToolUse", "SessionStart"]`. New event interfaces:
  `SessionStartEvent` (common fields + `source: string`, optional `model`, `agent_type`, `session_title`, and the four
  optional resume-cost fields, tolerated not stored), `PermissionDeniedEvent` (tool fields + `tool_use_id` + `reason`),
  `CodexSessionStartEvent` (Codex common fields + `source`, `permission_mode`). `parseHookInput` accepts them with the
  same strictness rules as today (`model`/`turn_id` rejected under claude-code, etc.). `tool_use_id` is NOT required for
  SessionStart (the current parser requires it for every event; fix that branch).
- `toIncomingCall(ev, cred, agent)` sets `agentSessionId = ev.session_id`. Nothing from the event reaches `args`.
- New `toHeartbeat(ev: AnySessionStartEvent, agent: HookAgent, probe: HeartbeatProbe): SessionHeartbeat` where
  `HeartbeatProbe = { interpreter: string; nodeOptionsSet: boolean; watchdogCheck: SessionHeartbeat["watchdogCheck"] }`
  is supplied by the CLI (pin 5); the function only maps fields. The NODE_OPTIONS value, `transcript_path`, `cwd`,
  `model`, `session_title` never appear in the result.
- `toOutcome(ev, agent)` for `PermissionDenied` → `{ status: "blocked", errorClass: PERMISSION_DENIED_ERROR_CLASS }`.
  The event's `reason` text is display text and is not stored (same rule as PostToolUseFailure's `error`).
- Fixtures composed from the docs' JSON examples and pinned by `test/hooks-fixtures.test.ts`.
- Watchdog code (`watchdog.ts`, `watchdog-main.ts`) is unchanged; SessionStart/PermissionDenied handlers never run under it.

## Pin 3: pipeline (A; **ADR-010** for the new method)

- `Pipeline` gains `recordHeartbeat(hb: SessionHeartbeat): Promise<void>`: `identity.resolveAgent(credential)` →
  `startSession` → append ONE intent record encoded as pin 7. Unknown agent → throw (the handler exits 0 silently with a
  stderr line; nothing to attribute). A failed append → throw (caller logs to stderr; SessionStart cannot block anyway).
- The ToolCall projection list becomes `callId, sessionId, agentId, agentSessionId?, onBehalfOf?, declaredPlan?, server,
  tool, args, receivedAt` (still never a spread).
- `recordOutcome` is unchanged and already accepts `status: "blocked"`.
- Construction for non-deciding handlers (`post`, `session-start`, `denied`) keeps the 1b shim (the CLI sets
  `AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS` for construction only) unless Ryan accepts **ADR-011**, in which case A moves
  the deadline check from `createPipeline` into `decide()` (deny when missing/past) and deletes the shim.

## Pin 4: ledger validator, one field (A edits `src/ledger/validate.ts` only for this; B never touches that file)

`projectToolCall` accepts optional `agentSessionId` (string, `MAX_SCALAR_CHARS`) in both modes. Today lenient append
DROPS unknown fields and strict read REJECTS them, so without this edit the field would vanish silently and the
heartbeat/session checks would compute on nothing. A pins the round trip in `test/pipeline.test.ts` against the real
jsonl ledger (append → read → `call.agentSessionId` present → `verify()` ok). The hash chain rule is unchanged.

## Pin 5: CLI (A)

```text
agent-ledger init [--dir d]
agent-ledger hook --agent claude-code|codex --event pre|post|session-start|denied [--dir d]
agent-ledger anchor [--dir d]
agent-ledger verify [--dir d]
agent-ledger report --from RFC3339 --to RFC3339 --out directory [--dir d]
agent-ledger install-hooks --print [--dir d]
```
- `hook --event session-start`: stdin → `parseHookInput` (must be SessionStart) → probe: `interpreter =
  realpathSync(process.execPath)`, `nodeOptionsSet = (process.env.NODE_OPTIONS ?? "") !== ""`, `watchdogCheck` = run
  `node <dist>/hooks/watchdog-main.js --agent <agent> --deadline-ms 1000 --timeout-s 3 -- <node> -e '<prints one valid
  allow line>'` with a 3 s cap: exit 0 + validated allow → `"ok"`; ENOENT on the watchdog file → `"missing"`; anything
  else → `"failed"` → `toHeartbeat` → `pipeline.recordHeartbeat`. **Prints nothing on stdout, ever** (it would become
  Claude's context); errors go to stderr; exit 0 always, like `post`. Registered WITHOUT the watchdog.
- `hook --event denied`: stdin → parse (must be PermissionDenied) → `toOutcome` → `recordOutcome(tool_use_id, …)`.
  Silent, exit 0 always, WITHOUT the watchdog. Claude Code only (`--agent codex` + `denied` → usage error, exit 2).
- `anchor`: `before = ledger.head()`; `chain = ledger.verify()`; refuse (exit 1, JSON `{ anchored: false, reason:
  "chain-failed" | "empty-ledger" | "ledger-changed", chain }`) when `!chain.ok`, when `before === "0"`, or when the
  head changed during verify. Otherwise `createAnchor("file", <dir>/anchors.jsonl).write({ hash: before, at: new
  Date().toISOString() })` and print ONE JSON line `{ anchored: true, entry: { hash, at }, line: "<the canonical JSON
  line appended>", previous: <AnchorEntry | null>, chain, path: "<abs anchors.jsonl>", note }` where `note` says: the
  anchor is a local file the machine's owner can edit; copy `line` off-machine (git, e-mail, S3) for it to mean
  anything; it detects tail truncation only relative to the copy you keep. Exit 0. A torn anchor file → exit 1 (the
  anchor module throws; never truncate). `anchor` never changes the ledger. Re-anchoring the same head appends a new
  line on purpose (time series).
- `verify`: unchanged semantics; after `anchor`, status `head` → exit 0; after further records, `ancestor` → exit 0.
- `report`: computes `anchor: { status, latest }` exactly as `verify` does (factor the status logic into one function in
  `src/cli/`), then calls `generateReport(ledger, range, outDir, { anchor })` (pin 6). Stdout JSON gains `anchor`.
- `install-hooks --print` adds `SessionStart: entry(handler("session-start"))` (matcher `""`, timeout HOOK_TIMEOUT_S)
  and `PermissionDenied: entry(handler("denied"))`, both direct (no watchdog), same quoting and absolute paths.
- Exit-code table in `src/cli/README.md` gains `anchor` and the two handlers. Every new handler keeps the 1b rule: the
  stderr text never echoes parser/registry exception text.

## Pin 6: report contract (B defines; A passes; **ADR-010**)

```ts
// src/report/contract.ts
export type AnchorStatus = "head" | "ancestor" | "missing" | "mismatch" | "untrusted";   // the CLI verify vocabulary
export interface ReportContext { anchor?: { status: AnchorStatus; latest: { hash: string; at: string } | null } }
export function generateReport(ledger: LedgerStore, range: DateRange, outDir: string, context?: ReportContext): Promise<ReportFiles>;
```
The 4th parameter is optional, so every existing caller stays valid. `ReportFiles` is unchanged. Until integration, A
declares a structurally identical local `ReportContext` in `src/cli/main.ts` (comment `// pin 6`) and types
`CliDeps.generateReport` with the 4-parameter signature (TypeScript accepts the 3-parameter implementation); integration
replaces the local type with the import. B renders "Anchor: not supplied to this report" when `context.anchor` is absent.

## Pin 7: record encodings (both code against these; A writes, B reads)

**Heartbeat record** (one per SessionStart event; `phase: "intent"`, never an outcome):
```json
{ "phase": "intent",
  "call": { "callId": "heartbeat:<uuid>", "sessionId": "<ours>", "agentId": "<resolved>", "agentSessionId": "<event session_id>",
            "server": "builtin:claude-code" | "builtin:codex", "tool": "SessionStart",
            "args": { "agentSessionId": "...", "hookAgent": "claude-code", "source": "startup", "permissionMode": "default",
                      "interpreter": "/usr/local/bin/node", "nodeOptionsSet": false, "watchdogCheck": "ok" },
            "receivedAt": "<RFC3339>" },
  "policy": { "verdict": "allow", "risk": "read", "ruleId": "heartbeat:session-start", "reason": "<HEARTBEAT_REASON>" } }
```
`args` is stored in the clear (not through `projectArgs`); the ledger redactor still runs on it (paths are not secrets;
the NODE_OPTIONS value is never present). Report discriminator (coordinator review fix #7, 2026-10-03): `policy.ruleId === "heartbeat:session-start"` plus `call.tool === "SessionStart"` and a `builtin:` server; disagreements remain tool evidence and are findings.

**Tool records** gain `call.agentSessionId` (pin 1). Records written before 1c lack it → B labels them "pre-1c, no
agent session id" and never counts them as a session without heartbeat.

**Auto-mode denial outcome**: `recordOutcome(tool_use_id, { status: "blocked", errorClass: "permission-denied:auto-mode" })`,
chained to the intent with that callId (an unknown callId is an orphan outcome, as today).

## Pin 8: report sections, wording, CSV and PDF (B)

amended 2026-10-03 (coordinator): add `executed despite deny` for an `ok` outcome after policy deny or denied/timeout/unavailable/no-channel approval; list every such record in summary findings and CC7.2 anomalies.

HTML `<section id>`s and headings, in this order; the PDF carries the same titles in the same order; every claim maps to
records, a cited criterion ([V] scope / [H] mapping, as today) or the chain/anchor result; no marketing copy:
1. `#summary` **Executive summary**: range, generated at, observed head, chain PASS/FAIL + checked count, **anchor
   line** from `ReportContext` ("Anchor: head anchored at <at>" / "ancestor anchored at <at>: records after it are
   unprotected" / "no anchor" / "MISMATCH" / "not supplied to this report"; always followed by "local file anchor,
   editable by this machine's owner"), the trust-boundary sentence, counts (agent sessions seen; heartbeats; tool intents
   by risk; asks; recorded approvals; recorded denials by cause; outcomes ok/error; no outcome observed) and a findings
   list (one line each, or "No findings").
2. `#cc6-1` **CC6.1 logical access**: table `written_at | agent_session_id | agent_id | server/tool | risk | verdict |
   rule_id` over tool intents (heartbeats excluded).
3. `#cc7-2` **CC7.2 monitoring**: chain result; anchor status; **heartbeat table** `written_at | agent_session_id |
   source | permission_mode | watchdog_check | node_options_set | interpreter`; **findings tables**: sessions without
   heartbeat (`agent_session_id | first_tool_record | tool_records`; a session = distinct `call.agentSessionId` with ≥1
   tool intent and no heartbeat record for the same id anywhere in ledger history), launch-environment warnings
   (`watchdogCheck !== "ok"`, `nodeOptionsSet`, `permissionMode ∈ {bypassPermissions, dontAsk}`: informational, with the
   sentence that a bypass-mode session produces no asks), orphan outcomes (labelled "intent gap" when the session has
   a heartbeat), unreconciled handoffs (unchanged).
4. `#cc8-1` **CC8.1 change management**: table over write/risky/unreviewed intents `written_at | agent_session_id |
   server/tool | risk | approval (decision, approver) | outcome (status, errorClass) | evidence_class` with exactly these
   `evidence_class` labels: `executed despite deny` · `executed after ask` · `executed (allowed)` · `execution error` · `denied by policy` ·
   `denied: no channel` · `denied: Slack <approved|denied|timeout|unavailable>` · `denied: auto mode` ·
   `asked, no outcome observed` · `allowed, no outcome observed`. Directly under the table, verbatim: **"A manual denial
   at the Claude Code permission prompt fires no hook event (Claude Code hooks reference, read 2026-10-01), so 'asked, no
   outcome observed' cannot distinguish a user's denial from a cancelled call, an interrupted session or lost
   telemetry. Only auto-mode denials are recorded (`permission-denied:auto-mode`)."**
5. `#records` **Record evidence** (the existing per-record blocks, unchanged content).
6. `#legend` **Vocabulary** (existing sentences, plus the denial sentence and "heartbeat = the SessionStart hook ran
   and could reach the ledger; it does not prove every later call was hooked").
CSV: existing columns unchanged and in order; append `agent_session_id`, `evidence_class`, `anchor_status` at the END.
Heartbeat rows map to `CC7.2` only; `anomalies` gains `session without heartbeat` on the first tool record of such a
session. PDF: still dependency-free Courier text (no new runtime dependency), but headings in a larger font size, tables
as aligned monospace columns with the header row repeated on each page, footer `Agent Ledger evidence pack · page N / M ·
chain PASS|FAIL`, no record block split across pages when it fits on one. Escaping rules (HTML, CSV formula prefix, PDF
string escapes, `hmac-sha256:` display label) are unchanged and re-tested on the new tables.

## Pin 9: test layout and `npm test` stability (B, test-engineer brief)

- `git mv test/ledger-redact-bench.test.ts test/timing/` and `git mv test/hooks-watchdog.test.ts test/timing/` (fix the
  relative `../src` imports; the `.test-build/...` paths are cwd-relative and unchanged). Nothing else moves without a
  recorded flake (3 runs, durations in the report).
- `package.json` scripts: `test:unit` runs everything under `test/` except `test/timing/**`; `test:timing` runs
  `test/timing/**` with file parallelism OFF and one worker; `test` = `test:unit` then `test:timing`; `check` is
  unchanged (`typecheck && test && build`). Mechanism is B's call (vitest 4.1.11 `--exclude`/`--dir`/projects), verified
  against the vitest docs and cited in `test/todo/ledger.todo.md` when ticking the item.
- Acceptance: `npm test` green 3/3 while a second `npm test` runs concurrently in a copy of the checkout.

## Pin 10: redaction P2 (B, ledger-engineer brief; closes `test/todo/ledger.todo.md` item)

`src/ledger/redact.ts` key layer (the two `isProtected` uses in the object pass): the ONLY exempt value under a
sensitive key or a header-pair value is one matching exactly `/^hmac-sha256:[0-9a-f]{64}$/`. A value shaped like a
placeholder (`[REDACTED:pair]`, `[REDACTED:anything]`) under `password` becomes `[REDACTED:key:password]`. The value
layer's own placeholder passes (`PLACEHOLDER_FULL` in the tokeniser) are unchanged. Tests: the new case, plus the existing
idempotence tests still pass (`redact(redact(x))` equals `redact(x)`: a key placeholder is a deterministic function of
the key, so it converges in one pass; the test proves it on a header object and on a nested sensitive key).

## Pin 11: docs

- A: `src/cli/README.md` (commands, exit codes, the no-stdout rule for session-start, anchor honesty note),
  `src/hooks/README.md`, `src/pipeline/README.md` (sources + date for every new external fact).
- B: `docs/DEMO.md` step order becomes: build → init → print + paste (now 5 events) → start Claude (the heartbeat lands
  before the first prompt; show it) → approve one Bash → deny one Bash (show the honest wording) → optional `exit 7` →
  exit Claude → **`anchor`** (save the printed JSON into the pack directory and say where the off-machine copy goes) →
  `verify` (expect exit 0, status `head`) → `report` → walk `#summary`, `#cc6-1`, `#cc7-2`, `#cc8-1`. Keep the
  sandbox-only warning and "never paste into real config".

## Gates for both

`npm run typecheck && npm test` green before every commit; test-first; tick the todo items you covered; keep README
`Status: implemented`; commit on your branch only; never merge; never touch `~/.claude`, `~/.codex` or a real project.
No new runtime dependency without flagging it. Reviews follow the Build loop: one full cross-review (A reviews B's
range, B reviews A's), fix, one scoped verification pass.

## Acceptance bar

**Package A**
- Tests: SessionStart/PermissionDenied/Codex-SessionStart fixtures parse; `toHeartbeat` maps exactly the pinned fields
  and nothing else (assert the NODE_OPTIONS value and `transcript_path` are absent); `toOutcome(PermissionDenied)`;
  `agentSessionId` on `toIncomingCall` and in the pipeline's projection; `recordHeartbeat` writes pin 7 through the real
  jsonl ledger, `verify()` ok, read-back carries `agentSessionId`; `recordOutcome` chains the auto-mode denial to its
  intent; real-process CLI: `hook --event session-start` prints NOTHING on stdout and exits 0 (also on a corrupt registry,
  a missing key, a missing watchdog → `watchdogCheck: "missing"`); `anchor` on an empty ledger → exit 1 `empty-ledger`;
  on a broken chain → exit 1 `chain-failed`, no line written; healthy → exit 0, one canonical line, `verify` exit 0
  `head`; one more record → `verify` exit 0 `ancestor`; `install-hooks --print` has 5 events and every path exists.
- Todo: `hooks.todo.md` heartbeat item ticked (report half noted as B's); `anchor.todo.md` gains and ticks "CLI anchor
  refuses broken/empty/changed"; `pipeline.todo.md` gains `recordHeartbeat` + `agentSessionId` items, ticked.
- Demo steps that must work: DEMO 2 (5-event snippet), 3 (heartbeat record appears), 6 (`anchor` then `verify` exit 0).

**Package B**
- Tests: every section id present and ordered in HTML, same titles ordered in `pdfText`; anchor line for each of the five
  statuses and for "not supplied"; a fixture ledger with two agent sessions (one with heartbeat, one without) → exactly
  one "session without heartbeat" finding naming the right id; pre-1c records (no `agentSessionId`) are never flagged;
  heartbeat rows → `CC7.2` only, excluded from "no outcome observed" and from CC8.1; each `evidence_class` label produced
  by a fixture record; the verbatim denial sentence present in HTML and PDF; CSV columns appended in order; escaping
  tests re-run on the new tables; redaction pin 10 cases; `npm test` structure (pin 9) with the 3/3 concurrent-run log.
- Todo: `ledger.todo.md` P2 and load-sensitivity items ticked with the mechanism cited; `report.todo.md` gains the
  section/finding items, ticked. AICPA citations keep [V]/[H] labels; Ryan's spot-check stays an open question.
- Demo steps: DEMO 6 walk-through of the four sections on a real pack from the e2e sandbox.

## Integration seams (the e2e test must cover; A writes `test/e2e-slice-1c.test.ts` steps 1-7 on its branch, the
coordinator adds steps 8-10 at integration after both reviews, then runs it 3x)

1. The printed snippet has 5 events; the SessionStart command, run through `/bin/sh` with the fixture on stdin from the
   private build root, prints an EMPTY stdout, exits 0, and appends a heartbeat with `watchdogCheck: "ok"` (the real
   watchdog is present there), `nodeOptionsSet: true` when the harness sets `NODE_OPTIONS=--title=e2e-nodeopt-canary`,
   and the canary string appears nowhere in the ledger.
2. A PreToolUse after the heartbeat records `call.agentSessionId` equal to the fixture `session_id`.
3. A PreToolUse for a second `session_id` with no heartbeat, then a PermissionDenied fixture for that call → a `blocked`
   outcome with `errorClass: "permission-denied:auto-mode"` chained to the intent (not an orphan).
4. `anchor` → exit 0; `verify` → exit 0, status `head`; append one more record via a hook → `verify` exit 0 `ancestor`;
   truncating the tail → `verify` exit 1 `mismatch` (keep the 1b truncation test too).
5. `report` stdout carries `anchor.status: "ancestor"`; the report's own head check still passes.
6. Fail closed is unchanged: pin 7 of 1b (corrupt registry / missing key / world-readable key → watchdog exit 2) still
   holds with the extra hook entries present; the session-start and denied handlers exit 0 silently in those cases and
   change no ledger byte.
7. Leak sweep: raw hashed arguments, error text, the key, the credential and the NODE_OPTIONS canary are absent from the
   ledger, every process output, and (step 8) the pack.
8. (integration) Pack content: the four sections in order in HTML and PDF; the anchor line says ancestor; the heartbeat
   table has the step-1 row; "sessions without heartbeat" names exactly the step-3 session; CC8.1 shows `denied: auto
   mode` for step 3 and `asked, no outcome observed` for the delegated Bash; the verbatim denial sentence is present.
9. (integration) CSV: appended columns present; heartbeat row criteria `CC7.2`; `evidence_class` matches the HTML.
10. (integration) `npm test` = unit then timing, green 3/3 under a concurrent second run; `npm run check` green.

Where two correct halves could still fail together: A passes a 4th argument B's `generateReport` ignores (pin 6 type
drift → the anchor line silently reads "not supplied": step 5+8 catch it); B discriminates heartbeats by a string that
differs from `HEARTBEAT_RULE_ID` (step 8); A's `agentSessionId` dropped by a validator B changed (pin 4 ownership; step
2); the SessionStart handler leaking a line to stdout (step 1); the timing move breaking the watchdog test's relative
imports (step 10); the denied handler registered under the watchdog by mistake (exit 2 is ignored by Claude Code for
PermissionDenied, but the deny JSON would be junk on stdout: step 1's snippet check asserts direct commands).

## ADR items (drafted in the vault, `status: proposed`; Ryan accepts or rejects before A implements them)

- **ADR-010** (`decisions/ADR-010-heartbeat-denial-report-context.md`): pin 1 types amendment (`agentSessionId`,
  `SessionHeartbeat`, constants), pin 2 hooks contract additions, pin 3 `Pipeline.recordHeartbeat`, pin 6
  `generateReport` optional `context`, pin 7 encodings. Without it: no per-session heartbeat check, no anchor line in the
  pack; `anchor` (pin 5) and pins 8-11 are still buildable.
- **ADR-011** (`decisions/ADR-011-pipeline-deadline-check-in-decide.md`): move the watchdog-deadline construction check
  into `decide()` so `post`, `session-start` and `denied` construct without the 1b env shim. Optional; the slice ships
  with the shim if rejected.

## Risks (architect)

- A Claude Code update could add `SessionStart` fields or change `permission_mode` values; the parser tolerates unknown
  fields, so new fields never deny, but the heartbeat table may show new mode strings verbatim. Acceptable.
- The heartbeat self-test spawns the watchdog once per session start (≈100-300 ms, inside the "first response waits"
  window). On `compact`/`clear` it repeats. Acceptable; if it ever exceeds 1 s, drop to a file-existence check and
  record `watchdogCheck: "missing"|"ok"` only (say so in the README).
- `anchor` run while Claude is still open races the head check (`ledger-changed`, exit 1); DEMO orders it after exit.
- The sessions-without-heartbeat check is only as good as `agentSessionId` coverage: a tool call from a session started
  before hooks were installed has no heartbeat AND is correctly flagged; a hook removed mid-session leaves no trace (the
  stated §7 residual; the heartbeat narrows it, it does not close it).
- Manual denials stay unobservable; the only honest improvement is wording (pin 8). A later SessionEnd/Stop marker could
  tighten "no outcome observed" to "turn ended without execution" (SessionEnd has a 1.5 s default budget; not this slice).
- B's PDF changes are the largest hand-written surface; the escaping tests must cover the new tables, or an auditor
  opens a broken PDF.

## Amendment (coordinator, 2026-10-05, after the live home-lab run)
- Pin 8 / pin 7: records without `agentSessionId` are labelled **"not recorded (server mode or pre-1c)"**, not
  "pre-1c, no agent session id": proxy (server-mode) records never carry an agent session id and no record field
  distinguishes them reliably. Branch `fixes-2b`, reviewed by Fable.
