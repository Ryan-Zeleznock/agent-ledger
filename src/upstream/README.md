# upstream
**Job:** Connect to real MCP servers and execute calls
**Depends on:** types, secrets
**Does NOT:** check policy
**Spec:** docs/spec.md §4
Status: implemented

## Slice 2a (Fable, 2026-10-03; pin 4): the 2026-07-28 Streamable HTTP client

`connectUpstreams(config, secrets)` implements HTTP with modern discovery and legacy initialization (Slice 2b,
ADR-016). stdio and tool-list refresh/listChanged remain 2c.

**Primary source**, re-read 2026-10-03: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
(request metadata headers, `Accept`, response content types, Base64 sentinel), `basic/versioning` (`-32022` shape,
compatibility matrix), `server/discover` (`supportedVersions`), `server/tools` (`tools/list` pagination via `nextCursor`,
tool-name rule, `tools/call` result, `input_required`). SSE framing: WHATWG HTML "Interpreting an event stream",
https://html.spec.whatwg.org/multipage/server-sent-events.html (read 2026-10-03). All [V].

**Config.** Names must match `MCP_SERVER_NAME_RE`, not normalise to a reserved builtin name, and be unique; `url` must be
`http(s)` without userinfo (credentials go through `secrets`, never the URL); `command`/`args` are refused on `http`.
Unchanged `UpstreamConfig` (pin 4): auth is not a config field.

**Auth.** Per upstream, `secrets.get(name)`; a `bearerToken` entry becomes `Authorization: Bearer <value>` on every request
to THAT upstream. The value is a private field of an object that never leaves the closure of `connectUpstreams`: it is not
on the returned `Upstream`, not in any error message (every `UpstreamError` is value-free: the upstream name, the method,
and a validated HTTP status or integer JSON-RPC error code; upstream message text, `data`, headers and arguments are never
copied), and it is never the agent's key (the proxy holds its own upstream credential; spec §9).

**Every request** is one POST with `Content-Type: application/json`, `Accept: application/json, text/event-stream`,
`MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: <method>`, `Mcp-Name: <params.name>` on `tools/call` (Base64 sentinel
`=?base64?…?=` when the name is not a plain header value or looks like the sentinel; `encodeHeaderValue`), and a body
whose `params._meta` carries `io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities: {}` and `…/clientInfo
{ name: "agent-ledger-proxy", version: <package.json> }`. Redirects are errors (a credential must not follow a 3xx).

