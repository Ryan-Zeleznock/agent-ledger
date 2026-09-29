# policy
**Job:** Classify a ToolCall from the reviewed tool registry (`policies/tools.yaml`) and return a PolicyDecision; propose classes for unreviewed tools during setup
**Depends on:** types
**Does NOT:** ask humans, call tools, or let a name pattern or an MCP annotation decide a call
**Spec:** docs/spec.md §4, 8 · **Decision:** ADR-004

Two inputs, one authority:
- `tools.yaml` (see `policies/tools.example.yaml`): per server, per tool, `class: read|write|risky` with `reviewedBy`/`reviewedAt`. `evaluate()` reads only this. Unknown server or tool → `require_approval`, risk `unreviewed`.
- `suggestions.yaml`: name regexes read only by `suggestClass()`, together with MCP annotations from servers marked `trusted`. Output is a proposal for the reviewer, nothing more.

Identity rules (spec §8): server keys are exact, case-sensitive, own-property lookups (`Object.hasOwn`); `github/constructor` and server `__proto__` are unreviewed, and the loader refuses those keys outright. Built-in tools live under `builtin:claude-code`, a key MCP can never produce (Claude Code allows only `[A-Za-z0-9_-]` in MCP server names); the loader refuses any other key with a `:`, any key that normalises to `claude-code`/`builtin-claude-code`, and any two keys that differ only by case.

Invariant: nothing downgrades. `escalateWhen` may raise a row's class for matching arguments; the loader refuses an escalation whose `to` is not above the base class, and `evaluate()` takes the max anyway.
