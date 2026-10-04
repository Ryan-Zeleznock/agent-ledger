// The 2026-07-28 client the Slice 2a tests use (pins "Integration seams"). The implementation lives in src/server/client.ts
// because dist/server/smoke.js uses the same one and cannot import test/; this file keeps the pinned helper path.
export { CLIENT_PROTOCOL_VERSION, META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_PROTOCOL_VERSION, META_SERVER_INFO, McpClientError, mcpCall, mcpPost, toolText } from "../../src/server/client.js";
export type { McpPostOptions, McpPostResult } from "../../src/server/client.js";
