# approvals
Status: implemented

Asks a human in Slack and returns a final `ApprovalResult`. The pipeline supplies the stored, redacted `ToolCall`;
only an approved result may permit execution. This module imports only shared types and its own implementation.
Spec: §4, §6, §7; ADR-006 and accepted ADR-015; binding Slice 2b pin 1.

Configure optional transports once with `configureSlackApprovals` before validation or router creation. Production uses
Slack's HTTPS API and Node's WebSocket; tests inject fetch, WebSocket, clock, randomness and secret readers. API calls
have a 10 s deadline, reject redirects, and sanitize error codes. A rate-limited post retries once when Retry-After is
at most 5 s and fits the approval wait. File secrets require a regular, owned, private file opened without following
symlinks, bounded to 4 KiB. Tokens never appear in diagnostics or message text.

`probeSlack` checks bot identity, opens Socket Mode, waits for hello and closes. Requests share one process-wide router
and channel configuration. Every envelope is acknowledged synchronously; only a single block action with matching
app, team, callId, CSPRNG nonce, message timestamp, channel and allowed user can settle. Settlement is atomic; duplicate,
competing and late clicks cannot revise it. Unauthorized users receive best-effort ephemeral feedback. The pending entry
is removed and the message's actions are replaced with the outcome; an update failure does not change that outcome.

Socket refresh opens the replacement before retiring the old connection. An unexpected close retries after 1, 2 and 4 s;
three failures or link_disabled settle remaining requests unavailable. The final settlement closes sockets. Shutdown is
idempotent and returns unavailable for pending/new approvals. Waits are capped by the supplied absolute deadline minus
5 s; server configuration is limited to 240 s. No pending approval is an allow.

Primary research [V], verified by the architect 2026-10-04 and supplied in `docs/slices/slice-2b-pins.md` §0:
https://docs.slack.dev/apis/events-api/using-socket-mode/ (hello, envelopes, acknowledgement, refresh, payload distribution),
https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/ (user/team/app and message binding),
https://docs.slack.dev/reference/methods/chat.postMessage/ and https://docs.slack.dev/reference/methods/apps.connections.open/.
No network research or live Slack validation was possible in Astra's sandbox. Fake transport acceptance tests are in
`test/approvals*.test.ts`; the coordinator owns live/loopback validation and cross-review.

Residuals: server mode only; one dedicated Slack app and one proxy process (ADR-015). Decide-only hook Slack, display
names, and cancellation when an agent disconnects are deferred to 2c. A message update may fail after a recorded decision.
