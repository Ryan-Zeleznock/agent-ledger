import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { CallHandler, IncomingCall, ToolInfo } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";

/** Verified against https://modelcontextprotocol.io/specification/2026-07-28/changelog on 2026-09-29 (spec §3); transport, versioning, discover and tools pages re-read 2026-10-03 (README). */
export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

interface FrontBase { tools: () => Promise<ToolInfo[]>; }
export interface StdioFrontOptions extends FrontBase { mode: "stdio"; }
/**
 * Streamable HTTP, revision 2026-07-28: stateless (no initialize handshake, no Mcp-Session-Id; every POST carries
 * MCP-Protocol-Version, Mcp-Method and, for tools/call, Mcp-Name). The front MUST validate Origin (403 on a
 * mismatch) and SHOULD bind to localhost when run locally; both come from these options.
 */
export interface HttpFrontOptions extends FrontBase {
  mode: "http";
  port?: number;
  /** Interface to listen on. Default "127.0.0.1"; server mode in a container sets "0.0.0.0" on purpose. */
  bindHost?: string;
  /** Exact Origin values accepted. A request whose Origin is present and not listed gets 403. Empty list = no browser origin allowed. */
  allowedOrigins: string[];
  /**
   * How `tools()` entries are named on the wire. `"server__tool"` (default, pin 5): the proxy's `<server>__<tool>`.
   * `"tool"`: the raw tool name, for a single-server MCP server built on this front (the demo upstream, pin 6, whose
   * raw names the proxy must see as `echo`, not `demo__echo`); a collision across servers still refuses start.
   * Additive to the pinned option set; flagged in the Slice 2a run report.
   */
  naming?: "server__tool" | "tool";
}
export type FrontOptions = StdioFrontOptions | HttpFrontOptions;
export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;

/**
 * `port` is the port actually bound (Slice 2a: tests bind 127.0.0.1:0, so the caller must be able to read it; the server
 * root logs it). Additive to the pinned `{ stop }`, flagged in the Slice 2a run report.
 */
export interface RunningFront { stop(): Promise<void>; readonly port: number; }

// ---------- Slice 2a pin 3 constants ----------
export const MCP_ENDPOINT_PATH = "/mcp" as const;
export const HEALTH_PATH = "/healthz" as const;
export const MAX_BODY_BYTES = 1024 * 1024;
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
/** Transport §Server Validation: a required `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` header missing or not matching the body. */
export const JSONRPC_HEADER_MISMATCH = -32020;
/** Versioning: the requested protocol version is not served; `data.supported` lists ours. */
export const JSONRPC_UNSUPPORTED_VERSION = -32022;
export const SERVER_NAME = "agent-ledger" as const;
export const DISCOVER_TTL_MS = 3_600_000;
export const TOOLS_TTL_MS = 60_000;
export const DISCOVER_INSTRUCTIONS = "Every tool call through this server is classified against a reviewed registry and recorded in a tamper-evident ledger before it runs; risky and unreviewed calls need an approval channel and are denied until one is configured." as const;
export const INITIALIZE_MESSAGE = `unknown method initialize: this server speaks MCP ${MCP_PROTOCOL_VERSION} only (no initialize handshake)` as const;
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
/** RFC 6750 §2.1: `Bearer` (case-insensitive) then token68. The token itself is never logged. */
const BEARER_RE = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)[ \t]*$/i;
const SENTINEL_RE = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/;
/** What an exposed name may look like: an MCP tool name per spec (SHOULD 1-128 of [A-Za-z0-9_.-]); `__` is the pin 5 separator. */
export const EXPOSED_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
export const EXPOSED_NAME_SEPARATOR = "__" as const;

export const packageVersion = (() => { try { return String((createRequire(import.meta.url)("../../package.json") as { version?: unknown }).version ?? "0.0.0"); } catch { return "0.0.0"; } })();

