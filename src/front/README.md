# front
**Job:** Expose the MCP server (protocol 2026-07-28) to the agent over stdio or Streamable HTTP; hand each `tools/call` to the injected `CallHandler` as an unauthenticated `IncomingCall`
**Depends on:** types only (the handler comes from `pipeline` at wiring time, not by import)
**Does NOT:** know the call order, authenticate anyone, or keep MCP sessions (the 2026-07-28 transport is stateless; our `sessionId` is the pipeline's, from identity)
**HTTP options:** `bindHost` (default `127.0.0.1`) and `allowedOrigins` (Origin mismatch → 403), per the transport's security section
**Spec:** docs/spec.md §3, 4, 6
Status: implemented

## Slice 2a (Fable, 2026-10-03; pins 3 and 5): Streamable HTTP, revision 2026-07-28 only

**Not implemented (2b):** `mode: "stdio"` (`not implemented: front.startFront(stdio)`); the legacy era (`initialize`
handshake, `Mcp-Session-Id`, GET stream): a legacy client gets `404` `-32601` naming `2026-07-28`, per the versioning
page's SHOULD; SSE responses (the server may answer `application/json` per request, and always does here).

**Primary source**, re-read 2026-10-03: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
(Origin → 403; `MCP-Protocol-Version` on every POST; `Mcp-Method`/`Mcp-Name` REQUIRED; `-32020` HeaderMismatch for a
missing or mismatching header, after Base64-sentinel decoding; unsupported version `400` `-32022`; unknown method `404`
`-32601`; notification `202`; GET/DELETE `405`; `Mcp-Session-Id`/`Last-Event-ID` ignored, never minted), `basic/versioning`
(`data: { supported, requested }`; "name the protocol versions it supports in any error it returns to an `initialize`
request"), `server/discover` (result shape, `_meta["io.modelcontextprotocol/serverInfo"]`), `server/tools` (`ttlMs`,
`cacheScope`, deterministic order, unknown tool `-32602`, proxies SHOULD prefix tool names with a server identifier).
Bearer grammar: RFC 6750 §2.1 (`Bearer` + token68). All [V].

**One `node:http` server, no framework, no SDK** (the published SDK is legacy-era, pins §0). `startFront(handler, { mode:
"http", port, bindHost, allowedOrigins, tools })` resolves to `{ stop, port }`. `port` (the bound port) is ADDITIVE to the
pinned `{ stop }`: tests bind `127.0.0.1:0` (hard rule) and must read the port back; flagged in the run report.
`DEFAULT_BIND_HOST` stays `127.0.0.1`; the server root passes `0.0.0.0` explicitly. `opts.tools()` is called ONCE at start
and the exposed-name table is built then (refresh is 2b).

**Order of checks** on each request (pin 3): `GET|HEAD /healthz` → `200 {"ok":true}` (no auth, nothing else touched; other
methods 405) · any other path → `404` empty · `/mcp` not POST → `405 Allow: POST` (covers legacy GET/DELETE) · `Origin`
present and not listed → `403` (JSON-RPC error body, no `id`) · `Authorization: Bearer <token68>` missing or malformed →
`401` + `WWW-Authenticate: Bearer realm="agent-ledger"` (nothing about the token is logged or echoed) · body over
`MAX_BODY_BYTES` (1 MiB, by `Content-Length` or while streaming) → `413` · `Content-Type` not `application/json` → `415` ·
invalid JSON → `400` `-32700` · not one JSON-RPC 2.0 object (arrays included) → `400` `-32600` · **`initialize` → `404`
`-32601`** with `INITIALIZE_MESSAGE` and `data.supported` (this check runs BEFORE header validation on purpose: a legacy
client sends `initialize` without `MCP-Protocol-Version`, and the spec asks that whatever error it gets names our
version; pin 3 lists it after the header checks, where it could never be reached by a real legacy client) · missing
`MCP-Protocol-Version` → `400` `-32020` · `Mcp-Method` missing or ≠ `method` → `-32020` · `tools/call` with `Mcp-Name`
missing or ≠ `params.name` after sentinel decoding → `-32020` · version ≠ `2026-07-28` → `400` `-32022` `{ supported,
requested }` · `params._meta` lacking `protocolVersion` or `clientCapabilities` → `400` `-32602` · `_meta.protocolVersion`
≠ header → `-32020` · notification (no `id`) → `202` no body · `server/discover` → pinned result (`instructions`, `ttlMs`
3 600 000, `cacheScope: "private"`) · `tools/list` → sorted exposed names, `description` prefixed `[<server>] `,
`inputSchema` (`{ type: "object" }` when the upstream gave none, since the schema MUST be an object) and `annotations`
verbatim, `ttlMs` 60 000, `cacheScope: "private"`, no `nextCursor` · any other method → `404` `-32601` · `tools/call`:
unknown exposed name → `400` `-32602 "Unknown tool: <name>"` and NO `IncomingCall` (a non-existent tool has no identity to
record); `arguments` not an object → `-32602`; else `IncomingCall { callId: randomUUID(), credential: { kind: "api_key",
value: token }, server, tool, args, receivedAt }` → `await handler(incoming)` → `{ resultType: "complete", content,
isError }`; a handler throw → `500` `-32603 "internal error"` (never the exception text). Every result carries
`_meta["io.modelcontextprotocol/serverInfo"] = { name: "agent-ledger", version: <package.json> }`. Responses are always
`application/json` with `Cache-Control: no-store`. `Mcp-Session-Id` and `Last-Event-ID` are never read or echoed.

**Exposed tool names (pin 5).** `exposedToolName(server, tool) = "<server>__<tool>"`; `buildExposedTable` maps exposed →
`{ server, tool, info }`, sorted, and throws at start on a collision, a name over 128 characters or outside
`[A-Za-z0-9_.-]`, or a malformed `ToolInfo` (fail closed). The lookup on `tools/call` is this table, never a split on `__`
(the ADR-006 lesson). The registry keeps the RAW pair (`demo` / `echo`): policy sees raw identity (spec §3).

**Logging.** The front logs nothing. The server root logs one line per tool call from its handler wrapper; requests
rejected before a call (401, 400, 405) have no callId and are not logged this slice (README of `src/server`).

Tests: `test/front.test.ts` (the pin 3 status/code matrix as a table test over a real `node:http` server on
`127.0.0.1:0`, bearer → credential and no token in any output, discover/list shapes, unknown tool makes no handler call,
collision refusal, notification 202, body cap, `initialize` message, session headers ignored).
