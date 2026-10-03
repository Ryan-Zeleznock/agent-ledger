// A deliberately small, raw MCP 2026-07-28 client over `fetch` for the smoke client and the tests (pins: "a 40-line
// 2026-07-28 client over fetch; also used by smoke.ts"). It lives under src/server because dist/server/smoke.js cannot
// import test/; test/helpers/mcp-client.ts re-exports it. Every knob exists so a test can send a WRONG request on purpose.
export const CLIENT_PROTOCOL_VERSION = "2026-07-28" as const;
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion" as const;
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities" as const;
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo" as const;
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo" as const;

export interface McpPostOptions {
  url: string; method: string; params?: Record<string, unknown>;
  /** Bearer token; absent → no Authorization header. */
  token?: string;
  /** JSON-RPC id (default 1). `null` as a value is sent as null; `notification: true` omits the id. */
  id?: string | number | null; notification?: boolean;
  /** Header overrides: a string sets, `null` removes the default header (to test a missing one). */
  headers?: Record<string, string | null>;
  /** Protocol version for BOTH the header and `_meta` (default 2026-07-28); `meta: false` omits `_meta` entirely. */
  protocolVersion?: string; meta?: boolean;
  /** Raw body instead of the JSON-RPC envelope (to send invalid JSON or an array). */
  rawBody?: string; httpMethod?: string;
}
export interface McpPostResult { status: number; headers: Headers; text: string; json: unknown; }

export async function mcpPost(o: McpPostOptions): Promise<McpPostResult> {
  const version = o.protocolVersion ?? CLIENT_PROTOCOL_VERSION;
  const params: Record<string, unknown> = { ...(o.params ?? {}) };
  if (o.meta !== false) params["_meta"] = { [META_PROTOCOL_VERSION]: version, [META_CLIENT_CAPABILITIES]: {}, [META_CLIENT_INFO]: { name: "agent-ledger-client", version: "0" } };
  const envelope: Record<string, unknown> = { jsonrpc: "2.0", method: o.method, params };
  if (!o.notification) envelope["id"] = o.id === undefined ? 1 : o.id;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version, "mcp-method": o.method };
  if (o.method === "tools/call" && typeof params["name"] === "string") headers["mcp-name"] = params["name"];
  if (o.token !== undefined) headers["authorization"] = `Bearer ${o.token}`;
  for (const [k, v] of Object.entries(o.headers ?? {})) { if (v === null) delete headers[k.toLowerCase()]; else headers[k.toLowerCase()] = v; }
  const httpMethod = o.httpMethod ?? "POST";
  const body = httpMethod === "GET" || httpMethod === "HEAD" ? undefined : o.rawBody ?? JSON.stringify(envelope);
  const res = await fetch(o.url, { method: httpMethod, headers, body, redirect: "manual" });
  const text = await res.text();
  let json: unknown; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}

export class McpClientError extends Error { override name = "McpClientError"; constructor(message: string, readonly status: number, readonly code?: number) { super(message); } }
/** A well-formed request; resolves to `result`, throws McpClientError on a non-200 or a JSON-RPC error. */
export async function mcpCall(url: string, token: string | undefined, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await mcpPost({ url, token, method, params });
  const body = (r.json ?? {}) as { result?: unknown; error?: { code?: number; message?: string } };
  if (r.status !== 200 || body.error || typeof body.result !== "object" || body.result === null) throw new McpClientError(`${method}: HTTP ${r.status}${body.error ? ` ${body.error.code} ${body.error.message ?? ""}` : ""}`, r.status, body.error?.code);
  return body.result as Record<string, unknown>;
}
/** The concatenated text of a tool result's text content blocks. */
export function toolText(result: Record<string, unknown>): string {
  return Array.isArray(result["content"]) ? (result["content"] as { type?: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n") : "";
}