**Responses.** `application/json` is parsed as the single JSON-RPC response; `text/event-stream` is parsed incrementally
(`SseParser`, WHATWG framing across chunk boundaries) and the request settles on the first framed event whose JSON has the
request's `id` and `result`/`error`, cancelling the stream (a stream the upstream leaves open does not hang the call);
notifications and comments are ignored; an unterminated event at EOF is discarded, so a stream without a framed response
throws. The envelope is then validated: `jsonrpc: "2.0"`, the same `id`, exactly one of `result`/`error`, `result` an
object whose `resultType` is absent (treated as `complete`, the base protocol's MUST) or a recognised value. Any other
content type, a non-200 status, an `error` member (integer `code` reported, text dropped), a mismatched `id`, a malformed
envelope, or a body over `UPSTREAM_MAX_RESPONSE_BYTES` (4 MiB; checked on `Content-Length` and while streaming) throws
`UpstreamError`. `tools/call` runs under a 30 s `AbortController` (`UPSTREAM_TIMEOUT_MS`): expiry throws
`UpstreamTimeout` (its `name` is what the pipeline stores as `errorClass`); `close()` aborts everything in flight with
`UpstreamClosed` and refuses later requests.

**Connect.** For each upstream: `server/discover` (its `supportedVersions` must list `2026-07-28`, else throw naming the
upstream and the list it gave) → `tools/list`, following `nextCursor` up to `UPSTREAM_MAX_LIST_PAGES`. Every tool name
must match `UPSTREAM_TOOL_NAME_RE` (`[A-Za-z0-9_.-]{1,128}`, the registry loader's rule) and be unique per upstream; else
the upstream is refused (fail closed: an unnameable tool cannot be exposed or reviewed). `ToolInfo.server` is the config
`name`; `description`, `inputSchema` and `annotations` pass through verbatim. Each `inputSchema`'s `x-mcp-header`
annotations are validated against the transport's constraints (`headerParams`); a tool with an invalid annotation is
EXCLUDED from the list, as the transport requires of clients, and listed on the additive `rejectedTools` (`{ server, tool,
reason }`, value-free) so the server root can log the spec's SHOULD warning. A malformed `supportedVersions` entry or tool
name is reported by count or index, never echoed. `listTools()` returns a structured clone of the connect-time list.

**Execute.** `call.server` must be a configured upstream (`unknown upstream` otherwise; the proxy's allowlist, spec §9);
`tools/call { name: call.tool, arguments: call.args }`, with an `Mcp-Param-<name>` header for every valid `x-mcp-header`
parameter whose value is present and non-null in `arguments` (string as is, integer decimal, boolean lowercase; Base64
sentinel when not header-safe; a non-primitive value at an annotated path throws, value-free). The result is validated
before it becomes a `ToolResult`: `content` an array of the five content block types with their required fields (`text`;
`image`/`audio` `data`+`mimeType`; `resource_link` `uri`+`name`; `resource` with `uri` and `text`|`blob`), `isError` absent
or boolean; anything else throws `UpstreamError` (the pipeline records an `error` outcome and answers `isError`; a
malformed reply can never become `ok` evidence). A `resultType: "input_required"` (MRTR) result is NEVER forwarded: the
agent gets `{ content: [{ type: "text", text: UPSTREAM_INPUT_REQUIRED_TEXT }], isError: true }`, because an upstream must
not be able to ask the agent anything through the proxy.

Tests: `test/upstream.test.ts` against a real `node:http` fake upstream on 127.0.0.1 (combined lists with server names,
pagination, header/`_meta`/bearer isolation, discover refusal, SSE and JSON responses, input_required, timeout with
fake timers, 4 MiB cap, close(), config and tool-name refusals, leak checks on every error path).

## Fix round after Astra's review (2026-10-03, `docs/reviews/2026-10-03-astra-slice-2a-proxy-review.md`)

F1 value-free diagnostics (reflected-token and raw-argument fixtures at connect and execute time, JSON and SSE); F2
envelope and result validation (malformed → `UpstreamError`, through the real pipeline → `error` outcome); F4 client-side
`x-mcp-header` mirroring and tool-definition rejection with `rejectedTools` (additive member, flagged); F7 incremental
SSE with the framed terminal event as the completion boundary (WHATWG: an incomplete event at EOF is discarded). Tests in
`test/upstream.test.ts` ("F1", "F2", "F4", "F7" describes) and `test/server.test.ts` (root-level F1/F2).

## Slice 2b (Astra, 2026-10-04; pin 2, ADR-016)

Discovery runs once per configured upstream. A valid 200 discover result selects modern framing. Only non-modern
400/404/405 selects legacy; recognized modern errors (-32020/-32021/-32022) and 401/403 refuse downgrade. Startup
network failures, timeouts and 5xx become `UpstreamUnavailable` for the composition root's retry policy. Diagnostics
omit upstream text. The real client always supplies a frozen `eras` map (the interface field is optional, like
`rejectedTools`, to preserve injected implementations).

Legacy initializes with 2025-11-25, accepts 2025-06-18/2025-03-26, validates an optional visible-ASCII session header,
and sends notifications/initialized. Subsequent requests carry the negotiated version and session, without modern
headers/metadata. Legacy schemas' x-mcp-header annotations are ignored. Pagination and result validation stay shared.
A session 404 triggers one shared reinitialization and one resend, even for concurrent callers. Server-to-client
requests fail immediately. Shutdown aborts calls then best-effort DELETEs each session within 2 s; failed startup also
cleans up sessions. No GET or deprecated HTTP+SSE negotiation is attempted.

The CR SSE regression now dispatches on CR immediately, swallowing a following LF across chunks. Header annotation
validation walks only schema keywords; default/example/examples/const/enum instance data cannot reject a valid tool.

Primary sources [V], architect-verified 2026-10-04 in the binding pins:
https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http (Backward Compatibility),
https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle and
https://modelcontextprotocol.io/specification/2025-11-25/basic/transports (initialization, sessions, 404 recovery).
`test/upstream-dual-era.test.ts` uses a stubbed fetch and in-memory legacy/modern servers. Coordinator runs the existing
loopback suite and the real SDK reference server. An on-path forced legacy downgrade remains the stated ADR-016 risk.

Coordinator fix (2026-10-04): POST fetch, body reads and stream cancellation explicitly race the request AbortSignal,
so the existing 30 s deadline also bounds non-cooperating injected transports/streams. A reflected 404/-32603 still
selects legacy per pin 2; a silent initialize fails value-free as UpstreamUnavailable. The server regression fixture
now explicitly refuses initialize instead of silently waiting beyond its 5 s test limit.
