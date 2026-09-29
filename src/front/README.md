# front
**Job:** Expose the MCP server (protocol 2026-07-28) to the agent over stdio or Streamable HTTP; hand each `tools/call` to the injected `CallHandler` as an unauthenticated `IncomingCall`
**Depends on:** types only (the handler comes from `pipeline` at wiring time, not by import)
**Does NOT:** know the call order, authenticate anyone, or keep MCP sessions (the 2026-07-28 transport is stateless; our `sessionId` is the pipeline's, from identity)
**HTTP options:** `bindHost` (default `127.0.0.1`) and `allowedOrigins` (Origin mismatch → 403), per the transport's security section
**Spec:** docs/spec.md §3, 4, 6
