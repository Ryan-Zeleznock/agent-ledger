# pipeline
**Job:** Run identity → policy → approval → ledger → upstream → ledger for one call (proxy mode), or stop after the intent record and answer allow/deny/ask (decide-only mode for the hook collector)
**Depends on:** identity, policy (the reviewed registry), approvals, ledger, upstream (all injected through `PipelineDeps`), types
**Flow:** `createPipeline(deps)` returns `{ handle, decide, recordOutcome }`.
- `handle` is the `CallHandler` that `front` runs. For each `IncomingCall` it calls `deps.identity.resolveAgent(credential)` and `startSession(...)`, builds the authenticated `ToolCall` by explicit field projection (never `{ ...incoming }`, so no credential survives), evaluates the registry, requests approval if needed, appends the intent record, executes upstream, appends the outcome.
- `decide` does the same up to the intent record and returns a `HookDecision`; the agent runtime executes the tool. `recordOutcome(callId, outcome)` appends the outcome record when the PostToolUse hook reports back.
**Does NOT:** talk to agents directly, hold credentials past the identity step, or read `suggestions.yaml`
**Spec:** docs/spec.md §3, 6, 7
