# front
**Job:** Expose the MCP server (protocol 2026-07-28) to the agent over stdio or Streamable HTTP; hand each `tools/call` to the injected `CallHandler` as an unauthenticated `IncomingCall`
**Depends on:** types only (the handler comes from `pipeline` at wiring time, not by import)
**Does NOT:** know the call order, authenticate anyone, or keep MCP sessions (the 2026-07-28 transport is stateless; our `sessionId` is the pipeline's, from identity)
**HTTP options:** `bindHost` (default `127.0.0.1`) and `allowedOrigins` (Origin mismatch → 403), per the transport's security section
**Spec:** docs/spec.md §3, 4, 6
Status: implemented

## Slice 2a (Fable, 2026-10-03; pins 3 and 5): Streamable HTTP, revision 2026-07-28 only

**Not implemented (2b):** `mode: "stdio"` (`not implemented: front.startFront(stdio)`); the legacy era (`initialize`
handshake, `Mcp-Session-Id`, GET stream): a legacy client's `initialize` arrives without the required headers and gets
`400` `-32020` whose message and `data.supported` name `2026-07-28` (versioning matrix + its SHOULD; see the fix round
below); SSE responses (the server may answer `application/json` per request, and always does here).

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
invalid JSON → `400` `-32700` · not one JSON-RPC 2.0 object (arrays included), `jsonrpc` ≠ `"2.0"`, `method` not a
string, or an `id` member that is not a string or integer (`null` and fractions included: base protocol "the ID MUST NOT
be null") → `400` `-32600` · missing `MCP-Protocol-Version` → `400` `-32020` · `Mcp-Method` missing or ≠ `method` →
`-32020` · `tools/call` with `Mcp-Name` missing, a malformed Base64 sentinel, or ≠ `params.name` after strict sentinel
decoding → `-32020` · `_meta.protocolVersion` (when a string) ≠ header → `-32020` · version ≠ `2026-07-28` → `400`
`-32022` `{ supported, requested }` · `params._meta` lacking a string `protocolVersion` or an object `clientCapabilities`,
or carrying a malformed `clientInfo` → `400` `-32602` · notification (no `id`) → `202` no body · `server/discover` →
pinned result (`instructions`, `ttlMs` 3 600 000, `cacheScope: "private"`) · `tools/list` → sorted exposed names,
`description` prefixed `[<server>] `, `inputSchema` (`{ type: "object" }` when the upstream gave none, since the schema
MUST be an object) and `annotations` verbatim, `ttlMs` 60 000, `cacheScope: "private"`, no `nextCursor` · **`initialize`
with valid headers → `404` `-32601`** with `INITIALIZE_MESSAGE` and `data.supported` · any other method → `404` `-32601` ·
`tools/call`: unknown exposed name → `400` `-32602 "Unknown tool: <name>"` and NO `IncomingCall` (a non-existent tool has
no identity to record); `arguments` not an object → `-32602`; every advertised `x-mcp-header` parameter present in the
body must have an equal `Mcp-Param-<name>` header (missing, mismatching, or present with no body value → `-32020`; a
body value of the wrong primitive type → `-32602`); over `maxInFlight` admitted invocations → `503` `-30503` with
`Retry-After: 1`; else `IncomingCall { callId: randomUUID(), credential: { kind: "api_key", value: token }, server, tool,
args, receivedAt }` → `await handler(incoming)` → `{ resultType: "complete", content, isError }`; a handler throw OR a
handler result that is not `{ content: ContentBlock[], isError: boolean }` → `500` `-32603 "internal error"` (never the
exception text, never an empty success). **Every error to an `initialize` body, at any step, appends `INITIALIZE_MESSAGE`
and `data.supported`** (versioning: "SHOULD name the protocol versions it supports in any error it returns to an
`initialize` request"). Every result carries
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

## Fix round after Astra's review (2026-10-03, `docs/reviews/2026-10-03-astra-slice-2a-proxy-review.md`)

- **F6 `initialize` ordering (the rejected pin deviation).** Header validation now runs first. The versioning page's
  compatibility matrix (re-read 2026-10-03) says of Legacy client → Modern server over HTTP: "the request is missing the
  required headers and is rejected per server validation with `400 Bad Request`"; its SHOULD asks only that the error
  *name the supported versions*. So a legacy `initialize` gets `400` `-32020` with `data.supported: ["2026-07-28"]` and a
  message ending in `INITIALIZE_MESSAGE`; the same `fail()` path decorates `-32022`/`-32602` errors to an `initialize`
  body; `404` `-32601` is reserved for an `initialize` that passed validation. Pin 3's literal "`initialize` → 404" now
  describes that last case only; the dual-era client's "inspect the 400 body" rule still identifies us as modern.
- **F5 strictness.** `id`: string or integer only. `clientCapabilities`: a plain object. `clientInfo` (optional): `{ name,
  version }` strings. `decodeSentinel` is strict: RFC 4648 alphabet with canonical padding, re-encode equality (no stray
  trailing bits), fatal UTF-8 decode; a malformed sentinel is `-32020`, not a permissive `Buffer.from`. Header/body version
  agreement (`-32020`) is checked before version support (`-32022`), as pin 3 orders.
- **F4 server side.** `buildExposedTable` validates every `inputSchema`'s `x-mcp-header` annotations with the transport's
  constraints (`headerParams`, a copy of the upstream module's function since modules do not import each other) and
  refuses to start on an invalid one; `tools/call` validates recognised `Mcp-Param-*` headers against the exact property
  paths (null/absent value → the header MUST NOT be present; integers compared numerically, `42.0` = `42`; header names
  case-insensitive; sentinel decoded first). Demo schemas carry no annotations, so the proxy's live traffic is unchanged.
- **F10 admission.** `maxInFlight` (default `DEFAULT_MAX_IN_FLIGHT` = 64; the server root reads
  `AGENT_LEDGER_MAX_INFLIGHT`) bounds concurrent `tools/call` invocations; the next one is `503` + `Retry-After: 1` +
  JSON-RPC `-30503` (`JSONRPC_OVERLOADED`: application-defined, because the base protocol forbids emitting undefined codes
  in -32000..-32099 and says new codes SHOULD live outside -32768..-32000). Capacity is released on completion, throw and
  disconnect. Discovery and listing are not invocations. Per-key token-bucket rate limiting is a residual (2b).
- **F3 drain.** `stop()` flips to "stopping" (`/mcp` POST → `503 shutting down`, `/healthz` → `503 {"ok":false}`), stops
  listening, closes idle connections, waits up to `drainTimeoutMs` (default 5 000) for admitted invocations to settle
  (so a late upstream answer is still delivered and its outcome recorded by the caller), then closes every connection.
- **F2.** A handler result outside `{ content: ContentBlock[], isError: boolean }` is a `500`, never `{ content: [] }`.
- **F11.** `test/front.test.ts` observes `bindHost: "0.0.0.0"` at the `Server.prototype.listen` boundary; every real test
  server binds `127.0.0.1`.
- Additive options (`maxInFlight`, `drainTimeoutMs`) and `ExposedTool.headerParams` are flagged in the run report.