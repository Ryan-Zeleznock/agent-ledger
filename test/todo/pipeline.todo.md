# pipeline: tests to write after Gate 2
- [ ] denied → one `blocked` outcome record and upstream is never called
- [ ] ledger down + risky call → blocked; ledger down + unreviewed call → blocked (same as risky, spec §7)
- [ ] ledger down + read call → allowed and buffered
- [ ] the intent record is written before upstream runs
- [ ] runtime test: a ToolCall built from an IncomingCall has no credential property (explicit field projection, never a spread); a stored LedgerRecord JSON never contains the credential value
- [ ] `decide()` never calls upstream; writes the intent record before returning; maps allow → allow, deny/timeout → deny, require_approval without an approval channel → ask
- [ ] `recordOutcome(callId)` appends an outcome record chained to the intent record with that callId; an unknown callId is recorded as an orphan outcome, not dropped
- [ ] `deps.registry` is the only policy input; the pipeline has no code path that reads suggestions.yaml
