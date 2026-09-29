# front: tests to write after Gate 2
- [ ] stdio and HTTP both reach the handler
- [ ] a malformed MCP request returns a protocol error, not a crash
- [ ] HTTP: a request with an Origin not in `allowedOrigins` gets 403 and never reaches the handler; a request without Origin passes
- [ ] HTTP: default bind is 127.0.0.1; `bindHost: "0.0.0.0"` must be explicit
- [ ] HTTP: MCP-Protocol-Version other than 2026-07-28 → 400 UnsupportedProtocolVersionError; a missing Mcp-Method or Mcp-Name on tools/call → 400 HeaderMismatch
- [ ] HTTP: an incoming Mcp-Session-Id is ignored and never echoed; GET/DELETE on the endpoint → 405