export interface ExposedTool { exposed: string; server: string; tool: string; info: ToolInfo; }
/** Pin 5: exposed MCP name = `${server}__${tool}`. The mapping back is THIS table, never a string split (ADR-006). */
export function exposedToolName(server: string, tool: string): string { return `${server}${EXPOSED_NAME_SEPARATOR}${tool}`; }
/**
 * Builds the exposed-name table, sorted by exposed name (deterministic `tools/list`). Refuses (throws) when two pairs
 * collide on an exposed name, when a name exceeds 128 characters or falls outside the tool-name alphabet, or when a
 * ToolInfo is malformed: fail closed at start.
 */
export function buildExposedTable(tools: ToolInfo[], naming: "server__tool" | "tool" = "server__tool"): Map<string, ExposedTool> {
  if (!Array.isArray(tools)) throw new Error("front: tools() must resolve to an array");
  if (naming !== "server__tool" && naming !== "tool") throw new Error("front: naming must be server__tool or tool");
  const table = new Map<string, ExposedTool>();
  for (const info of tools) {
    if (!info || typeof info !== "object") throw new Error("front: malformed ToolInfo");
    if (typeof info.server !== "string" || typeof info.name !== "string" || info.server.length === 0 || info.name.length === 0) throw new Error("front: malformed ToolInfo");
    const exposed = naming === "tool" ? info.name : exposedToolName(info.server, info.name);
    if (!EXPOSED_NAME_RE.test(exposed)) throw new Error(`front: exposed tool name ${JSON.stringify(exposed).slice(0, 160)} is not 1-128 characters of [A-Za-z0-9_.-]`);
    const prior = table.get(exposed);
    if (prior) throw new Error(`front: exposed tool name collision: ${prior.server}/${prior.tool} and ${info.server}/${info.name} both map to ${exposed}`);
    table.set(exposed, { exposed, server: info.server, tool: info.name, info });
  }
  return new Map([...table.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Our IncomingCall.callId is per call; the pipeline's sessionId is OURS (identity.startSession), not an MCP
 * session: MCP 2026-07-28 has no protocol-level sessions, so nothing here reads or mints Mcp-Session-Id.
 */
export async function startFront(handler: CallHandler, opts: FrontOptions): Promise<RunningFront> {
  if (typeof handler !== "function") throw new Error("front: a CallHandler is required");
  if (!opts || typeof opts !== "object") throw new Error("front: options are required");
  if (opts.mode === "stdio") throw notImplemented("front.startFront(stdio)");
  if (opts.mode !== "http") throw new Error("front: unknown mode");
  if (!Array.isArray(opts.allowedOrigins) || opts.allowedOrigins.some((o) => typeof o !== "string" || o.length === 0)) throw new Error("front: allowedOrigins must be an array of non-empty strings");
  const port = opts.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("front: port must be an integer 0-65535");
  const bindHost = opts.bindHost ?? DEFAULT_BIND_HOST;
  if (typeof bindHost !== "string" || bindHost.length === 0) throw new Error("front: bindHost must be a non-empty string");
  if (typeof opts.tools !== "function") throw new Error("front: tools() is required");
  const table = buildExposedTable(await opts.tools(), opts.naming ?? "server__tool");
  const allowed = new Set(opts.allowedOrigins);
  const serverInfo = { name: SERVER_NAME, version: packageVersion };
  const toolsResult = {
    resultType: "complete", tools: [...table.values()].map(({ exposed, server, info }) => {
      const t: Record<string, unknown> = { name: exposed, description: `[${server}] ${info.description ?? ""}`.trimEnd() };
      t["inputSchema"] = info.inputSchema ?? { type: "object" };
      if (info.annotations !== undefined) t["annotations"] = info.annotations;
      return t;
    }), ttlMs: TOOLS_TTL_MS, cacheScope: "private", _meta: { [META_SERVER_INFO]: serverInfo },
  };
  const discoverResult = { resultType: "complete", supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} }, _meta: { [META_SERVER_INFO]: serverInfo }, instructions: DISCOVER_INSTRUCTIONS, ttlMs: DISCOVER_TTL_MS, cacheScope: "private" };

  const server: Server = createServer((req, res) => { void route(req, res).catch(() => { if (!res.headersSent) sendJson(res, 500, rpcError(null, JSONRPC_INTERNAL_ERROR, "internal error")); else res.destroy(); }); });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    const path = (req.url ?? "/").split("?")[0];
    if (path === HEALTH_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(req.method === "HEAD" ? undefined : '{"ok":true}'); return;
    }
    if (path !== MCP_ENDPOINT_PATH) { res.writeHead(404); res.end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); req.resume(); return; }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) { drain(req); sendJson(res, 403, rpcError(undefined, JSONRPC_INVALID_REQUEST, "Origin not allowed")); return; }
    const auth = req.headers.authorization;
    const m = typeof auth === "string" ? BEARER_RE.exec(auth) : null;
    if (!m) { drain(req); res.setHeader("www-authenticate", `Bearer realm="${SERVER_NAME}"`); sendJson(res, 401, rpcError(undefined, JSONRPC_INVALID_REQUEST, "unauthorized: a bearer token is required")); return; }
    const token = m[1]!;
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) { tooLarge(req, res); return; }
    const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (ct !== "application/json") { drain(req); sendJson(res, 415, rpcError(undefined, JSONRPC_INVALID_REQUEST, "Content-Type must be application/json")); return; }
    const raw = await readBody(req, res);
    if (raw === undefined) return; // 413 already sent
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { sendJson(res, 400, rpcError(null, JSONRPC_PARSE_ERROR, "Parse error")); return; }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) { sendJson(res, 400, rpcError(null, JSONRPC_INVALID_REQUEST, "Invalid Request: expected one JSON-RPC message object")); return; }
    const rpc = msg as Record<string, unknown>;
    const id = Object.hasOwn(rpc, "id") ? rpc["id"] : undefined;
    const rid = typeof id === "string" || typeof id === "number" || id === null ? id : null;
    const isNotification = id === undefined;
    if (rpc["jsonrpc"] !== "2.0" || typeof rpc["method"] !== "string" || (id !== undefined && typeof id !== "string" && typeof id !== "number" && id !== null)) { sendJson(res, 400, rpcError(rid, JSONRPC_INVALID_REQUEST, "Invalid Request")); return; }
    const method = rpc["method"];
    // A legacy client's only diagnostic is the error to its `initialize`, which must name the version (versioning page);
    // it arrives without MCP-Protocol-Version, so this check runs before header validation (README).
    if (method === "initialize") { sendJson(res, 404, rpcError(rid, JSONRPC_METHOD_NOT_FOUND, INITIALIZE_MESSAGE, { supported: [MCP_PROTOCOL_VERSION] })); return; }
    const params = rpc["params"];
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) { sendJson(res, 400, rpcError(rid, JSONRPC_INVALID_REQUEST, "Invalid Request: params must be an object")); return; }
    const p = (params ?? {}) as Record<string, unknown>;
    // Transport §Server Validation (-32020): required headers present and equal to the body.
    const versionHeader = header(req, "mcp-protocol-version");
    if (versionHeader === undefined) { sendJson(res, 400, rpcError(rid, JSONRPC_HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version header is required")); return; }
    const methodHeader = header(req, "mcp-method");
    if (methodHeader !== method) { sendJson(res, 400, rpcError(rid, JSONRPC_HEADER_MISMATCH, methodHeader === undefined ? "Header mismatch: Mcp-Method header is required" : "Header mismatch: Mcp-Method header does not match the body method")); return; }
    if (method === "tools/call") {
      const nameHeader = header(req, "mcp-name");
      const decoded = nameHeader === undefined ? undefined : decodeSentinel(nameHeader);
      if (decoded === undefined || decoded !== p["name"]) { sendJson(res, 400, rpcError(rid, JSONRPC_HEADER_MISMATCH, nameHeader === undefined ? "Header mismatch: Mcp-Name header is required on tools/call" : "Header mismatch: Mcp-Name header does not match params.name")); return; }
    }
    if (versionHeader !== MCP_PROTOCOL_VERSION) { sendJson(res, 400, rpcError(rid, JSONRPC_UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [MCP_PROTOCOL_VERSION], requested: versionHeader })); return; }
    const meta = p["_meta"];
    const metaObj = typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : undefined;
    if (!metaObj || typeof metaObj[META_VERSION] !== "string" || typeof metaObj[META_CAPS] !== "object" || metaObj[META_CAPS] === null) { sendJson(res, 400, rpcError(rid, JSONRPC_INVALID_PARAMS, `Invalid params: _meta must carry ${META_VERSION} and ${META_CAPS}`)); return; }
    if (metaObj[META_VERSION] !== versionHeader) { sendJson(res, 400, rpcError(rid, JSONRPC_HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version header does not match _meta protocolVersion")); return; }
    if (isNotification) { res.writeHead(202); res.end(); return; }
    if (method === "server/discover") { sendJson(res, 200, { jsonrpc: "2.0", id: rid, result: discoverResult }); return; }
    if (method === "tools/list") { sendJson(res, 200, { jsonrpc: "2.0", id: rid, result: toolsResult }); return; }
    if (method !== "tools/call") { sendJson(res, 404, rpcError(rid, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${typeof method === "string" ? method.slice(0, 64) : ""}`)); return; }
    const name = p["name"];
    const entry = typeof name === "string" ? table.get(name) : undefined;
    if (!entry) { sendJson(res, 400, rpcError(rid, JSONRPC_INVALID_PARAMS, `Unknown tool: ${typeof name === "string" ? name.slice(0, 160) : ""}`)); return; }
    const args = p["arguments"];
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) { sendJson(res, 400, rpcError(rid, JSONRPC_INVALID_PARAMS, "Invalid params: arguments must be an object")); return; }
    const incoming: IncomingCall = { callId: randomUUID(), credential: { kind: "api_key", value: token }, server: entry.server, tool: entry.tool, args: (args ?? {}) as Record<string, unknown>, receivedAt: new Date().toISOString() };
    let result;
    try { result = await handler(incoming); }
    catch { sendJson(res, 500, rpcError(rid, JSONRPC_INTERNAL_ERROR, "internal error")); return; }
    sendJson(res, 200, { jsonrpc: "2.0", id: rid, result: { resultType: "complete", content: result?.content ?? [], isError: result?.isError === true, _meta: { [META_SERVER_INFO]: serverInfo } } });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    port: boundPort,
    async stop() {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

// ---------- helpers ----------
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}
/** Transport §Value Encoding: `=?base64?…?=` (lowercase markers) carries the UTF-8 value; anything else is literal. */
export function decodeSentinel(value: string): string | undefined {
  const m = SENTINEL_RE.exec(value);
  if (!m) return value;
  try { return Buffer.from(m[1]!, "base64").toString("utf8"); } catch { return undefined; }
}
/** `id` undefined omits the member (transport-level rejections before a request exists: the spec says such an error body "has no id"); null is JSON-RPC's unknown id. */
function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown) {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error["data"] = data;
  const body: Record<string, unknown> = { jsonrpc: "2.0" };
  if (id !== undefined) body["id"] = id;
  body["error"] = error;
  return body;
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) });
  res.end(text);
}
function drain(req: IncomingMessage): void { req.resume(); }
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(413, { connection: "close" }); res.end();
  req.resume();
}
/** Reads at most MAX_BODY_BYTES; over that, answers 413 and resolves undefined. */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { done = true; tooLarge(req, res); resolve(undefined); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
    req.on("error", () => { if (!done) { done = true; res.destroy(); resolve(undefined); } });
  });
}
