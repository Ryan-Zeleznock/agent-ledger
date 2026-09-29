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
- [ ] health check: the SessionStart hook writes a heartbeat record; the report flags a session with tool calls and no heartbeat
