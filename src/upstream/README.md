# upstream
**Job:** Connect to real MCP servers and execute calls
**Depends on:** types, secrets
**Does NOT:** check policy
**Spec:** docs/spec.md §4
Status: implemented

## Slice 2a (Fable, 2026-10-03; pin 4): the 2026-07-28 Streamable HTTP client

`connectUpstreams(config, secrets)` implements `transport: "http"` only. **Not implemented (2b):** `stdio`
(`not implemented: upstream.connectUpstreams(stdio)`), the legacy-era (`initialize`) fallback for third-party servers
(every published MCP server is legacy today, pins §0; ADR-013 names the dual-era client as 2b), tool-list refresh.

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
on the returned `Upstream`, not in any error message (errors carry the upstream name, method and HTTP status / JSON-RPC
error code only, clipped), and it is never the agent's key (the proxy holds its own upstream credential; spec §9).

**Every request** is one POST with `Content-Type: application/json`, `Accept: application/json, text/event-stream`,
`MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: <method>`, `Mcp-Name: <params.name>` on `tools/call` (Base64 sentinel
`=?base64?…?=` when the name is not a plain header value or looks like the sentinel; `encodeHeaderValue`), and a body
whose `params._meta` carries `io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities: {}` and `…/clientInfo
{ name: "agent-ledger-proxy", version: <package.json> }`. Redirects are errors (a credential must not follow a 3xx).

**Responses.** `application/json` is parsed as the single JSON-RPC response; `text/event-stream` is read to its end and the
event whose JSON has the request's `id` and `result`/`error` is the response (notifications and comments are ignored;
`sseResponse`); a stream without one throws. Any other content type, a non-200 status, an `error` member, a mismatched
`id`, or a body over `UPSTREAM_MAX_RESPONSE_BYTES` (4 MiB; checked on `Content-Length` and while streaming) throws
`UpstreamError`. `tools/call` runs under a 30 s `AbortController` (`UPSTREAM_TIMEOUT_MS`): expiry throws
`UpstreamTimeout` (its `name` is what the pipeline stores as `errorClass`); `close()` aborts everything in flight with
`UpstreamClosed` and refuses later requests.

**Connect.** For each upstream: `server/discover` (its `supportedVersions` must list `2026-07-28`, else throw naming the
upstream and the list it gave) → `tools/list`, following `nextCursor` up to `UPSTREAM_MAX_LIST_PAGES`. Every tool name
must match `UPSTREAM_TOOL_NAME_RE` (`[A-Za-z0-9_.-]{1,128}`, the registry loader's rule) and be unique per upstream; else
the upstream is refused (fail closed: an unnameable tool cannot be exposed or reviewed). `ToolInfo.server` is the config
`name`; `description`, `inputSchema` and `annotations` pass through verbatim. `listTools()` returns a structured clone of
the connect-time list.

**Execute.** `call.server` must be a configured upstream (`unknown upstream` otherwise; the proxy's allowlist, spec §9);
`tools/call { name: call.tool, arguments: call.args }`. Result `{ content, isError: result.isError === true }`. A result
whose `resultType` is not `"complete"` (MRTR `input_required`) is NEVER forwarded: the agent gets `{ content: [{ type:
"text", text: UPSTREAM_INPUT_REQUIRED_TEXT }], isError: true }`, because an upstream must not be able to ask the agent
anything through the proxy.

Tests: `test/upstream.test.ts` against a real `node:http` fake upstream on 127.0.0.1 (combined lists with server names,
pagination, header/`_meta`/bearer isolation, discover refusal, SSE and JSON responses, input_required, timeout with
fake timers, 4 MiB cap, close(), config and tool-name refusals, leak checks on every error path).
