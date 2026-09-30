# approvals: tests to write after Gate 2 (Slack, Socket Mode, ADR-006)
- [ ] approve and deny paths against a fake Socket Mode server: `chat.postMessage` is called with an `actions` block of exactly two buttons (`agent-ledger:approve` primary, `agent-ledger:deny` danger), `block_id` = `agent-ledger:call:<callId>`, both `value`s = callId; a `block_actions` envelope from an allowed `user.id` → `approved` / `denied` with `approver` = that user id and `callId` echoed; the envelope is acknowledged by `envelope_id` before the decision is computed
- [ ] anti-replay: a `block_actions` payload whose `actions[0].value` is another callId, or whose `channel.id` differs, is ignored and the wait continues; a second valid click after the first is ignored
- [ ] approver allowlist: a click from a `user.id` not in `channel.approvers` is ignored for the decision and answered in-thread; the wait continues; with an empty allowlist `validateSlackChannel` refuses the config
- [ ] timeout returns `timeout` after `channel.timeoutMs`, and `chat.update` marks the message expired
- [ ] Slack unreachable (WebSocket never opens, `apps.connections.open` non-ok, `chat.postMessage` non-ok, 401) → `unavailable`; the promise resolves, it never rejects
- [ ] after a decision `chat.update` is called with the same `channel` + `ts` and the outcome; a failed update does not change the returned decision
- [ ] `validateSlackChannel`: channel id shape, user id shapes, `transport: "socket-mode"`, finite `timeoutMs`, both secrets resolvable; token VALUES never appear in the returned problems, in logs, or in any record
- [ ] `requestApproval` is never called with a `hook-ask` channel (type-level: `SlackChannel` only; runtime: the pipeline short-circuits)
- [ ] the `reason` on approved/denied is the approver's button label (plus confirm text when present); on timeout it says how long was waited; on unavailable it names the failing step without token values
