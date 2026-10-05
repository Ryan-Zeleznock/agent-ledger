# Slice 2b: Slack approvals, the legacy-era MCP bridge, cheap hardening. Work split and interface pins (architect, 2026-10-04)

Goal (Ryan, 2026-10-04): (1) "who approved this risky action" answered end to end in server mode (CC8.1): the proxy asks
in Slack over Socket Mode, a person on the approver allowlist clicks, and the intent record stores the FINAL
`ApprovalResult` with that person's Slack user id; timeout or Slack unavailable = deny. (2) REAL third-party MCP servers
(SDK 1.x, `initialize`/session era) sit behind the proxy, and legacy clients (Codex) can reach it. (3) Cheap hardening:
TLS, upstream discover retry at startup, the three verification P2s, the runbook fixes the live lab run found. Master
`1998fc7` (tag `slice-2a` + the digest-pin commit). Format follows `slice-2a-pins.md`.

Both builders code against these pins. Neither edits the other's folders. If a pin is wrong, STOP and say so in your final
report; do not silently diverge. Items marked **ADR-015** / **ADR-016** / **ADR-017** are implemented only after Ryan accepts
the ADR (`~/Desktop/AgentLedger/decisions/`). Nothing in this slice touches `~/.claude`, `~/.codex`, a real project, or the
cluster: every cluster-changing command is a numbered step in `docs/HOMELAB.md` that Ryan runs himself. ADR-014
(execution isolation) stays a proposed Slice 3 candidate: nothing here builds toward it or forecloses it.

**Staffing (Ryan, 2026-10-04): Astra gets the larger package.** Astra's sandbox has no network, cannot run Postgres and
cannot bind loopback, so Package A is specified so that every acceptance test runs IN-PROCESS (injected `fetch` /
`WebSocket` / clock / request handler fakes); the coordinator runs the loopback, Postgres and e2e suites outside the
sandbox. Package B (Fable) holds everything that needs the network, live services, spec research or the cluster runbook.

## 0. Due-diligence findings this slice is designed around

All read on **2026-10-04** from the primary sources named. [V] verified, [H] hypothesis. Quotes verbatim.

**MCP eras** (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning;
`.../2026-07-28/basic/transports/streamable-http` "Backward Compatibility"; `.../2026-07-28/schema`)
- [V] "**Legacy**: protocol versions that establish a session with an `initialize` handshake (`2025-11-25` and earlier)."
  "**Modern**: ... (revision `2026-07-28` and later)." "**Dual-era**: an implementation that supports both."
- [V] Dual-era client over HTTP: "attempt a modern request first. On `400 Bad Request`, the client **SHOULD** inspect the
  response body before falling back ... If the body contains a recognized modern JSON-RPC error, the server speaks a modern
  version of MCP ... If the body is empty or is not a recognized modern JSON-RPC error, fall back to `initialize` and
  continue with the legacy version for subsequent requests." Matrix, Dual-era → Legacy: "the modern request returns a `4xx`
  without a recognized modern error body, and the client falls back to `initialize` (and possibly further to the
  deprecated HTTP+SSE transport)." "Clients **SHOULD** cache the result for the lifetime of the ... origin (HTTP)".
