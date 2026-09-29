# pipeline
**Job:** Run identity → policy → approval → ledger → upstream → ledger for one call
**Depends on:** identity, policy, approvals, ledger, upstream (all injected through `PipelineDeps`), types
**Flow:** `createPipeline(deps)` returns the `CallHandler` that `front` runs. For each `IncomingCall` it calls
`deps.identity.resolveAgent(credential)` and `startSession(...)`, builds the authenticated `ToolCall` (no credential),
then evaluates policy, requests approval if needed, appends the intent record, executes upstream, appends the outcome.
**Does NOT:** talk to agents directly or hold credentials past the identity step
**Spec:** docs/spec.md §6, 7
