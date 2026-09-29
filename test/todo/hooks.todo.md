# hooks: tests to write after Gate 2
- [ ] `parseHookInput` accepts both fixtures and rejects: invalid JSON, a missing `session_id`/`hook_event_name`/`tool_use_id`, an unknown `hook_event_name`
- [ ] `toIncomingCall`: `Bash` → server `claude-code`, tool `Bash`; `mcp__github__create_issue` → `github`/`create_issue`; `mcp__plugin_my-plugin_db__query` → `plugin_my-plugin_db`/`query`; a tool whose name contains `__` keeps the remainder intact
- [ ] `toIncomingCall`: callId equals `tool_use_id`; args is `tool_input` by reference-free copy; the credential passed in is the one on the result and nothing from the event leaks into `args`
- [ ] `formatPreToolUseOutput` produces exactly `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":...,"permissionDecisionReason":...}}` and never `defer`
- [ ] round trip with the pipeline stub replaced by a fake: PreToolUse fixture → decide → output; PostToolUse fixture → recordOutcome(tool_use_id)
- [ ] the hook command exits 0 with JSON on a decision and exits 2 (block) when the ledger is down and the class is write, risky, or unreviewed (spec §7)
