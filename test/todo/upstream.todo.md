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
- [x] 2b: dual-era initialize/session client, discovery refusal/retry classification, shared 404 recovery, DELETE, eras; in-process fetch acceptance
- [x] Fable review 2026-10-04 P2-2/3: retry failed reinitialize single-flight, delete partial sessions; validate/exclude invalid legacy header annotations without mirroring (coordinator refinement of pin 2); P3-4 SDK empty-data SSE priming event
- [ ] 2c: stdio transport; tool-list refresh / listChanged
- [x] (Astra verification P2, 2026-10-03) F7: a complete CR-delimited SSE event waits for another byte/EOF (`src/upstream/contract.ts` SseParser): process CR immediately and suppress a following LF; test CR-only streams with the terminal event last.
- [x] (Astra verification P2 N1, 2026-10-03) `x-mcp-header` traversal also walks `default`/`example`/`const` data and rejects valid tools: traverse schema-valued keywords only (same fix in `src/front/contract.ts` buildExposedTable).
- [x] Live 2026-10-05 restart: exact reference-app 400/-32000 session rejection and 404 recover single-flight once; other/malformed 400s refuse; value-free and bounded body inspection.

- [x] Fable fixes-2b P1-1/P3-1: real id-less 400 fixture; absent/null/matching ids recover; mismatches and unrelated 404s refuse; exact SDK 404 and bounded body tests.
