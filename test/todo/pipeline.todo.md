# pipeline: tests to write after Gate 2
- [ ] denied → one `blocked` outcome record and upstream is never called
- [ ] ledger down + risky call → blocked
- [ ] ledger down + read call → allowed and buffered
- [ ] the intent record is written before upstream runs
