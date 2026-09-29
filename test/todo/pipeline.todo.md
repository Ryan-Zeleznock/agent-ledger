# pipeline: tests to write after Gate 2
- [ ] denied → one `blocked` outcome record and upstream is never called
- [ ] ledger down + risky call → blocked
- [ ] ledger down + read call → allowed and buffered
- [ ] the intent record is written before upstream runs
- [ ] runtime test: a ToolCall built from an IncomingCall has no credential property (explicit field projection, never a spread); a stored LedgerRecord JSON never contains the credential value
