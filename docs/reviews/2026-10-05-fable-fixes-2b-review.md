# Review: fixes-2b (Fable, 2026-10-05)

Scope: `git diff 07eab7c..85f14ad` (5edd8b6 legacy session recovery, 1f065b8 session label, 85f14ad approver
names). Brief: `.claude/agents/security-reviewer.md`. Builder: Astra. Reviewer: Fable. This review approves nothing;
only Ryan merges.

**GATE: FAIL** (1 P1)

## P1

**P1-1 Legacy recovery never fires against the real reference app.** `src/upstream/contract.ts:362` requires
`data["id"] === id`. server-everything 2026.8.31 builds the error with `id: req?.body?.id`
(`dist/transports/streamableHttp.js:88`), but the app registers no body parser (only `cors`, Express 5.2.1), so
`req.body` is undefined. `JSON.stringify` then drops `id` entirely. Live probe (2026-10-05, real process, port 38917):
`HTTP/1.1 400` with body `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"}}`.
Scenario: probe `/private/tmp/claude-501/fx2b/probe.mjs` runs `dist/` at 85f14ad against the real process. It connects,
runs echo (ok), kills and restarts the process, then calls echo again and gets `UpstreamError: upstream everything:
HTTP 400 on tools/call`. That is the live-lab bug this commit claims to fix.
Why tests missed it: `test/helpers/legacy-upstream.ts:91` echoes `msg.id`, which the real app does not do.
Fix: accept the envelope when `id` is absent or `null`, and still refuse a present, mismatched id (keep the `bad-id`
test). Change the 400 fixture so it omits `id`, like the real app. I verified that the patched matcher
(`data.id === id || !Object.hasOwn(data,"id") || data.id === null`) recovers in the same probe:
`/private/tmp/claude-501/fx2b/probe2.mjs`, which patches a scratch copy. Also fix `src/upstream/README.md`
("matching request id") and the research.md entry. Add a test with an id-less 400 that would fail on 85f14ad.

## P2

**P2-1 A display name can visually spoof the member id in HTML.** At `src/approvals/slack.ts:115` the filter rejects
only C0/DEL. Bidi and format controls (U+202A-202E, U+2066-2069, U+200B-200F, U+061C) and C1 (U+0080-009F) pass.
`src/report/render.ts:70` renders `${name} (${id})`. Scenario: an allowlisted approver sets their Slack name to end
in U+202E. The browser then shows the trailing `(U…)` reversed, so the CC8.1 cell no longer reads as the stable
id. Names such as `Alice (U0AAAAAAAA)` also mimic a second id. PDF is safe because `ascii()` shows `‮`
literally. Fix: reject `\p{Cc}`, `\p{Cf}` and bidi controls when capturing the name. Optionally wrap the HTML name in
`<bdi>` (renderer-side, for old records too). Add a test for each.

## P3

- P3-1 `contract.ts:316` still retries on any legacy 404, whatever the body. This predates this range (pin 2) and is
  documented. It matches SDK 1.32.0, where 404 comes only from `validateSession`
  (`webStandardStreamableHttp.js:738-757`, which runs before dispatch). An exact `-32001`/"Session not found" match
  would line up with the stated "exact responses only" rule. Optional.
- P3-2 Older CLIs strict-read records with `approval.approverName` as having an extra key, and reject them. The
  additive field is forward-incompatible for auditors on pre-fixes-2b binaries. Note it in the release notes.
- P3-3 Coordinator-owned: `docs/slices/slice-2b-pins.md:499,555` still defer names and `users:read` to 2c, and
  slice-1c pin 8 (`slice-1c-pins.md:196`) still says "pre-1c, no agent session id". Amend both to match the ADR-015
  amendment and the new label.

## Verified OK

- Recovery: single-flight. Concurrent failures share `#initializing`, and a caller that sees a newer session skips
  re-init. Exactly one resend: `requestOnce`, not a recursive `request`. Body inspection runs only for legacy, a
  session header and status 400, under the existing 4 MiB cap and 30 s deadline. Only a boolean is kept, and errors
  are value-free. The "Server not initialized" and "Unsupported protocol version" 400s are refused. The router 400
  fires before `transport.handleRequest` (`streamableHttp.js:45-94`), so a resend cannot duplicate an executed call.
- Names: `users.info` runs only after the synchronous settle/remove, and only for `approved`/`denied` with an
  allowlisted `approver`. It never runs for unauthorized clicks, timeouts or shutdown. The decision, approver and
  decidedAt cannot change. The allow reason (`pipeline/contract.ts:341`) uses the member id. The lookup budget is
  `min(1 s, expires-now)`, with no retry. The 64 KiB cap is enforced whether or not content-length is declared. A
  stalled body is aborted. Failures are swallowed with no logging, and the token appears only in the Authorization
  header. The manifest adds `users:read` only, asserted in `deploy/check.mjs`.
- Ledger: `approverName` goes through `str` (bounded, well-formed) in the lenient and strict projections, and the
  JCS hash covers it. Postgres stores the canonical line, so parity is unaffected.
- Report: HTML goes through `esc`, PDF through `ascii`+`escape`, and the CSV name sits inside the approval JSON cell
  (`csvCell`, starts with `{`). CSV is still 28 columns. The label "not recorded (server mode or pre-1c)" is accurate:
  hook mode since 1c requires a non-empty `session_id` (`hooks/contract.ts:296`), so a missing id really means proxy
  mode or a pre-1c record. The legend explains it.
- Tests: the new approvals and report tests assert real behavior and would fail on 07eab7c (no lookup, no name, old
  label). The upstream restart tests would also fail on 07eab7c (any 400 refused), but they pass for the wrong reason
  under P1-1.

Suite: not re-run. The coordinator reports 1578 unit + 79 timing passing outside the sandbox.
