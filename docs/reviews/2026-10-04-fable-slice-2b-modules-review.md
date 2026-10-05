# Slice 2b Package A: cross-review (Fable, 2026-10-04)

Reviewer: Fable (security-reviewer brief), one full pass at high effort. Builder: Astra. Fable did not build this code.
Range: `git diff f253669..HEAD` on `slice-2b-modules` (e9fed5f approvals, f9524af upstream, 7ddebae front, 6feed40
discovery-deadline fix). Binding: `docs/slices/slice-2b-pins.md` pins 1-4, ADR-006 (frozen `src/approvals/contract.ts`),
ADR-015/016/017. Read-only review: no tracked file was changed and nothing was committed. Probes ran in
`/private/tmp/claude-501/fable-2b-probes/` with in-process fakes only (no real Slack, no sockets bound).

## Suite (outside the sandbox)
`perl -e 'alarm shift; exec @ARGV' 900 npm run check` → typecheck ok; unit **1436 passed / 11 skipped** (41 files);
timing **79 passed**; build ok; EXIT 0. The worktree was still clean afterwards.

## Verdict
No fail-open path found. The core approval invariants hold (checked by reading and with probes):
- The button value is `<callId>:<nonce>` (16-byte CSPRNG). A click must match the hello `app_id`, the auth.test
  `team_id` (when present), a single action, an action_id from the set, `block_id`, nonce, `message_ts` and `channel_id`.
- The click's `user.id` must be on the allowlist.
- The ack is synchronous, before any dispatch.
- Settlement is a compare-and-set, so there is one decision per callId. A second pending entry with the same callId
  settles `unavailable`.
- Timeout, unavailable, a socket that fails to reconnect after three tries, `link_disabled` and shutdown all deny.
- The result carries `approver = user.id`.
- The wait is `min(timeoutMs, deadlineAt − now − 5000)`, and ≤ 0 returns `timeout` with no Slack call.
- Tokens and the nonce never appear in a reason or in Slack text. The args preview is built from the HMAC-projected
  stored call (`src/pipeline/contract.ts:275`).

Upstream dual-era:
- Falls back only on 400/404/405 without a recognized -32020/-32021/-32022 body.
- Refuses 401/403 and modern errors. 5xx, network errors and timeouts become `UpstreamUnavailable`.
- The handshake is bounded, the session-id charset is checked, re-initialize is single-flight and runs once, and close
  sends a DELETE (bounded at 2 s).
- The SDK 1.x empty priming event `id: …\ndata: \n\n` is skipped (probe U1: `data` buffer "\n" → payload "" → not
  JSON → dropped).
- Diagnostics carry no values.

Legacy front:
- Sessions are bound to SHA-256(bearer) and compared with timingSafeEqual. A foreign or unknown session gets 404
  without echoing the id.
- Legacy `tools/call` goes through the same exposed-name lookup, argument checks, admission and `IncomingCall`, with the
  credential set to the bearer. No legacy path bypasses identity, policy or the ledger.
- TLS uses `https` with minimum TLSv1.2. The factory never reads files.

The three P2 fixes from the last round are correct.

**The findings below are availability and robustness issues, all fail-closed: 6 P2 and 6 P3.**

## Findings

### P2-1: one transient auth.test failure disables Slack approvals until the process restarts
`src/approvals/slack.ts:110-118`. `this.credentials ??= (async () => …)()` caches the promise, so a rejected one stays
cached on the process-singleton router.
Scenario (probe A1): auth.test returns 503 once → approval #1 `unavailable: auth.test: error`. Approval #2, after Slack
has recovered, also returns `unavailable: auth.test: error` with **auth.test called only once**. The same happens for a
secret file staged late. Every risky call is then denied until a restart. This fails closed, but it is exactly the
"demo looks broken" mode the pins warn about.
Fix: clear `this.credentials` when it rejects (`.catch(e => { this.credentials = undefined; throw e; })`). Add a test
where auth.test fails once and then succeeds.

### P2-2: a failed legacy re-initialize leaves the upstream with no session for good
`src/upstream/contract.ts:282-293` with `:310-317`. `initialize()` clears `#session` first. If the re-initialize after a
session 404 fails (5xx, timeout), `#session` stays undefined. `request()` only recovers on a 404 *with* a session, so
every later request goes out without a session id and gets 400.
Scenario (probe U2): the session expires and initialize returns 503 once → after that, every `tools/call` returns
"HTTP 400 on tools/call" forever (2 initializes in total, no further attempt).
Fix: when `era === "legacy"` and `#session` is undefined but a session was assigned at connect time (remember a
`sessionful` flag), re-initialize single-flight before the request. Alternatively, treat a 400 as recoverable while
the session is missing. Add a row: re-init fails once, then the next call recovers.

### P2-3: legacy upstream tools skip `x-mcp-header` validation, so one bad schema stops the proxy from starting
`src/upstream/contract.ts:117` (`client.era === "legacy" ? [] : headerParams(…)`). A legacy tool's `inputSchema` is
forwarded unvalidated. The front's `buildExposedTable` (`src/front/contract.ts:114`) still validates it, and on an
invalid annotation it throws at start, fail-closed for the whole front.
Scenario (probe U3): a legacy tool with `items: { type: "string", "x-mcp-header": "Item" }` gives upstream
`rejectedTools: []`, and then `buildExposedTable` throws "not statically reachable". One third-party tool keeps the
proxy from starting.
Fix: for legacy upstreams, still run `headerParams()` and exclude the tool into `rejectedTools` when it throws (do not
mirror the valid ones). Alternatively, strip `x-mcp-header` keys from forwarded legacy schemas. Add a test row.

