# hooks: tests to write after Gate 2

## Parsing and naming (both agents)
- [ ] `parseHookInput(raw, "claude-code")` accepts all three Claude Code fixtures and rejects: invalid JSON, a missing `session_id`/`hook_event_name`/`tool_use_id`, a `hook_event_name` outside `HOOK_EVENT_NAMES`, a PostToolUseFailure without `error`, a null `transcript_path`
- [ ] `parseHookInput(raw, "codex")` accepts both Codex fixtures and rejects: a missing `model`, `turn_id` or `permission_mode`, `permission_mode: "auto"`, `hook_event_name: "PostToolUseFailure"` or `"PermissionRequest"`; accepts `transcript_path: null`; a Claude Code fixture fed as `"codex"` is rejected (no `model`) and a Codex fixture fed as `"claude-code"` is rejected (`transcript_path` may be null, unknown fields)
- [ ] `toIncomingCall(ev, cred, "claude-code")`: `Bash` → server `builtin:claude-code`, tool `Bash`; `mcp__github__create_issue` → `github`/`create_issue`; `mcp__plugin_my-plugin_db__query` → `plugin_my-plugin_db`/`query`; a tool whose name contains `__` keeps the remainder intact
- [ ] `toIncomingCall(ev, cred, "codex")`: `Bash` → `builtin:codex`/`Bash`; `apply_patch` → `builtin:codex`/`apply_patch`; `update_plan` → `builtin:codex`/`update_plan`; `mcp__filesystem__read_file` → `filesystem`/`read_file`; a Codex event never lands on `builtin:claude-code` and vice versa
- [ ] `toIncomingCall` collision regression (Astra spec v2 #1 + ADR-005), under BOTH agents: `mcp__claude-code__Read`, `mcp__claude-code__Edit`, `mcp__builtin_claude-code__Bash`, `mcp__Claude_Code__Bash`, `mcp__codex__Bash`, `mcp__builtin_codex__Bash`, `mcp__Codex__apply_patch` throw (server segment normalises to a reserved name); a `mcp_server` object on a name without the `mcp__` prefix throws (Claude Code); `mcp__claude-code-helper__x` and `mcp__codex_helper__x` pass
- [ ] `toIncomingCall(ev, cred, "codex")` with `tool_input` that is `null`, an array, a string or a number throws (→ deny); a plain object is copied
- [ ] `toIncomingCall`: callId equals `tool_use_id`; args is `tool_input` by reference-free copy; the credential passed in is the one on the result and nothing from the event (`model`, `turn_id`, `transcript_path`) leaks into `args`
- [ ] `toOutcome(ev, "claude-code")`: PostToolUse → `{ status: "ok" }`; PostToolUseFailure fixture → `{ status: "error", errorClass: "Exit code 1", durationMs: 4187 }`; `is_interrupt: true` → errorClass `interrupt`; no exit-code line → `tool-error`; the `error` text itself never appears in the Outcome
- [ ] `toOutcome(ev, "codex")`: the Codex PostToolUse fixture (whose `tool_response` starts with `Exit code 1`) → `{ status: "ok" }` and nothing from `tool_response` appears in the Outcome (Codex has no failure event; spec §6)
- [ ] `formatPreToolUseOutput(d, "claude-code")` produces exactly `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":...,"permissionDecisionReason":...}}` for allow, deny and ask, one line, and never `defer`
- [ ] `formatPreToolUseOutput(d, "codex")`: allow and deny as above; `ask` → `permissionDecision: "deny"` with `permissionDecisionReason` = `CODEX_ASK_UNSUPPORTED_REASON`; the output never contains the string `"ask"`
- [ ] round trip with the pipeline stub replaced by a fake, per agent: PreToolUse fixture → decide → output; PostToolUse fixture → recordOutcome(tool_use_id, ok); Claude Code PostToolUseFailure fixture → recordOutcome(tool_use_id, error)

## Watchdog (Astra P1 #1, P1 #2, P2 #3; spec §7). Runtime tests spawn the real watchdog binary with a scripted handler.
- [ ] an infinite-loop handler (`while(true){}`, synchronous, ignores SIGTERM) → stdout deny JSON with reason `watchdog:deadline`, stderr reason, exit 2, observed before `deadlineMs + 500` and well before `HOOK_TIMEOUT_S`; the handler process is gone afterwards (SIGKILL)
- [ ] a handler that writes junk to stdout (`hello`, `[]`, `"allow"`, `{`) and exits 0 → deny `watchdog:output:not-json` / `output:not-object`, exit 2
- [ ] a handler whose stdout exceeds `maxOutputBytes` (a valid allow followed by 100 KB of padding) → deny `watchdog:output:too-large`, exit 2; the handler's bytes never appear on the watchdog's stdout
- [ ] a handler that exits 1 with a valid allow on stdout → deny `watchdog:handler-exit:1`, exit 2 (a non-zero handler is never trusted)
- [ ] a handler killed by a signal → deny `watchdog:handler-signal:<sig>`, exit 2
- [ ] a handler that writes a valid allow then a second JSON line (stray console.log) → deny `watchdog:output:multiple`
- [ ] an allow payload with extra junk: `updatedInput`, `additionalContext`, `systemMessage`, `continue`, a second top-level key, or `hookEventName: "PostToolUse"` → deny `watchdog:output:extra-key:<key>` / `output:bad-value`, exit 2
- [ ] a valid allow → exit 0, stdout is the RE-SERIALISED payload (byte-equal to `JSON.stringify` of the parsed object, not the handler's bytes: test with extra whitespace in the handler's output)
- [ ] a valid `ask` → exit 0 under `agent: "claude-code"`; deny `watchdog:output:bad-value:permissionDecision` under `agent: "codex"`
- [ ] a valid deny → stdout deny JSON with the HANDLER's reason, stderr reason, exit 2 (`watchdog:handler-deny`)
- [ ] a handler command that does not exist (ENOENT) or is not executable (EACCES) → deny `watchdog:spawn:<code>`, exit 2
- [ ] a handler that exits 0 with empty stdout → deny `watchdog:output:empty`
- [ ] stdin over `MAX_STDIN_BYTES` → deny `watchdog:stdin-too-large`, exit 2, handler never spawned
- [ ] invalid config denies with exit 2 and reason `watchdog:config:<field>`, never exit 1: `deadlineMs` = `NaN`, `Infinity`, `-1`, `0`, `1.5`, a string; `deadlineMs >= timeoutS*1000`; `deadlineMs > timeoutS*1000 - WATCHDOG_MIN_MARGIN_MS` (margin too small); `maxOutputBytes` below `MIN_MAX_OUTPUT_BYTES` or above `MAX_MAX_OUTPUT_BYTES`; `agent: "cursor"`; `handlerCommand: []`
- [ ] the registry loader's refusal (invalid class, impersonating key) happens INSIDE the handler and surfaces as handler exit ≠ 0 → deny, exit 2; the hook command never exits 1 on a config error
- [ ] the watchdog itself never throws: an `uncaughtException` forced inside it (test hook) → deny `watchdog:internal`, exit 2
- [ ] the watchdog's exit code is only ever 0 or 2 across every case above (assert on the full matrix)
- [ ] the watchdog module imports only `node:child_process`, `node:fs`, `node:process` (static import scan), so it cannot fail on the registry, YAML, or the pipeline
- [ ] every deny writes the reason to stderr AND a deny JSON to stdout (both agents block on either channel)
- [ ] the hook command exits 0 with JSON on a decision and exits 2 (block) when the ledger is down and the class is write, risky, or unreviewed (spec §7)

## Watchdog, Astra re-review 2026-09-29 (exit vs close, group kill, short writes, async stdin)
- [ ] a handler that writes a valid allow, spawns a grandchild that inherits its stdout/stderr and sleeps, then exits 0 → NO exit 0 at `exit`; at the deadline → deny `watchdog:deadline:pipes-open`, exit 2; both the handler's and the grandchild's pids are gone afterwards (group kill)
- [ ] a handler that exits 0 while a grandchild holding the pipes appends `{"x":1}` before closing → `close` fires, validation sees two JSON values → deny `watchdog:output:multiple`
- [ ] group kill leaves no survivors: a handler that spawns two detached-ignoring children (`setsid` not allowed to escape: they stay in the handler's group) and loops → after the deadline deny, `kill -0` on every pid fails; repeat for every failure path after a spawn (non-zero exit, bad output, write failure): no descendant survives
- [ ] the handler is spawned `detached: true` (it is its own process group leader: `getpgid(child) === child.pid`) and the kill is `process.kill(-pid, "SIGKILL")`, never `child.kill()` alone
- [ ] short-write injection: stub `fs.writeSync` to write 1 byte per call → the full one-line payload still reaches stdout byte-for-byte (writeAllSync loops); stub it to throw `EPIPE` on stdout → exit 2 with the reason on stderr; stub BOTH fds to throw (the failure reporter itself fails) → exit code is still 2 and nothing is on stdout
- [ ] `writeAllSync` retries `EAGAIN` up to its bound and then fails → exit 2
- [ ] never-EOF stdin: the test harness keeps the watchdog's stdin open without writing → the handler is never spawned, deny `watchdog:deadline:stdin`, exit 2 at the deadline; stdin is consumed asynchronously (a static scan asserts no `readFileSync(0)` / `readFileSync("/dev/stdin")` in the watchdog module)
- [ ] a handler that exits 1 AFTER writing a valid deny → deny is `watchdog:handler-exit:1`, emitted at `exit` without waiting for `close`
- [ ] `validateHookTiming`: `{ deadlineMs: 25_000, hookTimeoutS: 30 }` valid; `{ approvalTimeoutMs: 300_000, deadlineMs: 310_000, hookTimeoutS: 320 }` valid; `approvalTimeoutMs: 306_000` with deadline 310_000 → `approval-not-below-deadline`; `deadlineMs: 319_000` with timeout 320 → `deadline-not-below-hook-timeout`; NaN/∞/0/1.5/negative anywhere → violation; a handler started with `AGENT_LEDGER_WATCHDOG_DEADLINE_MS=25000` and a Slack `timeoutMs: 300000` fails init → watchdog deny `watchdog:init`, exit 2 (never exit 1)
- [ ] a Codex hook configured with `timeout = 320` runs the Slack profile end to end with a fake Slack that answers at 299 s → allow; at 301 s → `timeout` → deny before the deadline
- [ ] health check: the SessionStart hook writes a heartbeat record; the report flags a session with tool calls and no heartbeat

## Watchdog, Astra re-review 2026-09-30 (spec v2.1 freeze: full pipe, ESRCH/PGID, absolute deadline)
- [ ] full-pipe output (P1): the harness spawns the watchdog with a stdout pipe it never reads and pre-fills the pipe buffer (64 KiB on macOS/Linux) → the watchdog still EXITS 2 within `WATCHDOG_WRITE_BUDGET_MS + 500` of its verdict, never hangs past `deadlineMs`; `setNonBlocking(1)` was called before the first write (static scan + a spy) and `fs.writeSync` returned EAGAIN rather than blocking
- [ ] `writeAllSync` is TIME-bounded, not count-bounded: with `fs.writeSync` stubbed to always throw EAGAIN and an injected clock, it throws once `budgetMs` has elapsed (default `WATCHDOG_WRITE_BUDGET_MS`), sleeping `WATCHDOG_WRITE_RETRY_SLEEP_MS` between attempts; stubbed to accept 1 byte per call it completes the full payload within budget; stubbed to accept 0 bytes (zero progress) for the whole budget it throws even though no error was raised
- [ ] both fds blocked (stdout AND stderr full): exit code is still 2 within the budget, and the deny JSON, if any of it got out, is a prefix of the one line (never interleaved junk)
- [ ] `setNonBlocking` failure (fd is not a pipe/tty, or the mode switch throws) → treated as a write failure → exit 2
- [ ] ESRCH (P2): the handler exits and its whole group is already gone when the deadline kill fires → `process.kill(-pid)` throws ESRCH → the watchdog treats it as "already dead", the deny is still emitted, exit 2, no `watchdog:internal`
- [ ] no PGID reuse (P2): after the first group kill attempt on a failure path, the watchdog never calls `process.kill(-pid, …)` again with that pid (spy: exactly one negative-pid kill per failure path), so a recycled PGID belonging to an unrelated process is never signalled
- [ ] `setsid()` escape is a documented residual, asserted as such: a handler descendant that calls `setsid` (test helper via `child_process` `detached: true`) survives the group kill; the test asserts the survivor exists AND that the spec §7 residual text names it (grep), so the limit stays stated, not forgotten
- [ ] absolute deadline (P2): the watchdog passes BOTH `AGENT_LEDGER_WATCHDOG_DEADLINE_MS` (duration) and `AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS` (epoch ms = the instant the deadline timer started, before stdin was read); with a harness that holds stdin open for 8 s before EOF under `deadlineMs: 25_000`, the handler observes `deadlineAt - Date.now()` ≈ 17 s, not 25 s
- [ ] handler budgeting from the absolute deadline: with `SLACK_HOOK_TIMING` and a stdin delay of 20 s, the handler's Slack wait is `min(300_000, deadlineAt - now - APPROVAL_MIN_MARGIN_MS)` ≈ 285 s, the fake Slack answering at 290 s → `timeout` recorded and `deny` emitted BEFORE the watchdog's deadline (no kill, no unrecorded approval)
- [ ] missing / non-integer / already-past `AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS` → handler init failure → watchdog deny `watchdog:init`, exit 2
- [ ] a remaining budget ≤ 0 at the moment of the Slack wait → `timeout` at once, no `chat.postMessage`, recorded, deny
