# policy
**Job:** Classify a ToolCall from the reviewed tool registry (`policies/tools.yaml`) and return a PolicyDecision; propose classes for unreviewed tools during setup
**Depends on:** types
**Does NOT:** ask humans, call tools, or let a name pattern or an MCP annotation decide a call
**Spec:** docs/spec.md §4, 8 · **Decision:** ADR-004

Two inputs, one authority:
- `tools.yaml` (see `policies/tools.example.yaml`): per server, per tool, `class: read|write|risky` with `reviewedBy`/`reviewedAt`. `evaluate()` reads only this. Unknown server or tool → `require_approval`, risk `unreviewed`.
- `suggestions.yaml`: name regexes read only by `suggestClass()`, together with MCP annotations from servers marked `trusted`. Output is a proposal for the reviewer, nothing more.

Invariant: nothing downgrades. `escalateWhen` may raise a row's class for matching arguments; the loader refuses an escalation whose `to` is not above the base class, and `evaluate()` takes the max anyway.
