# front
Status: implemented

Exposes MCP tools through one dual-era Streamable HTTP endpoint and hands unauthenticated `IncomingCall`s to the
injected handler. Imports only shared types; policy, identity and recording remain in the pipeline. Spec §3/4/6;
Slice 2b pins 3/4, accepted ADR-016/017.

`createFrontServer(handler, opts)` returns an HTTP or HTTPS server without listening. The async tools provider runs
once; requests await table initialization. `startFront` awaits validation before listening and returns `{ port, stop }`.
Default bind is 127.0.0.1; external binding is explicit. The factory never reads files. With `tls: { cert, key }`, it
uses node:https with minimum TLSv1.2; without it, node:http. Both serve `/healthz` and `/mcp` identically. The composition
root owns certificate loading and the required explicit TLS mode choice (ADR-017).

Modern requests retain MCP 2026-07-28 framing: version/method/name headers, per-request metadata, header/body agreement
before version checks, discover/list metadata and complete tool results. A modern-framed initialize remains 404
-32601 with INITIALIZE_MESSAGE. Origin allowlisting, bearer grammar, the 1 MiB body cap, content type and JSON-RPC
shape checks precede era routing. A malformed handler result or exception is a generic 500, never a success.

A headerless initialize without modern protocol metadata selects legacy. It negotiates 2025-11-25, 2025-06-18 or
2025-03-26 (unsupported requests receive the preferred 2025-11-25), and returns a CSPRNG session id. Sessions store only
the bearer's SHA-256 hash, compared in constant time; capacity is 1024, idle expiry one hour. Unknown, expired and
foreign-bearer sessions receive 404 without echoing the session. Every later POST must carry the negotiated protocol
version; absence is accepted only for a 2025-03-26 session. notifications/initialized receives 202, ping returns {},
and tools/list/tools/call return legacy shapes without modern metadata or parameter headers. DELETE removes only an
owned live session (204); other DELETEs and all GETs on /mcp return 405. Last-Event-ID is ignored.

Both eras share the sorted exposed-name table (`server__tool`, never split back into identity), argument-object checks,
handler invocation, fresh callId and admission bound. `naming: "tool"` supports the demo upstream. Exposed collisions,
invalid names and invalid schema header annotations refuse initialization. Header annotation traversal visits schema
keywords only, excluding default/example/examples/const/enum instance data. Strict Base64 sentinel decoding preserves
a leading U+FEFF. The legacy transport session never enters IncomingCall or ledger records.

`maxInFlight` defaults to 64; overload returns 503/-30503 with Retry-After: 1. Completion, throw and disconnect release
an admission slot. Handler promises remain tracked for shutdown draining even after a disconnect. `stop` rejects new
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

2c: stdio, SSE/progress responses, per-key rate limits, tool-list refresh and pipeline cancellation on disconnect.
Certificate rotation and real-client CA trust are coordinator/runbook checks. A disconnected handler can continue
until its existing deadline; freeing transport admission does not cancel a pipeline operation.
