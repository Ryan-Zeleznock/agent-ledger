# front: tests to write after Gate 2

Converted on 2026-10-03 (Fable, Slice 2a pins 3 and 5) in `test/front.test.ts` over a real `node:http` server bound to `127.0.0.1:0`.
- [x] ~~stdio and~~ HTTP reaches the handler with `IncomingCall { credential: { kind: "api_key", value: <bearer> }, server, tool, args, receivedAt }`; stdio is 2b (`not implemented: front.startFront(stdio)`)
- [x] a malformed MCP request returns a protocol error, not a crash (`-32700` parse error, `-32600` invalid request, `-32602` invalid params, batch arrays refused; a handler throw → `500` `-32603` generic)
- [x] HTTP: a request with an Origin not in `allowedOrigins` gets 403 and never reaches the handler; a request without Origin passes
- [x] HTTP: default bind is 127.0.0.1; `bindHost: "0.0.0.0"` must be explicit
- [x] HTTP: MCP-Protocol-Version other than 2026-07-28 → 400 `-32022` with `data.supported`; a missing Mcp-Method or Mcp-Name on tools/call → 400 `-32020`
- [x] HTTP: an incoming Mcp-Session-Id is ignored and never echoed; GET/DELETE on the endpoint → 405
- [x] bearer → credential; 401 shape (`WWW-Authenticate`); `initialize` → 404 `-32601` naming 2026-07-28; notification → 202; 1 MiB body cap → 413; discover shape; `resultType`/`ttlMs`/`cacheScope` present; unknown tool → `-32602` and no handler call; exposed-name collision refuses start
- [x] fix round (Astra review 2026-10-03): legacy `initialize` → 400 `-32020` naming 2026-07-28, modern-framed → 404 (F6); strict ids/capabilities/Base64 sentinel and header-agreement-before-version order (F5); `x-mcp-header` validation on `tools/call` and at start (F4); bounded admission `maxInFlight` → 503 `-30503` (F10); `stop()` drains admitted invocations (F3); malformed handler result → 500 (F2); `0.0.0.0` observed at the listen boundary only (F11)
- [ ] 2b: per-key token-bucket rate limit (F10 residual; concurrency bound shipped); stdio front; dual-era (legacy `initialize`) front if Claude Code's v2 probe does not accept a modern-only server (HOMELAB step 12); SSE responses
