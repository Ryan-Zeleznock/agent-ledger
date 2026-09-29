# approvals: tests to write after Gate 2
- [ ] approve and deny paths (Slack), with `approver` set and `callId` echoed
- [ ] timeout returns `timeout` after `channel.timeoutMs`
- [ ] Slack unreachable (connection refused), 5xx, or 401 → `unavailable`; the promise resolves, it never rejects
- [ ] an approval for one callId cannot be reused for another
- [ ] `requestApproval` is never called with a `hook-ask` channel (type-level: `SlackChannel` only; runtime: the pipeline short-circuits)