- [V] Modern protocol error codes: `-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability, `-32022`
  UnsupportedProtocolVersion (schema page). These three are the "recognized modern errors" (pin 4).
- [V] Dual-era server: "A request carrying modern per-request `_meta` is served statelessly according to this revision. An
  `initialize` request selects legacy semantics, scoped to ... the session (HTTP)". "A dual-era server **MAY** serve both
  eras concurrently on the same endpoint".
- [V] HTTP+SSE (2024-11-05) is "Deprecated ... New implementations **SHOULD NOT** adopt it" → not implemented (refused).

**MCP 2025-11-25 (the newest legacy revision)** (https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle,
`.../2025-11-25/basic/transports`)
- [V] `initialize` params: `protocolVersion`, `capabilities`, `clientInfo {name, version}`; result: `protocolVersion`,
  `capabilities`, `serverInfo`, `instructions?`. "If the server supports the requested protocol version, it **MUST** respond
  with the same version. Otherwise, the server **MUST** respond with another protocol version it supports"; "If the client
  does not support the version in the server's response, it **SHOULD** disconnect." Then "the client **MUST** send an
  `initialized` notification" (`notifications/initialized`).
- [V] Sessions: the server "**MAY** assign a session ID at initialization time, by including it in an `MCP-Session-Id`
  header on the HTTP response containing the `InitializeResult`"; "The session ID **MUST** only contain visible ASCII
  characters (ranging from 0x21 to 0x7E)"; the client "**MUST** include it ... on all of their subsequent HTTP requests";
  "Servers that require a session ID **SHOULD** respond to requests without an `MCP-Session-Id` header (other than
  initialization) with HTTP 400"; after termination the server "**MUST** respond to requests containing that session ID
  with HTTP 404"; on 404 the client "**MUST** start a new session"; DELETE terminates ("The server **MAY** respond ... with
  HTTP 405"). "the client **MUST** include the `MCP-Protocol-Version: <protocol-version>` HTTP header on all subsequent
  requests"; a server without it "**SHOULD** assume protocol version `2025-03-26`"; invalid/unsupported → `400`.
- [V] Legacy SSE: "The server **MAY** send JSON-RPC *requests* and *notifications* before sending the JSON-RPC *response*";
  GET "**MUST** either return `Content-Type: text/event-stream` ... or else return HTTP 405".
- [V] stdio: newline-delimited, "**MUST NOT** contain embedded newlines" (stdio stays 2c).

**The real legacy server we prove against** (npm registry, read 2026-10-04): [V] `@modelcontextprotocol/sdk` `latest` =
**1.32.0** (still no 2.x). [V] `@modelcontextprotocol/server-everything` `latest` = **2026.8.31** (published
2026-08-31T20:23:50Z), deps `@modelcontextprotocol/sdk ^1.30.0`, `express ^5.2.1`, `cors`, `zod ^4`, `jszip`; tarball
integrity `sha512-5U3OZh8Xq0Li4nA26l6uNvV9/1suMDuWSn+NjLZIhzinhMY6N3A4DCrxVecBGPf2PsNFKTEv5krxGPRwzxc7jQ==`. Read from
the tarball: `mcp-server-everything streamableHttp` serves `POST|GET|DELETE /mcp` on `process.env.PORT || 3001`,
`sessionIdGenerator: randomUUID`, no auth; a POST without `mcp-session-id` that is not `initialize` gets `400` with
JSON-RPC `-32000` ("Bad Request: No valid session ID provided" or the SDK's not-initialized error), which is NOT a
recognized modern error → legacy fallback, exactly the spec's path. Base tools: `echo`, `get-sum`, `get-env` (returns
`JSON.stringify(process.env)`), `get-tiny-image`, `get-annotated-message`, `get-structured-content`, `get-resource-links`,
`get-resource-reference`, `gzip-file-as-resource` (fetches a URL: SSRF-shaped), `toggle-simulated-logging`,
`toggle-subscriber-updates`, `trigger-long-running-operation`, `simulate-research-query`; sampling/elicitation/roots tools
register only when the client declares those capabilities, and the proxy declares `{}`. It is a harmless reference server
whose `get-env` is the natural "risky" tool for the Slack demo. Docker Hub `mcp/everything` is `latest`-only (Kyverno
forbids it, 2a §0), so we build our own image from a lockfile pinned to that integrity (pin 10).

**Slack** (docs.slack.dev, read 2026-10-04; extends the 2026-09-29 facts already in `src/approvals/contract.ts`)
- [V] Socket Mode (`/apis/events-api/using-socket-mode/`): "Call the `apps.connections.open` endpoint with your app-level
  token to receive a WebSocket URL"; first frame `{"type":"hello", "connection_info":{"app_id":...}, "num_connections",
  "debug_info":{"approximate_connection_time"}}`; envelopes `{ payload, envelope_id, type, accepts_response_payload }`, ack
  `{ envelope_id, payload? }`; "Your app still needs to acknowledge receiving _each event_"; disconnect frames `{"type":
  "disconnect","reason":"warning|refresh_requested|link_disabled"}` ("warning" comes "10 seconds before the disconnect");
  "Connections refresh regularly. You should be ready to receive and connect to new WebSocket URLs as quickly as possible";
  "up to 10 open WebSocket connections"; **"When multiple connections are active, each payload may be sent to _any_ of the
  connections."** `&debug_reconnects=true` shortens a connection to 360 s (used by the live reconnect step).
- [V] `apps.connections.open` (`/reference/methods/apps.connections.open`): POST, app-level token in `Authorization`,
  response `{ ok, url }`, errors incl. `invalid_auth`, `not_allowed_token_type`, Tier 3. Scope page `connections:write`:
  "Grants permission to generate websocket URIs and connect to Socket Mode", token type "App-level".
- [V] Interactivity (`/interactivity/handling-user-interaction`): the ack "must be sent within 3 seconds of receiving the
  payload. If your app doesn't do that, the Slack user who interacted with the app will see an error message."
  `response_url`: "up to 5 times within 30 minutes".
- [V] `block_actions` payload (`/reference/interaction-payloads/block_actions-payload`): `user {id, team_id}` ("The user who
  interacted to trigger this request"), `team` ("Null if the app is org-installed"), `api_app_id`, `container
  {message_ts, channel_id}`, `channel`, `message`, `actions[] {action_id, block_id, value, action_ts, type}`.
- [V] `chat.postMessage`: bot `chat:write` (+ `chat:write.public` for channels the bot is not in), returns `ts` and
  `channel`; "1 message per second to a specific channel"; `not_in_channel`; `text` is the notification fallback with
  blocks. `chat.postEphemeral`: `chat:write`, user must be in the channel, "delivery is not guaranteed", Tier 4.
  `auth.test`: "No scopes required", returns `team_id`, `user_id`, `bot_id` (`enterprise_id` on Enterprise).
- [V] Manifest (`/reference/app-manifest`): `settings.socket_mode_enabled`, `settings.interactivity.is_enabled` (the
  `request_url` "is optional, not mandatory when Socket Mode is enabled"), `oauth_config.scopes.bot`,
  `settings.token_rotation_enabled`, `settings.org_deploy_enabled`, `features.bot_user.display_name`.
- [V] Node 24 has a global, stable `WebSocket` (https://nodejs.org/docs/latest-v24.x/api/globals.html: added v21.0.0,
  "no longer experimental as of v22.4.0", no flag) → **no new dependency** for the Socket Mode client.
- **Consequence A (design-changing):** one Slack app's interactive payloads go to ANY of its open connections. The
  contract's "ONE router per process" is right inside one process, but two processes on the same app (two proxy replicas,
  or a proxy plus Codex hook handlers, or two concurrent hook handlers) each receive clicks meant for the other, ack them,
  and drop them: the approval then times out (a deny, so fail closed, but the human's click is lost). Hence: the proxy
  Deployment is pinned to `replicas: 1` with a check, the Slack app is dedicated to that one proxy, and **decide-only
  (Codex hook) Slack is deferred to 2c** (needs a per-host router daemon or an HTTP interactivity endpoint). ADR-015.

**Claude Code client timing** (https://code.claude.com/docs/en/env-vars, read 2026-10-04): [V]
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`: "When a stdio, HTTP ... MCP server sends no response and no progress notification for
this long, the tool call aborts with an error"; "per-transport defaults of 300000 (5 minutes) for network servers"; "A
per-server `timeout` in `.mcp.json` of at least 1000 raises that server's idle window to at least the `timeout` value";
"capped at the effective `MCP_TOOL_TIMEOUT`" (that variable's default is not on the page: [H]). **Consequence B:** the
proxy answers `tools/call` as one JSON response with no progress, so a Slack wait + upstream call must finish inside the
client's idle window: the proxy's `timeoutMs` is capped at **240 000 ms** (240 s + 30 s upstream timeout + margin < 300 s);
default 180 000. HOMELAB step 12b sets `"timeout": 600000` on the proxy in the sandbox `.mcp.json` as belt and braces and
live-checks a 3-minute approval.

**TLS** [V]: the lab has no cert-manager CRDs and no IngressClass (`kubectl get crd`, `kubectl get ingressclass`,
read-only, 2026-10-04). Claude Code (https://code.claude.com/docs/en/network-config): "configure Claude Code to trust it
directly: `export NODE_EXTRA_CA_CERTS=/path/to/ca-cert.pem`"; the debug log confirms "CA certs: Appended extra
certificates from NODE_EXTRA_CA_CERTS". [H] it applies to HTTP MCP connections (the page speaks of API requests; HOMELAB
step 12b verifies). **Choice:** the proxy terminates TLS itself (`node:https`, TLS ≥ 1.2) with a server cert signed by a lab
CA Ryan creates with `openssl` on the Mac; no new controller in the cluster. ADR-017.

**Cluster facts for the runbook fixes** (read-only kubectl, 2026-10-04): [V] `kubectl auth can-i get|list|watch pods
--subresource=ephemeralcontainers --as=system:serviceaccount:kyverno:kyverno-reports-controller` → `no` ×3 (while `list
pods` → `yes`); ClusterRole `kyverno:reports-controller` aggregates `rbac.kyverno.io/aggregate-to-reports-controller:
"true"`; reports-controller image `reg.kyverno.io/kyverno/reports-controller:v1.19.1`. Our ValidatingPolicy matches
`pods/ephemeralcontainers` → the fix is one small aggregated ClusterRole (pin 11). [V] `local-path-config` ConfigMap's
`helperPod.yaml` currently says `image: docker.io/library/busybox:1.37.0` (Ryan's live patch); the upstream v0.0.37
manifest ships an untagged `busybox`, which the cluster's `disallow-latest-tag` blocks → step 1 gains the patch.

## Ownership (disjoint)

- **Package A, Astra (Codex), role briefs `.claude/agents/backend-builder.md` (approvals, upstream, front) and
  `test-engineer.md` (in-process fakes)** (branch `slice-2b-modules`, worktree `~/agent-ledger-astra`), **the larger
  package (~60%)**: `src/approvals/**` (the whole Slack implementation: pin 1), `src/upstream/**` (dual-era client, SSE CR
  P2, `x-mcp-header` traversal P2: pin 2), `src/front/**` (dual-era front for legacy clients, TLS option, BOM P2,
  traversal P2, admission assertions: pin 3), `test/approvals*.test.ts` (keep `approvals-shape.test.ts` green),
  `test/upstream*.test.ts`, `test/front*.test.ts`, `test/helpers/fake-slack-transport.ts`, `test/helpers/fake-mcp-fetch.ts`,
  `test/helpers/inproc-http.ts`, `test/todo/approvals.todo.md`, `test/todo/front.todo.md`, `test/todo/upstream.todo.md`.
  Size estimate: ~1,000 lines of source, ~1,300 lines of tests. Every acceptance test runs with no socket bound and no
  network (in-process fakes, `vi.useFakeTimers`); the coordinator runs the existing loopback suites
  (`test/front.test.ts`, `test/upstream.test.ts`) outside the sandbox and reports failures back.
- **Package B, Fable (Claude Code), role brief `.claude/agents/backend-builder.md` (server root) plus the deployment and
  runbook** (branch `slice-2b-server`, worktree `~/agent-ledger-fable`), **~40%**: `src/server/**` (approvals wiring,
  `approvals.yaml`, TLS files, upstream connect retry, shutdown order, smoke flags: pin 6), `deploy/**` (Secrets wiring,
  `replicas: 1` + `Recreate`, HTTPS probes, Slack egress, the `everything` upstream image + Deployment + NetworkPolicy,
  Kyverno reports RBAC, projected-token rule, digest pins, `deploy/slack/app-manifest.yaml`: pins 7-10), `Dockerfile`,
  `docs/HOMELAB.md` (pin 11), `deploy/README.md`, `test/server*.test.ts`, `test/smoke*.test.ts`,
  `test/e2e-slice-2b.test.ts`, `test/helpers/fake-slack.ts` (a real loopback Slack API + Socket Mode server),
  `test/helpers/legacy-upstream.ts`, `test/helpers/legacy-client.ts`. Size estimate: ~250 lines of source, ~250 lines of
  YAML, ~200 runbook lines, ~700 lines of tests/helpers. Holds everything needing network (npm lockfile for the
  `everything` image, digest resolution), loopback (e2e, fake Slack server), or live verification.
- **Nobody touches:** `src/types/**` (no frozen-type change this slice: every pin below is additive to a module or lives in
  config), `src/pipeline/**` (its slack branch already exists and is pinned by tests), `src/hooks/**`, `src/policy/**`,
  `src/identity/**`, `src/ledger/**`, `src/anchor/**`, `src/report/**`, `src/secrets/**`, `src/cli/**`, `policies/**`,
  `package.json`/`package-lock.json` (**no new dependency**: Node's global `WebSocket`, `node:https`), `docs/spec.md` (the
  coordinator applies the spec sentences named in the ADRs after Ryan accepts them), `~/.claude`, `~/.codex`, the cluster.

## Pin 1: `src/approvals` (A): the Slack implementation behind the frozen contract (**ADR-015**)

The frozen signatures stay exactly as in `contract.ts` (`requestApproval`, `validateSlackChannel`,
`getSlackApprovalRouter`, `PendingApproval`, the constants). The pipeline imports the two functions statically, so the
test/e2e seam is a module-level, set-once configuration. **Additive exports:**

```ts
export const SLACK_API_BASE_URL = "https://slack.com/api/" as const;
export const SLACK_PROXY_MAX_TIMEOUT_MS = 240_000;   // Claude Code's 300 s idle window minus upstream 30 s minus margin (§0 B)
export const SLACK_HTTP_TIMEOUT_MS = 10_000;          // per Web API call
export interface WebSocketLike { readyState: number; send(data: string): void; close(code?: number): void;
  addEventListener(type: "open" | "message" | "close" | "error", fn: (ev: { data?: unknown }) => void): void; }
export interface SlackApprovalsConfig {
  apiBaseUrl?: string;                                 // exactly SLACK_API_BASE_URL, or http://127.0.0.1:<port>/api/ (tests, e2e)
  fetch?: typeof fetch; WebSocket?: new (url: string) => WebSocketLike;
  now?: () => number; randomBytes?: (n: number) => Buffer; readSecret?: (ref: SecretRef) => Promise<string>;
}
/** Once per process, before the first register/validate. A second call, or a call after a router exists, throws. */
export function configureSlackApprovals(cfg: SlackApprovalsConfig): void;
/** Live check for the server root's start: auth.test (bot) + apps.connections.open (app) + the hello frame, then closes. */
export function probeSlack(channel: SlackChannel): Promise<{ ok: true; teamId: string; botUserId: string; appId: string } | { ok: false; reason: string }>;
/** Shutdown: every pending approval settles `unavailable` ("proxy shutting down"), sockets close. Idempotent. */
export function closeSlackApprovals(): Promise<void>;
```

Behaviour beyond the contract text (all of the contract's flow, nonce, compare-and-set and router rules stand):
- **Secrets.** Default `readSecret`: `env` → `process.env[name]`; `file` → `O_NOFOLLOW` open, regular file, owned by this
  uid, `mode & 0o077 === 0`, ≤ 4 KiB, trimmed, non-empty (the same rule as `src/server/files.ts`; re-implemented here
  because modules do not import each other). `validateSlackChannel` additionally requires `botToken` to start `xoxb-` and
  `appToken` to start `xapp-`; problems name the field, never the value.
- **Web API.** `POST <apiBaseUrl><method>`, `Authorization: Bearer <token>`, `Content-Type: application/json;
  charset=utf-8`, `SLACK_HTTP_TIMEOUT_MS`, redirects are errors. A reply is ok only if HTTP 200 and `ok === true`. A Slack
  `error` string is copied into a reason only if it matches `^[a-z_]{1,64}$`, else `error`. `429` on `chat.postMessage` →
  one retry after `Retry-After` when ≤ 5 s and inside the wait, else `unavailable`.
- **WebSocket URL.** From `apps.connections.open`; must be `wss:` when `apiBaseUrl` is the default, and may be
  `ws://127.0.0.1:<port>/…` only with a loopback `apiBaseUrl`; anything else → `unavailable` (a token must never follow an
  unexpected scheme or host).
- **Router.** Ack every envelope with `{"envelope_id": …}` synchronously on receipt (Slack's 3 s rule), before any
  parsing beyond `envelope_id`. `hello` stores `connection_info.app_id`. `type: "interactive"` with `payload.type ===
  "block_actions"` is the only actionable type; others are acked and ignored. `disconnect` `warning` | `refresh_requested`
  → open the NEW connection first, keep the old until the new `hello` arrives (both sockets dispatch into the same pending
  map); `link_disabled` → settle all pending `unavailable`. Unexpected close while pending > 0 → reconnect with backoff
  1 s, 2 s, 4 s; three failures → settle all pending `unavailable`. Pending reaches 0 → close.
- **Click acceptance** (all must hold, else acked and ignored): `payload.api_app_id` equals the hello `app_id`;
  `user.team_id` equals `auth.test` `team_id` when both are present (no external Slack Connect approver);
  `actions.length === 1`; `action_id ∈ SLACK_ACTION_IDS`; `block_id === SLACK_BLOCK_ID_PREFIX + callId`; `value` matches
  `SLACK_BUTTON_VALUE_RE` and its callId equals the block's; nonce, `container.message_ts`/`message.ts` and
  `container.channel_id`/`channel.id` equal the pending request's; `user.id ∈ approvers` (else a best-effort
  `chat.postEphemeral` "only the configured approvers can decide"; its failure changes nothing).
- **Results (exact).** approved: `{ decision: "approved", approver: user.id, reason: "slack: Approve clicked by <user.id>" }`;
  denied: same with `"Deny"`; timeout: `"no approver answered within <ms> ms"`; unavailable: `"Slack unreachable: <step>"`
  with `<step>` one of `secret`, `auth.test: <code>`, `apps.connections.open: <code>`, `websocket`, `chat.postMessage:
  <code>`, `link_disabled`, `proxy shutting down`. `channel: "slack"`, `callId` echoed, `decidedAt` ISO.
- **Message.** `text` fallback `Agent Ledger: approval needed for <server>/<tool> (<risk>)`; a `section` (mrkdwn) with
  agent, `server/tool`, risk, `ruleId`, the policy reason, and `argsPreview` from the STORED call the pipeline passes (clear
  fields + `hmac-sha256:` values only; JSON, ≤ 1,500 chars, `&`, `<`, `>` escaped so no mention or link can be injected);
  a `context` with callId and `expiresAt`; the `actions` block (`block_id` = `agent-ledger:call:<callId>`): Approve
  (`primary`, `confirm` dialog naming `server/tool`), Deny (`danger`). After settlement `chat.update` replaces the actions
  block with a context line: `Approved by <@U…> at <ISO>` / `Denied by …` / `Expired after <ms> ms` / `Not decided: Slack
  unavailable`. Failed update → decision unchanged.
- **Never** in any log, error, reason, record or Slack text: either token, the nonce, raw argument values.

## Pin 2: `src/upstream` (A): dual-era client (**ADR-016**)

`connectUpstreams(config, secrets)` keeps its signature. Additive: `UPSTREAM_LEGACY_VERSIONS = ["2025-11-25",
"2025-06-18", "2025-03-26"] as const`; `MODERN_ERROR_CODES = [-32020, -32021, -32022] as const`; `Upstream.eras:
Readonly<Record<string, "modern" | "legacy">>` (like `rejectedTools`, additive). The implementation calls the global
`fetch` at request time (so tests stub it with `vi.stubGlobal`; no injection parameter is added).

**Era detection, per upstream, once per process** (spec "Backward Compatibility"): the existing modern `server/discover`.
- `200` + a valid discover result → modern (lists `2026-07-28`, else refuse as today).
- `4xx` whose body is a JSON-RPC error with `code ∈ MODERN_ERROR_CODES` → a modern server rejecting us → refuse (value-free:
  upstream name, status, code). Never fall back on a modern error.
- `401` / `403` → refuse (an auth failure is never a reason to downgrade). `5xx`, network error, timeout → throw
  `UpstreamUnavailable` (new exported class, `name` = `"UpstreamUnavailable"`), which the server root retries (pin 6).
- `400` / `404` / `405` with an empty, non-JSON or non-modern body → **legacy**.
**Legacy session:** `POST initialize` (headers `Content-Type`, `Accept: application/json, text/event-stream`, bearer when
configured; no `MCP-Protocol-Version` header and no modern `_meta`), params `{ protocolVersion: "2025-11-25",
capabilities: {}, clientInfo: { name: UPSTREAM_CLIENT_NAME, version } }`; JSON or SSE response (the existing `SseParser`,
settle on the response with our `id`). `result.protocolVersion ∉ UPSTREAM_LEGACY_VERSIONS` → refuse (best-effort DELETE).
`Mcp-Session-Id` response header: optional; when present it must be 1-256 chars of 0x21-0x7E, else refuse. Then `POST
notifications/initialized` (any 2xx). Every later request carries `MCP-Session-Id` (when assigned) and
`MCP-Protocol-Version: <negotiated>`, no `Mcp-Method`/`Mcp-Name`/`Mcp-Param-*` (2026-07-28 features), no modern `_meta`.
`tools/list` with `nextCursor` pagination, the same tool-name, uniqueness and result validation as today (legacy results
carry no `resultType`: treated as complete; `x-mcp-header` annotations are ignored for legacy upstreams).
- A JSON-RPC **request** from the server on a response stream (has `method` and `id`) → that call throws `UpstreamError`
  ("upstream sent a server-to-client request; not supported"): we declared no client capabilities, and hanging is worse.
- `404` on a request that carried a session id → re-initialize ONCE (single-flight across concurrent calls) and resend the
  request once. Safe for `tools/call` because the 2025-11-25 transport says the server "**MUST** respond to requests
  containing that session ID with HTTP 404" after terminating it, i.e. the call was not processed. A second `404` → throw.
- `close()`: abort in-flight (as today), then best-effort `DELETE` with the session id (2 s, `405` fine).
- HTTP+SSE (2024-11-05) is never probed (no GET). stdio stays `notImplemented` (2c).
**P2s:** `SseParser` dispatches a CR-terminated line immediately and swallows a directly following LF (test: CR-only
stream with the terminal event last, and CRLF split across chunks); `headerParams` walks schema-valued keywords only
(`properties` chain per the transport), never `default`/`example`/`examples`/`const`/`enum` data (test: a valid tool whose
`default` contains an object with an `x-mcp-header` key is accepted).
**Tests (A, in-process):** `test/helpers/fake-mcp-fetch.ts` = a `fetch` implementation backed by an in-memory 2025-11-25
server (sessions, SSE or JSON per request, scripted 400/404/405/5xx, server-to-client request injection, session expiry)
and by the existing modern behaviour; every rule above is a row.

## Pin 3: `src/front` (A): legacy-era clients on the same endpoint, TLS, P2s (**ADR-016**, **ADR-017**)

Why: Claude Code v2 reaches the modern-only proxy fine ([V] home lab 2026-10-04, research.md), but ADR-006 routes Codex's
MCP through the proxy, and every SDK-1.x client (Codex's included [H]) is legacy-era. The spec lets one endpoint serve both.
Additive exports: `FRONT_LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const`,
`FRONT_MAX_LEGACY_SESSIONS = 1024`, `FRONT_LEGACY_SESSION_IDLE_MS = 3_600_000`, `HttpFrontOptions.tls?: { cert: Buffer;
key: Buffer }`, `createFrontServer(handler, opts): http.Server | https.Server` (built, NOT listening; `startFront` listens
on it; tests feed it in-memory connections).

Order of checks: unchanged through JSON-RPC shape validation (Origin, bearer, size, content type, JSON, `-32600`). Then:
- **`Mcp-Session-Id` present → legacy session request.** Unknown id, idle-expired id, or an id minted for a DIFFERENT
  bearer (sessions store SHA-256 of the token, compared constant-time) → `404` with a JSON-RPC error and no `id` echo of
  the session. `MCP-Protocol-Version` must equal the session's negotiated version; absent is accepted only when the
  negotiated version is `2025-03-26` (the transport's SHOULD-assume rule); else `400` `-32600`. Methods:
  `notifications/initialized` → `202`; `ping` → `{}`; `tools/list` → `{ tools }` (legacy shape: no `resultType`/`ttlMs`/
  `cacheScope`, same exposed names, sort, descriptions and schemas as modern); `tools/call` → the SAME exposed-name lookup,
  argument checks, admission (`maxInFlight`) and `IncomingCall` as modern (fresh `callId`; credential = the bearer), result
  `{ content, isError }`; anything else → `-32601`. Responses `application/json`, `Mcp-Session-Id` not echoed.
- **No session header, `method === "initialize"`, no `MCP-Protocol-Version` header and no modern `_meta.protocolVersion`
  → legacy initialize.** `params.protocolVersion` a string, `params.capabilities` an object (else `-32602`). Negotiated =
  the requested version if in `FRONT_LEGACY_VERSIONS`, else `"2025-11-25"` (MUST answer with one it supports). Mint
  `randomUUID()` as the session id (CSPRNG, visible ASCII) → response header `Mcp-Session-Id`; result `{ protocolVersion,
  capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version }, instructions: DISCOVER_INSTRUCTIONS }`. Over
  `FRONT_MAX_LEGACY_SESSIONS` live sessions → `503` `-30503`. Idle sessions expire after `FRONT_LEGACY_SESSION_IDLE_MS`.
- **`DELETE /mcp`** with a valid bearer and a live session it owns → `204` and the session is gone; any other DELETE → `405`
  as today. `GET /mcp` → `405` (allowed by the legacy transport). `Last-Event-ID` stays ignored.
- Everything else (modern requests, the modern `initialize` with headers → `404` `-32601` + `INITIALIZE_MESSAGE`) is
  unchanged. Session ids are never logged and never reach a record (records' `sessionId` comes from identity).
- `stop()` also drops all legacy sessions (clients re-initialize on `404`, as the transport requires).
**TLS:** `tls` present → `https.createServer({ cert, key, minVersion: "TLSv1.2" })`, same routes (`/healthz` included);
absent → plain `http` as today. The front never reads files (the server root does).
**P2s:** `decodeSentinel` uses `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })` (a value starting with U+FEFF
round-trips exactly); `headerParams` traversal fix as pin 2; the two missing assertions (disconnect releases the admission
slot; `503` while stopping) from `front.todo.md`.
**Tests (A, in-process):** `test/helpers/inproc-http.ts` drives `createFrontServer(...)` through `stream.duplexPair()`
connections (`server.emit("connection", socket)`; plain HTTP and, for TLS, `tls.connect({ socket })` with a throwaway
self-signed pair generated in the test via `crypto.generateKeyPairSync` + a checked-in test certificate fixture
`test/fixtures/tls/` made once by the coordinator if the sandbox cannot run `openssl`). Rows: every bullet above, plus a
legacy client and a modern client interleaved on one server, and a session reused with another agent's bearer → `404`.

## Pin 4: legacy compatibility between A's two halves

The front's legacy server path and the upstream's legacy client must interoperate with each other AND with the SDK 1.x
reference server. A's in-process tests connect the upstream client to the front via `fake-mcp-fetch` → `createFrontServer`
adapter (one row: legacy upstream client → our legacy front → demo handler). B's e2e proves both against real processes
and against `server-everything` (pin 8). Shared literal: both use `"2025-11-25"` as the preferred legacy version.

## Pin 5: approvals config and secrets layout (B implements; A's `readSecret` reads the files)

`<AGENT_LEDGER_CONFIG_DIR>/approvals.yaml` (read through the shared `readConfigFile`/`parseConfigDocument`; unknown fields
refused; required only when `AGENT_LEDGER_APPROVALS=slack`):
```yaml
version: 1
slack:
  channelId: C0123456789          # ^[CG][A-Z0-9]{8,}$ (contract)
  approvers: [U0123456789]        # non-empty, ^[UW][A-Z0-9]{8,}$
  timeoutMs: 180000               # integer 1000..240000 (SLACK_PROXY_MAX_TIMEOUT_MS), default 180000 when omitted
  apiBaseUrl: http://127.0.0.1:PORT/api/   # optional; tests/e2e only; must pass pin 1's rule
```
Tokens are NOT in the YAML. The root builds `botToken: { kind: "file", path: "<CONFIG_DIR>/secrets/approvals.botToken" }`
and `appToken: { kind: "file", path: "<CONFIG_DIR>/secrets/approvals.appToken" }`: the same `secrets/` directory and
`<name>.<key>` naming as the file secrets provider (K8s Secret `slack-tokens`, keys `approvals.botToken` and
`approvals.appToken`, staged by the existing `stage-config` initContainer as uid 65532, mode 0600). `approvals` is a
**reserved upstream name**: the root refuses an `upstreams.yaml` entry named `approvals`, so no upstream can ever be handed
the Slack tokens by `secrets.get(name)`.

## Pin 6: the server root (B; `src/server/main.ts`, `smoke.ts`, `client.ts`)

Environment (2a's table plus):

| Variable | Meaning |
|---|---|
| `AGENT_LEDGER_APPROVALS` | `none` (2a behaviour) or `slack` (pin 5 file + tokens). Anything else → refuse |
| `AGENT_LEDGER_TLS` | `on` → `tls.crt` (via `readConfigFile` rules) + `tls.key` (via `readPrivateFile`) from the config dir, passed as `tls` to `startFront`; `off` → plain HTTP and a `{ event: "warning", tls: "off" }` start line. **Required**: absent → refuse (no silent plaintext) |
| `AGENT_LEDGER_UPSTREAM_CONNECT_BUDGET_MS` | integer 0..600000, default 60000: total time `connectUpstreams` is retried at start |

- **Slack start (`slack`)**: parse pin 5 → `configureSlackApprovals({ apiBaseUrl })` (only when the YAML sets it) →
  `validateSlackChannel` must return `[]` → `probeSlack` (retried under the same backoff as upstreams; final failure →
  refuse with its value-free reason) → log `{ event: "approvals", kind: "slack", channelId, approvers: <count>, timeoutMs,
  teamId }` → `createPipeline({ approvals: <SlackChannel> })`. The `listening` line's `approvals` field says `slack`.
- **Upstream connect retry**: attempts at 0, 1, 2, 4, 8, 16, 16, … s until the budget is spent; each failure logs `{ event:
  "upstreams-retry", attempt, nextInMs, reason }` (value-free, as today's refusal text); budget spent → refuse (exit 1, as
  today). Retried on any connect failure (an auth or era refusal is retried too: slower, never wrong). The success line
  gains `eras` (from `Upstream.eras`). The Deployment's `startupProbe` allows ≥ budget + 30 s.
- **Shutdown order (amends 2a F3):** SIGTERM → `closeSlackApprovals()` FIRST (pending approvals become recorded
  `unavailable` denies, so no admitted call waits minutes on a human) → `front.stop()` → `upstream.close()` → outcome
  waits → ledger close → exit 0 within `SHUTDOWN_GRACE_MS`.
- **Smoke** gains `--approvals none|slack` (slack: the `demo__wipe`/`demo__whoami` steps are reported `SKIP (slack: needs
  a human)`), `--ca-file <pem>` (https URLs; `fetch` with a custom CA via `node:https` agent in `client.ts`), and
  `--expect-legacy <server>` (calls `<server>__echo {message:"hello"}` → ok, proving the legacy bridge through the
  proxy). The tool-list check becomes "contains the five `demo__*` names, sorted overall".
- Tests (`test/server.test.ts`, in-process with A's `configureSlackApprovals` and a fake transport once A lands; before
  that, B codes against the pinned exports and the coordinator runs the suite at integration): refusal rows (approvals
  value, missing/malformed `approvals.yaml`, `timeoutMs` 240001, non-loopback `apiBaseUrl`, upstream named `approvals`,
  `AGENT_LEDGER_TLS` absent, key file group-readable), retry timing with fake timers, shutdown order (a pending approval
  is settled `unavailable` and recorded before exit), no token in any output.

## Pin 7: registry rows for the real legacy upstream (B; `deploy/k8s/config/registry.yaml`, Ryan reviews in step 6)

Server name **`everything`** (exposed `everything__<tool>`; `-` is legal in exposed names and in Claude Code tool names):
`everything/echo read storeArgs [message]`, `everything/get-sum read storeArgs [a, b]`, `everything/get-tiny-image read`,
`everything/get-annotated-message read`, `everything/get-structured-content read`, **`everything/get-env risky storeArgs
[]`** (returns the process environment: THE Slack demo tool), **`everything/gzip-file-as-resource risky storeArgs []`**
(fetches a URL; its egress is also denied, pin 9). Every other tool stays unlisted → `unreviewed` → Slack. Argument names
for `storeArgs` are checked against the live `tools/list` in step 6 (B copies them from the server's published
`inputSchema`, never guesses: a wrong name only hashes a field, which fails safe).

## Pin 8: integration seams (B; `test/e2e-slice-2b.test.ts`; A's code + B's root, real processes)

Helpers (B): `test/helpers/fake-slack.ts` = node:http on 127.0.0.1 serving `/api/auth.test`, `/api/apps.connections.open`
(returns `ws://127.0.0.1:<port>/link?ticket=…`), `/api/chat.postMessage`, `/api/chat.update`, `/api/chat.postEphemeral`,
and a WebSocket upgrade on `/link` with minimal RFC 6455 text framing (masking from the client, no extensions; ~120
lines, no dependency). It records every API call (method + JSON body, with the `Authorization` header checked and
dropped), sends `hello`, can inject a `block_actions` envelope built from the posted message (button value, `ts`,
channel; chosen `user.id`), a `disconnect` warning, a forced non-ok, and counts acks by `envelope_id`.
`test/helpers/legacy-upstream.ts` = a hand-written 2025-11-25 server (initialize, `Mcp-Session-Id`, SSE or JSON, DELETE,
tools `echo` and `env`); `test/helpers/legacy-client.ts` = a 2025-11-25 client for the front.
Steps (proxy with `AGENT_LEDGER_APPROVALS=slack`, `apiBaseUrl` = the fake, registry incl. `legacy/echo read`, `legacy/env
risky`, demo rows; `AGENT_LEDGER_TLS=off` except step 9):
1. Start: log lines `approvals` (kind slack, approver count, no token), `upstreams` with `eras: { demo: modern, legacy:
   legacy }`; the fake saw exactly one `auth.test` and one probe connection.
2. `tools/list` (modern client) contains `demo__*` and `legacy__echo`, `legacy__env`.
3. `legacy__echo` → ok through the legacy upstream session; records as in 2a step 3.
4. `demo__wipe` → the fake receives one `chat.postMessage` (two buttons, `block_id` = callId, values `<callId>:<nonce>`, no
   raw arg value in the body); inject Approve from an approver → the call returns ok from the demo upstream; intent record
   `approval { decision: approved, approver: <U>, channel: slack, reason: "slack: Approve clicked by <U>" }`, then an `ok`
   outcome; `chat.update` called once with the same `ts`.
5. `legacy__env` → inject Deny → `isError`, `denied`, `blocked` outcome; the legacy upstream saw NO `tools/call`.
6. Non-approver click then nothing (with `timeoutMs` 2000 in this file) → `timeout` recorded; the fake saw one ephemeral.
7. Forged clicks (wrong nonce, wrong `ts`, wrong channel, other app id) → ignored; a later valid click settles; every
   envelope acked exactly once per delivery.
8. Three concurrent risky calls → one WebSocket; clicks settle each independently; a `disconnect` warning mid-wait →
   new connection opened before the old closes, no `unavailable`.
9. TLS: proxy with `AGENT_LEDGER_TLS=on` and a test cert; `smoke.js --ca-file` → `SMOKE PASS`; a plain-HTTP request to the
   TLS port fails; a client without the CA fails verification.
10. Legacy client → front: initialize, `notifications/initialized`, `tools/list`, `legacy__echo` ok; reuse of its
    session id with another agent's key → `404`; DELETE → `204`, then `404`.
11. Slack unavailable (fake answers `invalid_auth` to `apps.connections.open` after start) → the risky call is
    `unavailable`, recorded, denied. SIGTERM with a pending approval → `unavailable` ("proxy shutting down") recorded, exit 0.
12. `verify` exit 0; the report's CC8.1 table (no report change needed: `src/report/render.ts` already renders these)
    shows `approved, <U>` + `executed after ask` (step 4), `denied: Slack denied` (5), `denied: Slack timeout` (6),
    `denied: Slack unavailable` (11). Leak sweep: both tokens (canaries), nonces, the TLS key, the API key and the legacy session ids absent
    from the ledger, all process outputs, the fake's recorded bodies (except the token checks it drops), and the pack.
13. Gated (`AGENT_LEDGER_E2E_EVERYTHING_DIR` = an `npm ci` of `deploy/upstreams/everything`): spawn
    `server-everything streamableHttp` with `PORT` on loopback; the proxy discovers it as `legacy`; `everything__echo` ok;
    `everything__get-env` → Slack → approve → ok. The coordinator runs this outside the sandbox.

Where two correct halves could still fail together: A's router acks via the fake's framing (B's fake must accept the ack
as a client-masked text frame); A's WebSocket URL check vs. the fake's `ws://127.0.0.1` URL (pin 1 allows it only with a
loopback `apiBaseUrl`: step 1 catches a mismatch); A's legacy front shape vs. B's legacy client (step 10) and vs.
Codex [H] (HOMELAB 12c, optional); the root's shutdown order vs. A's `closeSlackApprovals` (step 11); Claude Code's idle
window vs. `timeoutMs` (only the live step 12b proves it); the `everything` image under `readOnlyRootFilesystem` (express
writes nothing [H]; step 9b shows CrashLoopBackOff otherwise, fix = an `emptyDir` on `/tmp`, never a writable root).

## Pin 9: deployment (B; `deploy/`)

- **Proxy Deployment:** `replicas: 1` AND `strategy: { type: Recreate }` (a RollingUpdate would briefly run two Socket
  Mode routers on one Slack app and lose clicks, §0 A); `deploy/check.mjs` asserts both. Env adds
  `AGENT_LEDGER_APPROVALS=slack`, `AGENT_LEDGER_TLS=on`. `stage-config` also copies `approvals.yaml` (ConfigMap),
  `slack-tokens` (Secret, keys `approvals.botToken`, `approvals.appToken` → `secrets/`), `proxy-tls` (Secret type
  `kubernetes.io/tls`, `tls.crt`/`tls.key` → config dir root), all uid 65532, mode 0600. Probes `scheme: HTTPS`;
  `startupProbe` covers the 60 s connect budget.
- **Egress:** the proxy gains `TCP 443` to `0.0.0.0/0` except `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (Slack Web
  API + Socket Mode; standard NetworkPolicy cannot name FQDNs, and Cilium's `ipBlock` does not match intra-cluster IPs
  anyway, 2a §0). Residual: FQDN-scoped egress (`slack.com`, `*.slack.com`) via CiliumNetworkPolicy is 2c. Proxy egress
  to `everything:3001` added; nothing else changes.
- **`everything` upstream:** Deployment (1 replica) + Service `everything:3001` + NetworkPolicy (ingress only from
  `app: proxy` on 3001; egress: none at all, not even DNS, so `gzip-file-as-resource` cannot fetch). Pod: PSA restricted,
  `automountServiceAccountToken: false`, `enableServiceLinks: false` (so `get-env` shows no Service env), no Secret, env
  `PORT=3001` only, `readOnlyRootFilesystem: true`, `runAsNonRoot`, uid 65532, image
  `ghcr.io/ryan-zeleznock/agent-ledger:everything-2026.8.31@sha256:<digest from step 4b>` (same repository, so the existing
  Kyverno image rule applies unchanged). `upstreams.yaml` gains `{ name: everything, transport: http, url:
  http://everything.agent-ledger.svc.cluster.local:3001/mcp }` (no bearer: the server has no auth; the NetworkPolicy is
  its boundary, stated in HOMELAB residuals).
- **Kyverno reports RBAC** (`deploy/k8s/cluster/kyverno-reports-ephemeralcontainers.yaml`, cluster-scoped, NOT in the
  namespace kustomization; applied by its own HOMELAB step): ClusterRole `agent-ledger:kyverno-reports-ephemeralcontainers`,
  label `rbac.kyverno.io/aggregate-to-reports-controller: "true"`, rules `apiGroups: [""]`, `resources:
  ["pods/ephemeralcontainers"]`, `verbs: [get, list, watch]`. Nothing else.
- **Cheap residuals from `deploy/README.md`:** Kyverno validation rejecting `projected.sources[].serviceAccountToken` + a
  negative Pod `deploy/k8s/test/bad-pod-projected-token.yaml`; resolve and pin `busybox:1.37.0` and
  `postgres:17.11-alpine3.24` by digest (B resolves them from the registries and cites the date) and extend the Kyverno
  digest requirement to those repositories. The other README residuals (DB password files, scram local auth, separate
  integration key) are 2c.

## Pin 10: the `everything` image (B; `deploy/upstreams/everything/`)

`package.json` (`"private": true`, `"dependencies": { "@modelcontextprotocol/server-everything": "2026.8.31" }`, exact),
`package-lock.json` (made with `npm install --package-lock-only --ignore-scripts` by B, who has the network;
`deploy/check.mjs` asserts the lock's `node_modules/@modelcontextprotocol/server-everything` entry has version `2026.8.31`
and integrity `sha512-5U3OZh8X…zxc7jQ==` exactly as §0), `.npmrc` (`ignore-scripts=true`), `Dockerfile`: build stage
`node:24-alpine3.24` → `npm ci --omit=dev --ignore-scripts`; runtime `gcr.io/distroless/nodejs24-debian12:nonroot`, `USER
65532`, `CMD ["node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]`. Built by a second
Kaniko Job from its own `git archive` context (same pattern as 2a step 4), digest recorded by Ryan. Replacing Kaniko is 2c.

## Pin 11: `docs/HOMELAB.md` additions (B writes; Ryan runs each step; each has Changes / command / Verify / Undo)

- **1 (amended): local-path helper pin.** Apply the v0.0.37 manifest with the helper image rewritten to
  `docker.io/library/busybox:1.37.0@sha256:<digest>` (`curl … | sed … | kubectl apply -f -`, the sed shown and reviewed).
  Verify: `kubectl -n local-path-storage get cm local-path-config -o jsonpath='{.data.helperPod\.yaml}' | grep image`.
- **3b (new): Slack app (Ryan, in the Slack UI; nothing runs in the cluster).** Create the app "Agent Ledger" from
  `deploy/slack/app-manifest.yaml`: `display_information.name: Agent Ledger`, `features.bot_user.display_name: agent-ledger`,
  `oauth_config.scopes.bot: [chat:write]` (no `chat:write.public`: the bot is invited to one private channel),
  `settings.socket_mode_enabled: true`, `settings.interactivity.is_enabled: true` (no `request_url`),
  `settings.org_deploy_enabled: false`, `settings.token_rotation_enabled: false`. Install to the workspace → copy the
  **Bot User OAuth Token (`xoxb-`)**. Basic Information → App-Level Tokens → generate one with scope
  **`connections:write`** → copy the **`xapp-`** token. Create a private channel `#agent-ledger-approvals`, `/invite
  @agent-ledger`, copy its channel id (`C…`/`G…`); copy each approver's member id (profile → "Copy member ID", `U…`). Save
  both tokens as files in `~/agent-ledger-lab/.secrets/` (mode 0600, never pasted into a shell command line or the vault).
  This app is dedicated to the ONE lab proxy (§0 A).
- **5b (new): Secrets.** `kubectl -n agent-ledger create secret generic slack-tokens
  --from-file=approvals.botToken=… --from-file=approvals.appToken=…`; `approvals.yaml` (channel id, approver ids,
  `timeoutMs: 180000`) into the ConfigMap kustomization. **TLS:** lab CA + server cert with `openssl` on the Mac (CA key
  stays in `~/agent-ledger-lab/.secrets/`, 0600; server cert SANs: `proxy.agent-ledger.svc`, `proxy.agent-ledger.svc.
  cluster.local`, every node IP from `kubectl get nodes -o wide`; 825-day max validity; P-256), then `kubectl create secret
  tls proxy-tls --cert … --key …`.
- **4b (new):** build the `everything` image (pin 10), record its digest in the kustomization.
- **7b (new): Kyverno reports RBAC.** `kubectl apply -f deploy/k8s/cluster/kyverno-reports-ephemeralcontainers.yaml`.
  Verify: the three `kubectl auth can-i … --subresource=ephemeralcontainers --as=system:serviceaccount:kyverno:kyverno-
  reports-controller` lines print `yes`, and the reports-controller log has no new ephemeralcontainers RBAC error.
  Undo: `kubectl delete clusterrole agent-ledger:kyverno-reports-ephemeralcontainers`.
- **9b (new):** `everything` Deployment/Service/NetworkPolicy; verify Ready, the proxy start line shows `eras: { demo:
  modern, everything: legacy }`, and from a throwaway pod in another namespace `everything:3001` is unreachable.
- **11 (amended):** the integration Job runs `smoke.js --approvals slack --ca-file /mnt/ca/ca.crt --expect-legacy
  everything` (the CA cert, public, mounted from a ConfigMap).
- **12b (new): live Slack approval from Claude Code (sandbox project only).** `.mcp.json` URL `https://<node-ip>:30787/mcp`,
  `"timeout": 600000`; launch with `NODE_EXTRA_CA_CERTS=~/agent-ledger-lab/ca.crt` and `claude --debug` (check the "CA
  certs: Appended" line). Ask Claude to call `everything__get-env`: the Slack message appears; Ryan clicks **Approve**; the
  env text returns. Again → **Deny** → Claude sees the deny. Again → wait out 180 s → `timeout`. (Optional: a second Slack
  account not on the allowlist clicks → ignored + ephemeral.) Also time one approval at ~170 s to confirm the client
  does not abort first.
- **12c (optional, needs Ryan's explicit OK because it configures Codex):** Codex CLI with a sandbox `CODEX_HOME` whose MCP
  config points at the proxy → proves the legacy front with a real legacy client.
- **13 (amended):** the evidence pack's CC8.1 table shows `approved, U…` / `denied: Slack denied` / `denied: Slack timeout`
  rows; anchor copied to the Mac as before.
- **Residuals (amended):** TLS is a lab CA, not a public one; the `everything` upstream has no auth of its own (the
  NetworkPolicy is its boundary); Slack egress is any public IP on 443 (FQDN policy is 2c); ONE proxy replica per Slack app;
  approvers are Slack member ids (names would need `users:read`, 2c); a client that gives up while an approval is pending
  does not cancel it: an approval that arrives later still executes and is recorded (pipeline has no abort input; 2c).

## Gates for both

`npm run typecheck && npm test` green before every commit (master `1998fc7`: `npm run check` green); test-first; tick todo
items; README `Status: implemented` stays on `front`/`upstream`, and `approvals` gains it only when no export is a stub
(with a "decide-only Slack: 2c (ADR-015)" line); commit on your branch only; never merge; never touch the cluster,
`~/.claude`, `~/.codex`. **No new dependency** (any need → STOP and report). Build loop: one full cross-review (B reviews A's
range, A reviews B's), fix, one scoped verification pass; P2s left after verification become todo items.

## Acceptance bar

**Package A (Astra)**
- Tests, all in-process: every open item in `approvals.todo.md` (lines 2-22, with item 2's "both values = callId" read as
  `<callId>:<nonce>` per the contract) against `fake-slack-transport.ts`; pin 1's additions (URL scheme rule, team/app-id
  check, token prefixes, exact reason strings, ack-before-parse, reconnect-before-close, `link_disabled`,
  `closeSlackApprovals`, `configureSlackApprovals` set-once, no token/nonce in any output); pin 2's detection matrix
  (modern, modern-error refuse, 401/403 refuse, 5xx → `UpstreamUnavailable`, legacy on 400/404/405), legacy session
  lifecycle, server-to-client request → error, 404 re-init once, DELETE on close, `eras`; pin 3's legacy front rows, TLS
  through `duplexPair`, the three P2s and the two admission assertions; pin 4's front↔upstream legacy row.
- Todo: `approvals.todo.md` all ticked or rewritten as 2c items (decide-only); `front.todo.md` and `upstream.todo.md`: the
  P2s and the dual-era items ticked; `stdio`, rate limit, `listChanged` refresh rewritten as 2c.
- The coordinator's outside-sandbox run of `test/front.test.ts` and `test/upstream.test.ts` (loopback) stays green.

**Package B (Fable)**
- Tests: pin 6 rows in `test/server.test.ts`; smoke flag rows; `test/e2e-slice-2b.test.ts` steps 1-12 (coordinator runs
  13); `deploy/check.mjs` new invariants (replicas 1 + Recreate, HTTPS probes, Slack egress shape, `everything` policy has
  no egress, lockfile integrity, digest pins, projected-token negative Pod present); `kubectl apply --dry-run=client -k
  deploy/k8s` green.
- Docs: HOMELAB steps 1, 3b, 4b, 5b, 7b, 9b, 11, 12b, 12c, 13 and residuals per pin 11, each with Verify and Undo;
  `deploy/slack/app-manifest.yaml`; `src/server/README.md` and `deploy/README.md` updated.
- Demo steps Ryan runs: HOMELAB 1 → 13 with the new steps; 12b is the slice's headline (a human approval in Slack becomes
  `approved, U…` evidence for an action that only the proxy could perform).

## ADR items (drafted in the vault, `status: proposed`; Ryan accepts or rejects before the marked pins are implemented)

- **ADR-015** (`decisions/ADR-015-slack-approvals-proxy-first.md`): Slack approvals ship in SERVER MODE ONLY this slice;
  decide-only (Codex hook) Slack moves to 2c because one Slack app's payloads go to any of its connections (§0 A); one proxy
  replica + `Recreate` per Slack app; `timeoutMs ≤ 240 000` under Claude Code's 300 s idle window (§0 B); tokens as staged
  Secret files with a reserved `approvals` name; set-once `configureSlackApprovals` seam (additive, no type change);
  team/app-id click checks. Amends ADR-006 item 2's timing ("the first thing built after Gate 2" for hooks) and spec §6's
  hook-Slack text gets a "2c" note. Rejecting it: the fallback is building a per-host router daemon in 2b (≈ the size of
  Package A's approvals work again).
- **ADR-016** (`decisions/ADR-016-dual-era-mcp-bridge.md`): dual-era upstream client and dual-era front per the
  2026-07-28 backward-compatibility rules; legacy versions `2025-11-25`, `2025-06-18`, `2025-03-26`; no HTTP+SSE
  (2024-11-05); `server-everything@2026.8.31` (integrity-pinned, own image) as the first real third-party upstream; amends
  ADR-013 item 5 ("front and upstream speak 2026-07-28 only"); spec §3/§4 gain one sentence each (coordinator).
  Rejecting it: the proxy keeps governing only our own demo server, and Codex cannot use the proxy ADR-006 requires.
- **ADR-017** (`decisions/ADR-017-proxy-tls-lab-ca.md`): the proxy terminates TLS itself with a lab-CA certificate;
  `AGENT_LEDGER_TLS=on|off` is mandatory (no silent plaintext); Claude Code trusts the CA through `NODE_EXTRA_CA_CERTS`;
  cert-manager/Ingress/public CA are deferred (none installed [V]). Rejecting it: plain HTTP stays a stated residual and
  the bearer key crosses the LAN in clear.

## Explicitly 2c (not in this slice)

Decide-only (Codex hook) Slack with a per-host router or HTTP interactivity endpoint (ADR-015); approver display names
(`users:read`); a pipeline abort input so a client that gives up cancels its pending approval; stdio front and stdio
upstream; `env` secrets provider; tool-list refresh/`listChanged`; per-key rate limiting; SSE responses from the front
(and progress notifications during an approval wait, which would lift the 240 s cap); CiliumNetworkPolicy with FQDN egress
for Slack and L7 rules; versioned Postgres migrations; DB password files, scram local auth, separate integration key;
replacing archived Kaniko (BuildKit rootless or buildah); cert-manager/public CA; upstream TLS with a private CA; mTLS
to upstreams; ADR-014 execution isolation (Slice 3 candidate).

## Risks (architect)

- **Click distribution (§0 A) is the sharpest edge.** Any second process holding a Socket Mode connection for the same
  app silently eats clicks (they become timeouts: fail closed, but the demo looks broken). Mitigations: one app per proxy,
  `replicas: 1` + `Recreate` checked, HOMELAB says "do not reuse this app for anything else", and e2e step 8 proves one
  socket per process. Slack's own connection refresh overlaps two sockets of the SAME process: handled by the shared map.
- **Client idle window (§0 B).** If Claude Code's overall `MCP_TOOL_TIMEOUT` default is shorter than documented idle
  behaviour suggests [H], long approvals abort client-side while the approval stays pending (residual above). 12b measures it.
- **Legacy downgrade.** Era detection falls back on a non-modern 4xx; an on-path attacker could force legacy. In-cluster,
  behind NetworkPolicy, acceptable; the era is logged at start; refusing fallback on 401/403 and on modern errors keeps the
  common failure modes from downgrading.
- **SDK 1.x behaviour under our probe.** Read from the tarball, not run: a non-`initialize` POST without a session may make
  the reference server allocate a transport it never stores (a small leak per probe; we probe once per process). Step 13
  and 9b run the real thing.
- **`get-env` is genuinely sensitive in other deployments.** It is the demo's risky tool precisely because it dumps the
  environment; the Pod is built so its environment holds nothing secret (`enableServiceLinks: false`, one variable).
- **Astra's in-process TLS row** needs a certificate fixture; if the sandbox cannot generate one, the coordinator commits
  `test/fixtures/tls/` (test-only self-signed pair, marked as such) before Astra starts.
- **Package A is wide** (three modules). If it runs long, the coordinator may move the dual-era FRONT (pin 3, legacy
  part) to 2c: nothing in priorities 1-2 depends on it except Codex-through-proxy (12c, optional).

## Amendment (coordinator, 2026-10-05)
- Approver display names moved up from 2c (ADR-015 amendment accepted by Ryan 2026-10-05): bot scope `users:read`,
  best-effort `users.info` after the decision settles, optional `ApprovalResult.approverName`; the member id stays the
  identity checked against the allowlist. Legacy session recovery also matches the id-less 400 that server-everything
  2026.8.31 returns. Lines above that defer names to 2c are superseded by this note.
