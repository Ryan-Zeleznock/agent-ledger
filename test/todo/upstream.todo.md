# upstream: tests to write after Gate 2

Converted on 2026-10-03 (Fable, Slice 2a pin 4) in `test/upstream.test.ts`, against a real `node:http` 2026-07-28 fake upstream.
- [x] tool lists from 2 servers are combined, with server names kept (`ToolInfo.server` = config name; `nextCursor` pages followed)
- [x] a server that isn't on the allowlist is refused (`execute` for an unconfigured `call.server` throws `unknown upstream`; nothing is sent)
- [x] `connectUpstreams` refuses an upstream whose `server/discover` lacks `2026-07-28`, naming it and its `supportedVersions`
- [x] every request carries `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (tools/call), `Accept`, `_meta` (protocolVersion, clientCapabilities, clientInfo); the bearer from `secrets` goes only to its own upstream and appears on no object, result or error
- [x] JSON and SSE responses (notifications/comments before the terminal response); an SSE stream without a terminal response throws
- [x] 30 s timeout → `UpstreamTimeout` (name = `errorClass`); `close()` aborts in-flight requests; 4 MiB response cap
- [x] an `input_required` (MRTR) result is never forwarded: fixed `isError` text
- [x] config refusals: duplicate/invalid/reserved names, `stdio` not implemented, bad URL, credentials in the URL; tool-name refusals (pattern, duplicates)
- [x] fix round (Astra review 2026-10-03): value-free errors with reflected-token/raw-argument fixtures, JSON and SSE, connect and execute time (F1); envelope + result + content-block validation, malformed → `UpstreamError` (F2); `x-mcp-header` mirroring into `Mcp-Param-*`, invalid definitions excluded and reported on `rejectedTools` (F4); incremental SSE, terminal event ends the read, unterminated EOF event discarded (F7)
- [ ] 2b: `stdio` transport; dual-era (legacy `initialize`) client for third-party servers; tool-list refresh / `listChanged`
