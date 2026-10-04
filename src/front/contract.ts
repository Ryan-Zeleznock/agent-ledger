import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { CallHandler, IncomingCall, ToolInfo, ToolResult } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";

/** Verified against https://modelcontextprotocol.io/specification/2026-07-28/changelog on 2026-09-29 (spec §3); transport, versioning, discover and tools pages re-read 2026-10-03 (README). */
export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

interface FrontBase { tools: () => Promise<ToolInfo[]>; }
export interface StdioFrontOptions extends FrontBase { mode: "stdio"; }
/**
 * Dual-era Streamable HTTP: modern requests are stateless; headerless initialize selects bearer-bound legacy sessions.
 * Modern POSTs carry
 * MCP-Protocol-Version, Mcp-Method and, for tools/call, Mcp-Name. The front MUST validate Origin (403 on a
 * mismatch) and SHOULD bind to localhost when run locally; both come from these options.
 */
export interface HttpFrontOptions extends FrontBase {
  tls?: { cert: Buffer; key: Buffer };
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
  /** Additive (fix round, F10): concurrent `tools/call` invocations admitted; the next one is `503` until a slot frees. Default DEFAULT_MAX_IN_FLIGHT. */
  maxInFlight?: number;
  /** Additive (fix round, F3): how long `stop()` waits for admitted invocations to settle before cutting their connections. Default DEFAULT_DRAIN_TIMEOUT_MS. */
  drainTimeoutMs?: number;
}
export type FrontOptions = StdioFrontOptions | HttpFrontOptions;
export const FRONT_LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const FRONT_MAX_LEGACY_SESSIONS = 1024;
export const FRONT_LEGACY_SESSION_IDLE_MS = 3_600_000;
export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
export const DEFAULT_MAX_IN_FLIGHT = 64;
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

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
/** Transport §Server Validation: a required `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` / `Mcp-Param-*` header missing, malformed or not matching the body. */
export const JSONRPC_HEADER_MISMATCH = -32020;
/** Versioning: the requested protocol version is not served; `data.supported` lists ours. */
export const JSONRPC_UNSUPPORTED_VERSION = -32022;
/**
 * Over capacity or shutting down (HTTP 503). Application-defined: the base protocol reserves -32000..-32099 (legacy and
 * MCP-defined codes; "Implementations MUST NOT emit any code from this sub-range that is not defined by this
 * specification") and says new codes SHOULD live outside -32768..-32000, so this one does.
 */
export const JSONRPC_OVERLOADED = -30503;
export const SERVER_NAME = "agent-ledger" as const;
export const DISCOVER_TTL_MS = 3_600_000;
export const TOOLS_TTL_MS = 60_000;
export const DISCOVER_INSTRUCTIONS = "Every tool call through this server is classified against a reviewed registry and recorded in a tamper-evident ledger before it runs; risky and unreviewed calls need an approval channel and are denied until one is configured." as const;
export const INITIALIZE_MESSAGE = `unknown method initialize: this server speaks MCP ${MCP_PROTOCOL_VERSION} only (no initialize handshake)` as const;
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
/** RFC 6750 §2.1: `Bearer` (case-insensitive) then token68. The token itself is never logged. */
const BEARER_RE = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)[ \t]*$/i;
const SENTINEL_RE = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/;
/** RFC 4648 §4 alphabet with canonical padding; anything else in a sentinel is malformed (F5). */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** What an exposed name may look like: an MCP tool name per spec (SHOULD 1-128 of [A-Za-z0-9_.-]); `__` is the pin 5 separator. */
export const EXPOSED_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
export const EXPOSED_NAME_SEPARATOR = "__" as const;

