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

## Astra re-review 2026-09-30 (nonce, atomic settlement, one router per process)
- [ ] every button `value` is `<callId>:<nonce>` matching `SLACK_BUTTON_VALUE_RE`, the nonce is 32 hex chars from `crypto.randomBytes(SLACK_NONCE_BYTES)`, differs between two requests for the SAME callId, and never appears in any ledger record or log line
- [ ] forged click: a `block_actions` payload with the real callId but a wrong nonce → acked, ignored, wait continues; right nonce but a `message.ts` that is not the ts `chat.postMessage` returned → ignored (replay of an older message for the same call); right nonce and ts but wrong `channel.id` → ignored
- [ ] atomic settlement, competing clicks: two allowed approvers click approve and deny "simultaneously" (two envelopes dispatched in the same tick) → exactly one `settle()` returns true, exactly one ApprovalResult, the loser gets an ephemeral "already decided" reply, `chat.update` runs once
- [ ] click racing the timeout: the timer fires and a valid click arrives in the same tick → one terminal state; whichever won is the recorded decision and the other changes nothing (run both orders)
- [ ] late click: a valid click after settlement (after `timeout`, after `approved`, after `unavailable`) → acked, ignored, no second record, no second `chat.update` decision
- [ ] duplicate envelopes: Slack redelivers the same `envelope_id` twice → acked twice, settled once
- [ ] after settlement the pending entry is removed: `router.pendingCount` drops by one, and a click with the settled call's valid nonce is a no-op
- [ ] ONE router per process: `getSlackApprovalRouter(channel)` returns the same instance on every call; with 3 concurrent `requestApproval`s the fake Slack sees exactly one `apps.connections.open` and one WebSocket, and a click for approval #2 arriving on the shared socket settles #2 only (neither #1 nor #3 change)
- [ ] the router closes the socket when `pendingCount` reaches 0 and reopens it on the next `register`; a Slack `disconnect` envelope mid-wait → reconnect, pending approvals kept, no `unavailable` unless reconnect fails
- [ ] `deadlineAt` cap: `requestApproval(call, decision, channel, deadlineAt)` waits `min(timeoutMs, deadlineAt - now - APPROVAL_MIN_MARGIN_MS)`; a `deadlineAt` already inside the margin → `timeout` with no `chat.postMessage`
