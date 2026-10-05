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

Fable review fixes (2026-10-04): a failed secret read or auth.test clears the cached credential attempt, allowing the
next request to retry with concurrent callers sharing that attempt. Socket Mode WSS URLs must use a `*.slack.com` host;
the explicitly configured loopback WS test seam remains available. Late losing clicks receive best-effort feedback for
30 s when a socket is available, using at most 1024 settled message bindings and outcomes. Expired entries are pruned
on access; pending closures and call arguments are not retained in this cache. Shutdown clears it.

Primary research [V], verified by the architect 2026-10-04 and supplied in `docs/slices/slice-2b-pins.md` §0:
https://docs.slack.dev/apis/events-api/using-socket-mode/ (hello, envelopes, acknowledgement, refresh, payload distribution),
https://docs.slack.dev/reference/interaction-payloads/block_actions-payload/ (user/team/app and message binding),
https://docs.slack.dev/reference/methods/chat.postMessage/ and https://docs.slack.dev/reference/methods/apps.connections.open/.
No network research or live Slack validation was possible in Astra's sandbox. Fake transport acceptance tests are in
`test/approvals*.test.ts`; the coordinator owns live/loopback validation and cross-review.

Residuals: server mode only; one dedicated Slack app and one proxy process (ADR-015). Decide-only hook Slack
and cancellation when an agent disconnects are deferred to 2c. A message update may fail after a recorded decision.


## ADR-015 name amendment (accepted 2026-10-05)

A valid click settles and removes the pending entry synchronously, preserving the winning member id, decision,
reason and decision timestamp. Before returning the immutable result, one best-effort `users.info` POST (form-encoded
`user`, bot bearer; scope `users:read`) adds optional `approverName`. The lookup has at most **1 second**, capped by
the remaining approval wait; it never retries. Both fetch and body parsing race that deadline, even for injected
transports that ignore abort. The response body is capped at 64 KiB. No failure can revise the decision or emit response
values; failure/absent/invalid names simply omit the field. Only a matching returned user id is accepted; prefer profile
real_name, then user real_name, then profile display_name. Names are trimmed, well-formed, ≤256 characters,
and cannot contain the known tokens or nonce. Before trimming, Unicode Cc/Cf characters are refused (including C1,
bidi overrides/isolates and zero-width format controls); a control-bearing candidate omits approverName without
falling back to another profile field. Ordinary right-to-left text remains valid. No profile cache: names reflect each decision's lookup, not later edits.
Display names are presentation, never allowlist identity. HTML/PDF retain the member id; CSV uses existing approval JSON.

Tests: `ADR-015 approver names` in `test/approvals.test.ts`; ledger projection, strict-read/hash round-trip, report
escaping and legacy member-only rendering. Fake Slack supports `users.info` in both in-process and loopback fixtures.
Live scope/reinstall and users.info compatibility are coordinator checks (no network in this build sandbox).