export const packageVersion = (() => { try { return String((createRequire(import.meta.url)("../../package.json") as { version?: unknown }).version ?? "0.0.0"); } catch { return "0.0.0"; } })();
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ExposedTool { exposed: string; server: string; tool: string; info: ToolInfo; headerParams: HeaderParam[]; }
/** Pin 5: exposed MCP name = `${server}__${tool}`. The mapping back is THIS table, never a string split (ADR-006). */
export function exposedToolName(server: string, tool: string): string { return `${server}${EXPOSED_NAME_SEPARATOR}${tool}`; }
/**
 * Builds the exposed-name table, sorted by exposed name (deterministic `tools/list`). Refuses (throws) when two pairs
 * collide on an exposed name, when a name exceeds 128 characters or falls outside the tool-name alphabet, when a
 * ToolInfo is malformed, or when an `inputSchema` carries an invalid `x-mcp-header` annotation (F4): fail closed at start.
 */
export function buildExposedTable(tools: ToolInfo[], naming: "server__tool" | "tool" = "server__tool"): Map<string, ExposedTool> {
  if (!Array.isArray(tools)) throw new Error("front: tools() must resolve to an array");
  if (naming !== "server__tool" && naming !== "tool") throw new Error("front: naming must be server__tool or tool");
  const table = new Map<string, ExposedTool>();
  tools.forEach((info, i) => {
    if (!info || typeof info !== "object") throw new Error("front: malformed ToolInfo");
    if (typeof info.server !== "string" || typeof info.name !== "string" || info.server.length === 0 || info.name.length === 0) throw new Error("front: malformed ToolInfo");
    const exposed = naming === "tool" ? info.name : exposedToolName(info.server, info.name);
    if (!EXPOSED_NAME_RE.test(exposed)) throw new Error(`front: exposed tool name #${i} is not 1-128 characters of [A-Za-z0-9_.-]`);
    const prior = table.get(exposed);
    if (prior) throw new Error(`front: exposed tool name collision: ${prior.server}/${prior.tool} and ${info.server}/${info.name} both map to ${exposed}`);
    let params: HeaderParam[];
    try { params = headerParams(info.inputSchema); } catch (e) { throw new Error(`front: ${exposed}: ${e instanceof Error ? e.message : "invalid x-mcp-header"}`); }
    table.set(exposed, { exposed, server: info.server, tool: info.name, info, headerParams: params });
  });
  return new Map([...table.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

type FrontServer = Server | HttpsServer;
const lifecycles = new WeakMap<FrontServer, { ready: Promise<void>; stop(): Promise<void> }>();
/** Build without binding a port. tools() initializes once; requests await that initialization, and startFront awaits it before listen. */
export function createFrontServer(handler: CallHandler, opts: FrontOptions): Server | HttpsServer {
  if (typeof handler !== "function") throw new Error("front: a CallHandler is required");
  if (!opts || typeof opts !== "object") throw new Error("front: options are required");
  if (opts.mode === "stdio") throw notImplemented("front.startFront(stdio)");
  if (opts.mode !== "http") throw new Error("front: unknown mode");
  if (!Array.isArray(opts.allowedOrigins) || opts.allowedOrigins.some((o) => typeof o !== "string" || o.length === 0)) throw new Error("front: allowedOrigins must be an array of non-empty strings");
  const port = opts.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("front: port must be an integer 0-65535");
  const bindHost = opts.bindHost ?? DEFAULT_BIND_HOST;
  if (typeof bindHost !== "string" || bindHost.length === 0) throw new Error("front: bindHost must be a non-empty string");
  const maxInFlight = opts.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 100_000) throw new Error("front: maxInFlight must be an integer 1-100000");
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 0 || drainTimeoutMs > 600_000) throw new Error("front: drainTimeoutMs must be an integer 0-600000");
  if (typeof opts.tools !== "function") throw new Error("front: tools() is required");
  const allowed = new Set(opts.allowedOrigins);
  const serverInfo = { name: SERVER_NAME, version: packageVersion };
  let table: Map<string, ExposedTool>;
  let toolsResult: Record<string, unknown>;
  const ready = (async () => {
    table = buildExposedTable(await opts.tools(), opts.naming ?? "server__tool");
    toolsResult = {
      resultType: "complete", tools: [...table.values()].map(({ exposed, server, info }) => {
        const t: Record<string, unknown> = { name: exposed, description: `[${server}] ${info.description ?? ""}`.trimEnd() };
        t["inputSchema"] = info.inputSchema ?? { type: "object" };
        if (info.annotations !== undefined) t["annotations"] = info.annotations;
        return t;
      }), ttlMs: TOOLS_TTL_MS, cacheScope: "private", _meta: { [META_SERVER_INFO]: serverInfo },
    };
  })();
  void ready.catch(() => undefined); // startFront/route observes initialization failures; never an unhandled rejection
  const discoverResult = { resultType: "complete", supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} }, _meta: { [META_SERVER_INFO]: serverInfo }, instructions: DISCOVER_INSTRUCTIONS, ttlMs: DISCOVER_TTL_MS, cacheScope: "private" };
  const inflight = new Set<Promise<void>>(); // admitted tools/call invocations (F10 bound, F3 drain)
  let stopping = false;
  let admitted = 0;
  const sessions = new Map<string, { tokenHash: Buffer; version: string; touched: number }>();
  const expire = () => { const now = Date.now(); for (const [id, session] of sessions) if (now - session.touched >= FRONT_LEGACY_SESSION_IDLE_MS) sessions.delete(id); };
  const ownedSession = (id: string | undefined, token: string) => {
    expire(); const session = id === undefined ? undefined : sessions.get(id);
    return session && timingSafeEqual(session.tokenHash, createHash("sha256").update(token).digest()) ? session : undefined;
  };

  const listener = (req: IncomingMessage, res: ServerResponse) => { void route(req, res).catch(() => { if (!res.headersSent) sendJson(res, 500, rpcError(null, JSONRPC_INTERNAL_ERROR, "internal error")); else res.destroy(); }); };
  const server = opts.tls ? createHttpsServer({ ...opts.tls, minVersion: "TLSv1.2" }, listener) : createServer(listener);
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => { stopping = true; sessions.clear(); return originalClose(callback); }) as typeof server.close;
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await ready;
    res.setHeader("cache-control", "no-store");
    const path = (req.url ?? "/").split("?")[0];
    if (path === HEALTH_PATH) {
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return; }
      res.writeHead(stopping ? 503 : 200, { "content-type": "application/json" }); res.end(req.method === "HEAD" ? undefined : stopping ? '{"ok":false}' : '{"ok":true}'); return;
    }
    if (path !== MCP_ENDPOINT_PATH) { res.writeHead(404); res.end(); return; }
    if (req.method === "DELETE") {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowed.has(origin)) { drain(req); sendJson(res, 403, rpcError(undefined, JSONRPC_INVALID_REQUEST, "Origin not allowed")); return; }
      const auth = req.headers.authorization;
      const match = typeof auth === "string" ? BEARER_RE.exec(auth) : null;
      const id = header(req, "mcp-session-id");
      if (!stopping && match && ownedSession(id, match[1]!)) { sessions.delete(id!); res.writeHead(204); res.end(); drain(req); return; }
      res.writeHead(405, { allow: "POST" }); res.end(); drain(req); return;
    }
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); req.resume(); return; }
    if (stopping) { drain(req); res.setHeader("connection", "close"); sendJson(res, 503, rpcError(undefined, JSONRPC_OVERLOADED, "shutting down")); return; }
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
    if (stopping) { sendJson(res, 503, rpcError(undefined, JSONRPC_OVERLOADED, "shutting down")); return; }
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { sendJson(res, 400, rpcError(null, JSONRPC_PARSE_ERROR, "Parse error")); return; }
    if (!isRecord(msg)) { sendJson(res, 400, rpcError(null, JSONRPC_INVALID_REQUEST, "Invalid Request: expected one JSON-RPC message object")); return; }
    const rpc = msg;
    const isNotification = !Object.hasOwn(rpc, "id");
    const id = rpc["id"];
    // Base protocol "Requests": a string or integer id; "Unlike base JSON-RPC, the ID MUST NOT be null" (F5)
    const validId = isNotification || typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
    const rid: string | number | null = validId && !isNotification ? (id as string | number) : null;
    const method = rpc["method"];
    // Every error to an `initialize` names the versions we speak (versioning page: "SHOULD name the protocol versions it supports in any error it returns to an initialize request") (F6)
    const fail = (status: number, code: number, message: string, data?: Record<string, unknown>): void => {
      if (method === "initialize") { if (!message.includes(INITIALIZE_MESSAGE)) message = `${message}; ${INITIALIZE_MESSAGE}`; data = { ...(data ?? {}), supported: [MCP_PROTOCOL_VERSION] }; }
      sendJson(res, status, rpcError(rid, code, message, data));
    };
    if (rpc["jsonrpc"] !== "2.0" || typeof method !== "string" || !validId) { fail(400, JSONRPC_INVALID_REQUEST, "Invalid Request"); return; }
    const params = rpc["params"];
    if (params !== undefined && !isRecord(params)) { fail(400, JSONRPC_INVALID_REQUEST, "Invalid Request: params must be an object"); return; }
    const p = params ?? {};
    const sessionHeaderPresent = Object.hasOwn(req.headers, "mcp-session-id");
    const versionHeader = header(req, "mcp-protocol-version");
    let legacy = false;
    if (sessionHeaderPresent) {
      const session = ownedSession(header(req, "mcp-session-id"), token);
      if (!session) { sendJson(res, 404, rpcError(rid, JSONRPC_INVALID_REQUEST, "unknown legacy session")); return; }
      if (versionHeader !== session.version && !(versionHeader === undefined && session.version === "2025-03-26")) { fail(400, JSONRPC_INVALID_REQUEST, "legacy protocol version mismatch"); return; }
      session.touched = Date.now(); legacy = true;
      if (method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      if (method === "ping") { sendJson(res, 200, { jsonrpc: "2.0", id: rid, result: {} }); return; }
      if (method === "tools/list") { sendJson(res, 200, { jsonrpc: "2.0", id: rid, result: { tools: toolsResult["tools"] } }); return; }
      if (method !== "tools/call") { fail(404, JSONRPC_METHOD_NOT_FOUND, "Method not found"); return; }
      if (isNotification) { fail(400, JSONRPC_INVALID_REQUEST, "tools/call requires an id"); return; }
    } else if (method === "initialize" && versionHeader === undefined && !(isRecord(p["_meta"]) && Object.hasOwn(p["_meta"], META_VERSION))) {
      if (isNotification || typeof p["protocolVersion"] !== "string" || !isRecord(p["capabilities"])) { fail(400, JSONRPC_INVALID_PARAMS, "initialize requires protocolVersion and capabilities"); return; }
      expire();
      if (sessions.size >= FRONT_MAX_LEGACY_SESSIONS) { fail(503, JSONRPC_OVERLOADED, "too many legacy sessions"); return; }
      const version = (FRONT_LEGACY_VERSIONS as readonly string[]).includes(p["protocolVersion"]) ? p["protocolVersion"] : FRONT_LEGACY_VERSIONS[0];
      const id = randomUUID(); sessions.set(id, { tokenHash: createHash("sha256").update(token).digest(), version, touched: Date.now() });
      res.setHeader("Mcp-Session-Id", id);
      sendJson(res, 200, { jsonrpc: "2.0", id: rid, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo, instructions: DISCOVER_INSTRUCTIONS } }); return;
    }
    if (!legacy) {
      // 1. Transport §Server Validation (-32020): required headers present and equal to the body (header/body agreement comes BEFORE version support: pin 3 order, F5)
      if (versionHeader === undefined) { fail(400, JSONRPC_HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version header is required"); return; }
      const methodHeader = header(req, "mcp-method");
      if (methodHeader !== method) { fail(400, JSONRPC_HEADER_MISMATCH, methodHeader === undefined ? "Header mismatch: Mcp-Method header is required" : "Header mismatch: Mcp-Method header does not match the body method"); return; }
      if (method === "tools/call") {
        const nameHeader = header(req, "mcp-name");
        if (nameHeader === undefined) { fail(400, JSONRPC_HEADER_MISMATCH, "Header mismatch: Mcp-Name header is required on tools/call"); return; }
        const decoded = decodeSentinel(nameHeader);
        if (decoded === undefined) { fail(400, JSONRPC_HEADER_MISMATCH, "Header mismatch: Mcp-Name header is a malformed Base64 sentinel"); return; }
        if (decoded !== p["name"]) { fail(400, JSONRPC_HEADER_MISMATCH, "Header mismatch: Mcp-Name header does not match params.name"); return; }
      }
      const meta = p["_meta"];
      const metaObj = isRecord(meta) ? meta : undefined;
      if (typeof metaObj?.[META_VERSION] === "string" && metaObj[META_VERSION] !== versionHeader) { fail(400, JSONRPC_HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version header does not match _meta protocolVersion"); return; }
      // 2. Versioning (-32022)
      if (versionHeader !== MCP_PROTOCOL_VERSION) { fail(400, JSONRPC_UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [MCP_PROTOCOL_VERSION], requested: versionHeader.slice(0, 64) }); return; }
      // 3. Base protocol per-request fields (-32602): protocolVersion string, clientCapabilities object, clientInfo (optional) an Implementation (F5)
      const clientInfo = metaObj?.[META_CLIENT_INFO];
      if (!metaObj || typeof metaObj[META_VERSION] !== "string" || !isRecord(metaObj[META_CAPS]) || (clientInfo !== undefined && !(isRecord(clientInfo) && typeof clientInfo["name"] === "string" && typeof clientInfo["version"] === "string"))) {
        fail(400, JSONRPC_INVALID_PARAMS, `Invalid params: _meta must carry ${META_VERSION} (string) and ${META_CAPS} (object)`); return;
      }
      if (isNotification) { res.writeHead(202); res.end(); return; }
      if (method === "server/discover") { sendJson(res, 200, { jsonrpc: "2.0", id: rid, result: discoverResult }); return; }
      if (method === "tools/list") { sendJson(res, 200, { jsonrpc: "2.0", id: rid, result: toolsResult }); return; }
      if (method === "initialize") { fail(404, JSONRPC_METHOD_NOT_FOUND, INITIALIZE_MESSAGE); return; } // an otherwise valid request for the one method a legacy client would send
      if (method !== "tools/call") { fail(404, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 64)}`); return; }
    }
    const name = p["name"];
    const entry = typeof name === "string" ? table.get(name) : undefined;
    if (!entry) { fail(400, JSONRPC_INVALID_PARAMS, `Unknown tool: ${typeof name === "string" ? name.slice(0, 160) : ""}`); return; }
    const args = p["arguments"];
    if (args !== undefined && !isRecord(args)) { fail(400, JSONRPC_INVALID_PARAMS, "Invalid params: arguments must be an object"); return; }
    // 4. Transport §Custom Headers: every advertised x-mcp-header parameter present in the body must have a matching Mcp-Param-* header (F4)
    for (const hp of legacy ? [] : entry.headerParams) {
      const v = valueAt(args ?? {}, hp.path);
      const h = header(req, `mcp-param-${hp.name.toLowerCase()}`);
      if (v === undefined || v === null) { if (h !== undefined) { fail(400, JSONRPC_HEADER_MISMATCH, `Header mismatch: Mcp-Param-${hp.name} header is present but the body carries no value for it`); return; } continue; }
      const typed = hp.type === "string" ? typeof v === "string" : hp.type === "boolean" ? typeof v === "boolean" : typeof v === "number" && Number.isSafeInteger(v);
      if (!typed) { fail(400, JSONRPC_INVALID_PARAMS, `Invalid params: the argument for header parameter ${hp.name} must be ${hp.type === "integer" ? "an integer" : `a ${hp.type}`}`); return; }
      if (h === undefined) { fail(400, JSONRPC_HEADER_MISMATCH, `Header mismatch: Mcp-Param-${hp.name} header is required when the argument is present`); return; }
      const decoded = decodeSentinel(h);
      const same = decoded !== undefined && (hp.type === "integer" ? /^-?\d+(\.0+)?$/.test(decoded) && Number(decoded) === v : decoded === String(v));
      if (!same) { fail(400, JSONRPC_HEADER_MISMATCH, `Header mismatch: Mcp-Param-${hp.name} header does not match the body`); return; }
    }
    // 5. Admission (tools page: servers MUST rate limit tool invocations; F10)
    if (admitted >= maxInFlight) { res.setHeader("retry-after", "1"); fail(503, JSONRPC_OVERLOADED, "overloaded: too many tool invocations in flight"); return; }
    admitted++;
    let released = false;
    const release = () => { if (!released) { released = true; admitted--; } };
    res.once("close", release); // a disconnected client must not retain an admission slot
    const incoming: IncomingCall = { callId: randomUUID(), credential: { kind: "api_key", value: token }, server: entry.server, tool: entry.tool, args: (args ?? {}) as Record<string, unknown>, receivedAt: new Date().toISOString() };
    const run = (async () => {
      let result: unknown;
      try { result = await handler(incoming); }
      catch { sendJson(res, 500, rpcError(rid, JSONRPC_INTERNAL_ERROR, "internal error")); return; }
      if (!validToolResult(result)) { sendJson(res, 500, rpcError(rid, JSONRPC_INTERNAL_ERROR, "internal error")); return; } // never an empty success (F2)
      sendJson(res, 200, { jsonrpc: "2.0", id: rid, result: { ...(!legacy ? { resultType: "complete", _meta: { [META_SERVER_INFO]: serverInfo } } : {}), content: result.content, isError: result.isError } });
    })();
    inflight.add(run);
    try { await run; } finally { release(); res.off("close", release); inflight.delete(run); }
  }

  let stopPromise: Promise<void> | undefined;
  lifecycles.set(server, { ready, stop() {
    stopPromise ??= (async () => {
      stopping = true; sessions.clear();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await withTimeout(Promise.allSettled([...inflight]).then(() => undefined), drainTimeoutMs);
      server.closeIdleConnections();
      await withTimeout(closed, 1_000);
      server.closeAllConnections();
      await closed;
    })();
    return stopPromise;
  } });
  return server;
}

/** Bind only after the exposed tool table has passed validation. */
export async function startFront(handler: CallHandler, opts: FrontOptions): Promise<RunningFront> {
  const server = createFrontServer(handler, opts);
  const lifecycle = lifecycles.get(server)!;
  try { await lifecycle.ready; } catch (e) { server.close(); throw e; }
  if (opts.mode !== "http") throw notImplemented("front.startFront(stdio)");
  const port = opts.port ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, opts.bindHost ?? DEFAULT_BIND_HOST, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  return { port: typeof address === "object" && address !== null ? address.port : port, stop: () => lifecycle.stop() };
}

// ---------- helpers ----------
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}
function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined; // a repeated Mcp-* header is as good as missing: no single value to compare
}
/**
 * Transport §Value Encoding: `=?base64?…?=` (lowercase markers) carries the UTF-8 value; anything else is literal. The
 * Base64 must be canonical (RFC 4648 alphabet, correct padding, zero trailing bits) and decode to valid UTF-8, else
 * `undefined` (malformed; the caller answers -32020). `Buffer.from(x, "base64")` alone is permissive (F5).
 */
export function decodeSentinel(value: string): string | undefined {
  const m = SENTINEL_RE.exec(value);
  if (!m) return value;
  const b64 = m[1]!;
  if (!BASE64_RE.test(b64)) return undefined;
  const buf = Buffer.from(b64, "base64");
  if (buf.toString("base64") !== b64) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf); } catch { return undefined; }
}
/** Tools page "Tool Result" content block types and their required fields; a handler result outside this is a 500, never a success (F2). Same rule as the upstream client. */
export function validToolResult(r: unknown): r is ToolResult & { content: unknown[] } {
  if (!isRecord(r) || typeof r["isError"] !== "boolean" || !Array.isArray(r["content"])) return false;
  return r["content"].every((b) => {
    if (!isRecord(b) || typeof b["type"] !== "string") return false;
    switch (b["type"]) {
      case "text": return typeof b["text"] === "string";
      case "image": case "audio": return typeof b["data"] === "string" && typeof b["mimeType"] === "string";
      case "resource_link": return typeof b["uri"] === "string" && typeof b["name"] === "string";
      case "resource": { const x = b["resource"]; return isRecord(x) && typeof x["uri"] === "string" && (typeof x["text"] === "string" || typeof x["blob"] === "string"); }
      default: return false;
    }
  });
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
/** Over this, an oversized request is cut instead of drained (draining exists so the client reads the 413 rather than EPIPE). */
export const DRAIN_LIMIT_BYTES = 16 * 1024 * 1024;
function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(413, { connection: "close" });
  const declared = Number(req.headers["content-length"] ?? "0");
  if (!Number.isFinite(declared) || declared > DRAIN_LIMIT_BYTES) { res.end(); req.destroy(); return; }
  let drained = 0;
  const cut = () => { clearTimeout(timer); res.end(); req.destroy(); };
  const timer = setTimeout(cut, 5_000);
  req.on("data", (c: Buffer) => { drained += c.length; if (drained > DRAIN_LIMIT_BYTES) cut(); });
  req.on("end", () => { clearTimeout(timer); res.end(); });
  req.on("error", () => { clearTimeout(timer); res.destroy(); });
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

// ---------- x-mcp-header (transport §Custom Headers from Tool Parameters, re-read 2026-10-03) ----------
// Identical to src/upstream/contract.ts (modules do not import each other; keep the two copies the same).
export interface HeaderParam { path: string[]; name: string; type: "string" | "integer" | "boolean"; }
const TCHAR_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SCHEMA_SINGLE_KEYWORDS = new Set(["items", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema"]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** The valid `x-mcp-header` parameters of an `inputSchema`, or a thrown `Error("x-mcp-header: <reason>")` when any annotation violates the transport's constraints. Bounded walk. */
export function headerParams(schema: unknown): HeaderParam[] {
  if (schema === undefined || schema === null) return [];
  const out: HeaderParam[] = []; const seen = new Set<string>(); let nodes = 0;
  const walk = (node: unknown, path: string[] | undefined, depth: number): void => {
    if (++nodes > 4096 || depth > 32) throw new Error("x-mcp-header: schema too large to validate");
    if (Array.isArray(node)) { for (const n of node) walk(n, undefined, depth + 1); return; }
    if (!isRecord(node)) return;
    if (Object.hasOwn(node, "x-mcp-header")) {
      if (path === undefined || path.length === 0) throw new Error("x-mcp-header: not statically reachable (only a chain of `properties` keys may lead to it)");
      const name = node["x-mcp-header"];
      if (typeof name !== "string" || name.length === 0) throw new Error("x-mcp-header: value must be a non-empty string");
      if (!TCHAR_RE.test(name)) throw new Error("x-mcp-header: value is not an HTTP field-name token");
      const type = node["type"];
      if (type !== "string" && type !== "integer" && type !== "boolean") throw new Error("x-mcp-header: only string, integer and boolean parameters may be mirrored");
      if (seen.has(name.toLowerCase())) throw new Error("x-mcp-header: duplicate header name (case-insensitive)");
      seen.add(name.toLowerCase());
      out.push({ path, name, type });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "x-mcp-header") continue;
      if (SCHEMA_MAP_KEYWORDS.has(k) && isRecord(v)) { for (const [prop, sub] of Object.entries(v)) walk(sub, k === "properties" && path !== undefined ? [...path, prop] : undefined, depth + 1); }
      else if (SCHEMA_SINGLE_KEYWORDS.has(k) || SCHEMA_ARRAY_KEYWORDS.has(k)) walk(v, undefined, depth + 1);
      else if (k === "dependencies" && isRecord(v)) { for (const sub of Object.values(v)) if (!Array.isArray(sub)) walk(sub, undefined, depth + 1); }
    }
  };
  walk(schema, [], 0);
  return out;
}
/** The instance value at an exact `properties` path, or undefined. */
export function valueAt(args: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = args;
  for (const k of path) { if (!isRecord(cur) || !Object.hasOwn(cur, k)) return undefined; cur = cur[k]; }
  return cur;
}
