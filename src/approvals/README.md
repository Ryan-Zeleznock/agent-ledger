# approvals
**Job:** Ask a human in Slack and return an `ApprovalResult`; timeout and unavailable both count as deny
**Depends on:** types
**Does NOT:** decide what is risky, or handle `hook-ask` (that channel never reaches this module: the pipeline answers `ask` and Claude Code prompts the human in the terminal)
**Spec:** docs/spec.md §4, 6, 7

`ApprovalChannel` is a union in `src/types/`: `{ kind: "slack", channelId, timeoutMs }` or `{ kind: "hook-ask" }`. It is required in `PipelineDeps`, so "no channel" is an explicit choice, never a missing field. Results: `approved` / `denied` from a human, `timeout` (no answer in `timeoutMs`), `unavailable` (configured but unreachable or erroring), `delegated` (hook-ask only, written by the pipeline). Only `approved` can turn into an allow, and only after the intent record carrying it has persisted.
