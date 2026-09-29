# hooks
**Job:** Turn a Claude Code `PreToolUse` / `PostToolUse` hook event (stdin JSON) into an `IncomingCall`, and turn the pipeline's `HookDecision` back into the exact `hookSpecificOutput` JSON Claude Code expects
**Depends on:** types only (the pipeline is wired in by the `hook` command after Gate 2, not by import)
**Does NOT:** decide anything, execute tools, or read the registry
**Spec:** docs/spec.md §3, 6

Why it exists: an MCP proxy never sees Claude Code's built-in tools (Bash, Edit, Write, WebFetch). Hooks fire for every tool, built-in and MCP, and can be enforced through managed settings (`allowManagedHooksOnly`). Local mode is therefore hook collector + MCP proxy.

Wire format verified 2026-09-29 against https://code.claude.com/docs/en/hooks; fixtures in `test/fixtures/claude-code-*.json` pin it. Built-in tools map to server `claude-code`; `mcp__<server>__<tool>` maps to `<server>/<tool>`.
