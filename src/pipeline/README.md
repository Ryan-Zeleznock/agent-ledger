# pipeline
**Job:** Run identity → policy → approval → ledger → upstream → ledger for one call (proxy mode), or stop after the intent record and answer allow/deny/ask (decide-only mode for the hook collector)
**Depends on:** identity, policy (the reviewed registry), approvals, ledger, upstream (all injected through `PipelineDeps`), types
**Flow:** `createPipeline(deps)` returns `{ handle, decide, recordOutcome }`.
- `handle` is the `CallHandler` that `front` runs. For each `IncomingCall` it calls `deps.identity.resolveAgent(credential)` and `startSession(...)`, builds the authenticated `ToolCall` by explicit field projection (never `{ ...incoming }`, so no credential survives), evaluates the registry (own-property, case-sensitive lookups), requests approval if needed, appends the intent record, executes upstream, appends the outcome.
- `decide` does the same up to the intent record and returns a `HookDecision`; the agent runtime executes the tool. An approved risky call becomes `allow` only after the intent record holding the approval has persisted; with `approvals.kind === "hook-ask"` a `require_approval` becomes `ask` and the intent record says `delegated`. `recordOutcome(callId, outcome)` appends the outcome record when PostToolUse (`ok`) or PostToolUseFailure (`error`) reports back.
**Does NOT:** talk to agents directly, hold credentials past the identity step, or read `suggestions.yaml`
**Spec:** docs/spec.md §3, 6, 7
