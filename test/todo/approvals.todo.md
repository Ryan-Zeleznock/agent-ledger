# approvals: Slice 2b acceptance
- [x] approve/deny exact results, Block Kit buttons/confirmation, stored argument preview and escaping
- [x] synchronous acknowledgements; app/team/action/block/callId/nonce/message/channel/allowlist checks
- [x] nonce freshness, atomic settlement, competing/duplicate/late clicks and timeout races
- [x] singleton router, concurrent calls, close on idle, reopen, refresh overlap, bounded reconnect, link_disabled
- [x] deadline cap and zero-wait fast path; timeout/unavailable fail closed; failed updates cannot alter decisions
- [x] private file and environment secrets, prefixes, config validation and set-once seam
- [x] bounded HTTP/hello waits, sanitized API errors, bounded 429 retry, startup probe and shutdown
- [x] shape contract remains green; pipeline keeps hook-ask out of requestApproval
- [x] Fable review 2026-10-04 P2-1: failed auth.test retries single-flight; P3-1/2: late-click feedback expires at 30 s, bounded to 1024 settlements; WSS host restricted to *.slack.com
- [ ] 2c: decide-only Slack router daemon/HTTP interactivity, pipeline abort input
- [ ] Coordinator: real Slack Socket Mode and loopback e2e checks; review by Fable (not self-approved)

- [x] ADR-015 2026-10-05: bounded users.info enrichment after atomic settlement, no name on failure, member identity unchanged, scope + reinstall docs; in-process races/failures and coordinator loopback assertions.
