# front
**Job:** Expose the MCP server to the agent (stdio + HTTP); hand each call to the injected `CallHandler` as an unauthenticated `IncomingCall`
**Depends on:** types only (the handler comes from `pipeline` at wiring time, not by import)
**Does NOT:** know the call order or authenticate anyone
**Spec:** docs/spec.md §3, 4, 6