### P2-4: a disconnect frees the admission slot while the handler keeps running, so `maxInFlight` no longer limits handler work
`src/front/contract.ts:292-299`. The slot is released on `res` `close`, but the handler `run` continues (the pipeline
has no abort input until 2c).
Scenario (probe F3): with `maxInFlight: 2`, ten `tools/call`s that each disconnect after 20 ms give **10 concurrent
handler invocations** (peak 10).
Impact: the F10 bound in 2a covered running invocations. Now an agent can make pending Slack approvals (each one posts
a message) and upstream calls grow without bound by dropping connections. That means approval-fatigue spam in the
channel and memory growth in the pending map. The test "releases a disconnected client slot before its handler
finishes" asserts this behaviour.
Fix (pick one, coordinator's call):
- (a) Keep a hard ceiling on running handlers, e.g. refuse when `inflight.size >= 2 × maxInFlight`.
- (b) Keep the slot until the handler settles and correct the README claim instead, since cancellation is 2c.

### P2-5: anyone with a well-formed bearer string can use up the global legacy-session table
`src/front/contract.ts:237-243`. The front checks only the bearer *syntax* (`BEARER_RE`). Key validity is checked in the
pipeline at `tools/call`. So `initialize` mints sessions for any token.
Scenario (probe F1): 1024 initializes with `Bearer garbage<i>` → the real agent's initialize gets `503 -30503 too many
legacy sessions`. This lasts up to 1 h per flood, so the Codex path (ADR-006/ADR-016's reason) is locked out with no key
needed. The cap bounds memory, but not who can fill it.
Fix:
- On overflow, evict the least-recently-touched session instead of refusing. The evicted client gets a 404 and
  re-initializes, which the spec requires.
- Add a per-bearer-hash cap (e.g. 32).
- Optionally, add a `verifyBearer` hook the root can supply from identity.

### P2-6: legacy-session unknown methods and notifications get HTTP 404, which the 2025-11-25 transport reserves for "session terminated"
`src/front/contract.ts:235`.
Scenario (probe F2): inside a live session, `resources/list`, `prompts/list` and `notifications/cancelled` all get
**HTTP 404**. The spec says a client receiving 404 for a request with a session id "MUST start a new session" [V,
2025-11-25 transports]. A cancel notification or a capability-agnostic listing call then makes a compliant client throw
away a valid session. Whether Codex/rmcp sends these is [H]. The pin says "-32601" but does not give an HTTP status.
Fix: inside a valid session, answer an unknown request with 200 and JSON-RPC `-32601`, and answer any notification with
202. Keep 404 only for an unknown, expired or foreign session.

### P3-1: late losing clicks never get the "already decided" ephemeral
`src/approvals/slack.ts:244` deletes `justSettled` in a microtask. Only clicks in the same tick get the reply that
ADR-006's `PendingApproval` doc promises. Later clicks are silently ignored. The decision is still correct. Keep it for
about 30 s (bounded map), or adjust the doc.

### P3-2: the Socket Mode URL host is not restricted
`src/approvals/slack.ts:133` accepts `wss:` to any host, even with a loopback base. No token is sent to that URL, so
this is hardening only: require `*.slack.com` when using the default base.

### P3-3: legacy initialize errors carry a stale message
The `fail()` helper (`src/front/contract.ts:216-217`) appends `INITIALIZE_MESSAGE` ("speaks MCP 2026-07-28 only (no
initialize handshake)") and `data.supported: ["2026-07-28"]` to the legacy-initialize 400 (-32602) and 503 (probe F1
output). That is now false and points legacy clients the wrong way. Skip the append on the legacy branch.

### P3-4: no regression test for the SDK 1.x empty priming event
The behaviour is correct (probe U1), but nothing pins it. Add `id: x\ndata: \n\n` before the response in the
`FakeMcpFetch.ok()` SSE mode, or as an `SseParser` row.

### P3-5: tests changed outside Package A's ownership list
`test/server.test.ts` and `test/e2e-slice-2a.test.ts` were edited (expectations updated for ADR-016). The changes are
reasonable, but they are outside A's ownership list, so the coordinator should accept them explicitly.

### P3-6: a malformed `tls` option is not validated
`opts.tls` is not checked as non-empty `cert`/`key` Buffers before `https.createServer`. The test "refuses invalid TLS
material before listening" covers bad PEM. A `tls: {}` would build a TLS server that fails every handshake. This is
never plaintext, so it is a nit.

## Tests: would they fail on the old code?
- Approvals: yes, trivially. The old exports threw `notImplemented`, and the forged-field and race rows assert real
  behaviour.
- Upstream: Astra reports 28 failing before the implementation. By reading:
  - the CR-terminal row fails on the old parser, which held a trailing CR until the next byte;
  - the `default`/`example` traversal row fails on the old walk, which recursed into every key.
- Front: Astra revert-checked the BOM and disconnect-slot rows (the latter asserts the P2-4 behaviour).

Gaps:
- auth retry (P2-1)
- re-init failure recovery (P2-2)
- legacy invalid annotations (P2-3)
- session flood by garbage bearers (P2-5)
- the priming event (P3-4)

## Probes (scratch only)
`/private/tmp/claude-501/fable-2b-probes/probe.test.ts` (A1, U1, U2, F1-F3) and `probe2.test.ts` (U3). Run with:
`node_modules/.bin/vitest run --root /private/tmp/claude-501/fable-2b-probes --reporter=verbose --silent=false`

GATE: PASS (no P1; P2-1..6 go to Astra's fix round, and any still open after verification become todo/residuals per the
build loop)
