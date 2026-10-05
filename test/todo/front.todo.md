# front: tests to write after Gate 2

Converted on 2026-10-03 (Fable, Slice 2a pins 3 and 5) in `test/front.test.ts` over a real `node:http` server bound to `127.0.0.1:0`.
- [x] ~~stdio and~~ HTTP reaches the handler with `IncomingCall { credential: { kind: "api_key", value: <bearer> }, server, tool, args, receivedAt }`; stdio is 2c (`not implemented: front.startFront(stdio)`)
- [x] a malformed MCP request returns a protocol error, not a crash (`-32700` parse error, `-32600` invalid request, `-32602` invalid params, batch arrays refused; a handler throw → `500` `-32603` generic)
- [x] HTTP: a request with an Origin not in `allowedOrigins` gets 403 and never reaches the handler; a request without Origin passes
- [x] HTTP: default bind is 127.0.0.1; `bindHost: "0.0.0.0"` must be explicit
- [x] HTTP: MCP-Protocol-Version other than 2026-07-28 → 400 `-32022` with `data.supported`; a missing Mcp-Method or Mcp-Name on tools/call → 400 `-32020`
- [x] HTTP: an incoming Mcp-Session-Id is ignored and never echoed; GET/DELETE on the endpoint → 405
- [x] bearer → credential; 401 shape (`WWW-Authenticate`); `initialize` → 404 `-32601` naming 2026-07-28; notification → 202; 1 MiB body cap → 413; discover shape; `resultType`/`ttlMs`/`cacheScope` present; unknown tool → `-32602` and no handler call; exposed-name collision refuses start
- [x] fix round (Astra review 2026-10-03): modern-framed initialize → 404 (F6); headerless legacy initialize now opens a session (ADR-016); strict ids/capabilities/Base64 sentinel and header-agreement-before-version order (F5); `x-mcp-header` validation on `tools/call` and at start (F4); bounded admission `maxInFlight` → 503 `-30503` (F10); `stop()` drains admitted invocations (F3); malformed handler result → 500 (F2); `0.0.0.0` observed at the listen boundary only (F11)
- [x] 2b: dual-era legacy initialize/session/version routing, capacity/idle expiry/bearer binding, shared IncomingCall, owned DELETE
- [x] 2b: TLS >= 1.2, non-listening factory, actual HTTP/TLS over duplexPair, upstream→legacy-front compatibility
- [ ] 2c: per-key token-bucket rate limit; stdio front; SSE/progress responses; tool-list refresh
- [x] (Astra verification P2 N2, 2026-10-03) Base64 header sentinel decoding strips a leading U+FEFF: use `TextDecoder(..., { fatal: true, ignoreBOM: true })`; test exact round-trip of a value starting with U+FEFF.
- [x] Fable review 2026-10-04 P2-4 (coordinator override): disconnect retains admission until the handler settles; shutdown refuses new admission (503 while stopping).
- [x] Fable review P2-5/6: global LRU and 32-session per-bearer cap replace capacity refusal; 1024 garbage bearers cannot lock out a real initialize; valid-session unknown methods get 200/-32601, all notifications get 202.
- [x] Fable review P3-3/6: legacy initialize errors name legacy versions; reject missing, empty and non-Buffer TLS cert/key at construction.
- [x] ADR-018 (server audit P2-1/P2-2, /cso LOWs): required `authenticate` before body and every method; 401 without echo; maxConnections; 10 s header and body deadlines; per-agent requests-in-flight cap; legacy sessions capped per agent, global capacity refuses instead of evicting.
