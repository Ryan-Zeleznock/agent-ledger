# front
Status: implemented

Exposes MCP tools through one dual-era Streamable HTTP endpoint and hands unauthenticated `IncomingCall`s to the
injected handler. Imports only shared types; policy, identity and recording remain in the pipeline. Spec §3/4/6;
Slice 2b pins 3/4, accepted ADR-016/017.

`createFrontServer(handler, opts)` returns an HTTP or HTTPS server without listening. The async tools provider runs
once; requests await table initialization. `startFront` awaits validation before listening and returns `{ port, stop }`.
Default bind is 127.0.0.1; external binding is explicit. The factory never reads files. With `tls: { cert, key }`, it
requires non-empty cert/key Buffers at construction and uses node:https with minimum TLSv1.2; without it, node:http.
Node validates the PEM material before the factory returns. Both serve `/healthz` and `/mcp` identically. The composition
root owns certificate loading and the required explicit TLS mode choice (ADR-017).

Modern requests retain MCP 2026-07-28 framing: version/method/name headers, per-request metadata, header/body agreement
before version checks, discover/list metadata and complete tool results. A modern-framed initialize remains 404
-32601 with INITIALIZE_MESSAGE. Origin allowlisting, bearer grammar, the 1 MiB body cap, content type and JSON-RPC
shape checks precede era routing. A malformed handler result or exception is a generic 500, never a success.

A headerless initialize without modern protocol metadata selects legacy. It negotiates 2025-11-25, 2025-06-18 or
2025-03-26 (unsupported requests receive the preferred 2025-11-25), and returns a CSPRNG session id. Sessions store only
the bearer's SHA-256 hash, compared in constant time; capacity is 1024 globally and 32 per bearer hash, idle expiry one
hour. At capacity, initialize evicts the least recently used session (within that bearer's sessions at the per-bearer
limit). Only an owned, version-valid request refreshes recency. This replaces capacity refusal per the coordinator's
P2-5 decision on 2026-10-04, so arbitrary bearers cannot block a new initialization by filling the table. Unknown, expired and
foreign-bearer sessions receive 404 without echoing the session. Every later POST must carry the negotiated protocol
version; absence is accepted only for a 2025-03-26 session. All valid-session notifications receive empty HTTP 202 and
never invoke a handler. Unknown requests receive HTTP 200 with JSON-RPC -32601, preserving the session; the
[2025-11-25 transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) reserves session 404
for terminated sessions (architect/reviewer verified 2026-10-04). Legacy initialize errors name the supported legacy
versions; modern-framed errors retain the modern initialize diagnostic. Ping returns {},
and tools/list/tools/call return legacy shapes without modern metadata or parameter headers. DELETE removes only an
owned live session (204); other DELETEs and all GETs on /mcp return 405. Last-Event-ID is ignored.

Both eras share the sorted exposed-name table (`server__tool`, never split back into identity), argument-object checks,
handler invocation, fresh callId and admission bound. `naming: "tool"` supports the demo upstream. Exposed collisions,
invalid names and invalid schema header annotations refuse initialization. Header annotation traversal visits schema
keywords only, excluding default/example/examples/const/enum instance data. Strict Base64 sentinel decoding preserves
a leading U+FEFF. The legacy transport session never enters IncomingCall or ledger records.

`maxInFlight` defaults to 64; overload returns 503/-30503 with Retry-After: 1. Completion and throw release an admission
slot. A disconnect retains the slot until the handler settles, bounding running work including pending Slack approvals
(coordinator P2-4 decision, 2026-10-04, superseding the disconnect-release pin). Handler promises remain tracked for
shutdown draining after a disconnect. `stop` rejects new
work with 503, clears legacy sessions, stops listening, drains for at most drainTimeoutMs (default 5 s), then closes
connections. It is idempotent. The module logs no bearer, session id or request data.

Primary sources [V], verified by the architect 2026-10-04 in the binding pins:
https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http (modern framing and dual-era
compatibility), https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle and
https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (negotiation, sessions, version headers, DELETE).
Modern validation and tool naming were verified 2026-10-03 against the modern transport, versioning, discover and tools
pages. The pins supply this research; no network was used during implementation.

Tests: `test/front-dual-era.test.ts` drives actual Node HTTP/TLS parsers over stream.duplexPair, including both eras,
TLS with the coordinator's TEST-ONLY fixture, admission, shutdown and the upstream-client→front compatibility row.
`test/front.test.ts` retains the original loopback suite with ADR-016's two changed expectations. The coordinator runs
that suite, server/e2e integration and the reference SDK outside Astra's sandbox. Fable must review; no self-approval.

## ADR-018 security round (2026-10-05): authenticate first

`authenticate(bearer) → agentId | undefined` is **required** for HTTP. The composition root wires IdentityService's
hash lookup; the demo upstream wires its constant-time token compare. Order per request: path → method → stopping →
Origin → bearer grammar → **authenticate** → per-agent cap → Content-Length/Content-Type → body → JSON-RPC. Unknown, a
throw, a non-string or an empty id → 401 `unauthorized` (generic text, nothing echoed), `Connection: close`; the
remaining body is discarded, never buffered, and the socket is cut after REFUSED_LINGER_MS (1 s). This covers
tools/list, server/discover, legacy initialize, ping, tools/call and DELETE. The pipeline still re-resolves identity.
- `maxConnections` (default 256) sets node's `server.maxConnections`; extra connections are dropped unanswered.
- `headersTimeout` 10 s (checked every 1 s via `connectionsCheckingInterval`); an authenticated body must arrive
  within `bodyTimeoutMs` (default 10 s) or the answer is 408 and the connection is cut.
- `maxInFlightPerAgent` (default 16) counts one agent's requests from authentication to response (body reads and
  tools/call alike); over it → 503 -30503 with Retry-After: 1. The global `maxInFlight` still bounds tools/call.
- Legacy sessions record the agent id. The 32-session cap is per agent (an agent evicts only its own LRU session); at
  the global 1024 the next initialize is 503, never an eviction of another agent's session (supersedes P2-5 LRU).
- tools/list is not filtered per agent: filtering needs the registry, which the front does not import. It is never
  answered before authentication. Residual: one authenticated agent sees every exposed tool name and schema.
- Residual: no per-source-IP connection cap (NodePort SNAT would make every client one address). A LAN host can hold
  up to `maxConnections` header-phase sockets for 10 s each; it cannot buffer bodies or reach any method.

Tests: `test/front-auth.test.ts` (401 on every method, before the body, fail-closed authenticate, 150 held 1 MiB
bodies, 408 body deadline, connection cap, per-agent cap) and the ADR-018 rows in `test/front-dual-era.test.ts`.

2c: stdio, SSE/progress responses, per-key rate limits, tool-list refresh and pipeline cancellation on disconnect.
Certificate rotation and real-client CA trust are coordinator/runbook checks. A disconnected handler can continue
until its existing deadline and occupies admission capacity throughout. Session eviction permits recovery but cannot
prevent sustained session churn from arbitrary bearers; authentication still occurs in the injected pipeline.
