import { createRequire } from "node:module";
import type { ToolAnnotations, ToolCall, ToolInfo, ToolResult } from "../types/index.js";
import { MCP_SERVER_NAME_RE, RESERVED_SERVER_NAMES } from "../types/index.js";
import type { SecretsProvider } from "../secrets/contract.js";
import { notImplemented } from "../types/not-implemented.js";

export interface UpstreamConfig { name: string; transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; }
/** A tool definition the client refused per the transport's `x-mcp-header` rules (excluded from `listTools()`); `reason` is value-free. */
export interface RejectedTool { server: string; tool: string; reason: string; }
export interface Upstream {
  listTools(): Promise<ToolInfo[]>; execute(call: ToolCall): Promise<ToolResult>; close(): Promise<void>;
  /** Additive (Slice 2a fix round, F4): tools excluded at connect time, so the composition root can log the spec's SHOULD warning. */
  readonly rejectedTools?: readonly RejectedTool[];
  /** Present on real clients; optional like rejectedTools for injected test implementations. */
  readonly eras?: Readonly<Record<string, "modern" | "legacy">>;
}

// ---------- MCP 2026-07-28 client constants (Slice 2a pin 4; re-read 2026-10-03, see README) ----------
export const UPSTREAM_LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MODERN_ERROR_CODES = [-32020, -32021, -32022] as const;
export class UpstreamUnavailable extends Error { override name = "UpstreamUnavailable"; }
export const UPSTREAM_PROTOCOL_VERSION = "2026-07-28" as const;
export const UPSTREAM_CLIENT_NAME = "agent-ledger-proxy" as const;
/** `tools/call` waits this long for the upstream before `UpstreamTimeout` (pin 4). */
export const UPSTREAM_TIMEOUT_MS = 30_000;
/** Largest upstream response body we read (pin 4). */
export const UPSTREAM_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Pages of `tools/list` followed at connect time before the upstream is refused as unbounded. */
export const UPSTREAM_MAX_LIST_PAGES = 64;
/** Tool names we accept from an upstream (spec: SHOULD be 1-128 of [A-Za-z0-9_.-]); the registry loader has the same rule. */
export const UPSTREAM_TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
/** What `execute` answers for a `resultType === "input_required"` (MRTR) result: never forwarded (pin 4). */
export const UPSTREAM_INPUT_REQUIRED_TEXT = "upstream requires interactive input; not supported by the proxy" as const;
/** A protocol version as the versioning page writes it; anything else in `supportedVersions` is counted, never echoed (F1). */
const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";

/** The upstream did not answer within UPSTREAM_TIMEOUT_MS. `name` is the pipeline's `errorClass`. */
export class UpstreamTimeout extends Error { override name = "UpstreamTimeout"; }
/** `close()` aborted the request. */
export class UpstreamClosed extends Error { override name = "UpstreamClosed"; }
/**
 * The upstream answered, but not with a usable 2026-07-28 response (HTTP status, JSON-RPC error, framing, size, shape).
 * The message is value-free: error class, upstream name, method, and a validated status or integer error code; never
 * upstream text, headers or arguments (Astra review F1).
 */
export class UpstreamError extends Error { override name = "UpstreamError"; }

const clientVersion = (() => { try { return String((createRequire(import.meta.url)("../../package.json") as { version?: unknown }).version ?? "0.0.0"); } catch { return "0.0.0"; } })();
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Pin 4. `transport: "http"` only (`stdio` → notImplemented, 2c). At construction, per upstream: `secrets.get(name)`
 * (a `bearerToken` entry becomes `Authorization: Bearer …` on every request to THAT upstream; the value is closed over,
 * never on the returned object or in an error) → `server/discover` (must list 2026-07-28) → `tools/list` (every page).
 * Every request carries `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (tools/call; Base64 sentinel when needed),
 * `Mcp-Param-*` for the tool's valid `x-mcp-header` parameters, `Accept: application/json, text/event-stream`, and
 * `_meta` { protocolVersion, clientCapabilities: {}, clientInfo }. `application/json` and `text/event-stream` responses
 * are both accepted; an SSE stream is parsed incrementally and settles on the JSON-RPC response with the request's id
 * (notifications ignored); no terminal response → throw. Bodies over 4 MiB → throw. Every envelope and result is
 * validated before it becomes a ToolResult (F2).
 */
export async function connectUpstreams(config: UpstreamConfig[], secrets: SecretsProvider): Promise<Upstream> {
  if (!Array.isArray(config)) throw new Error("upstream: config must be an array");
  if (!secrets || typeof secrets.get !== "function") throw new Error("upstream: a secrets provider is required");
  const seen = new Set<string>();
  const clients = new Map<string, HttpClient>();
  const inflight = new Set<AbortController>();
  let closed = false;
  for (const u of config) {
    if (!u || typeof u !== "object") throw new Error("upstream: each entry must be an object");
    if (typeof u.name !== "string" || !MCP_SERVER_NAME_RE.test(u.name)) throw new Error(`upstream: ${JSON.stringify(String(u.name)).slice(0, 80)} is not an MCP server name`);
    if ((RESERVED_SERVER_NAMES as readonly string[]).includes(u.name.toLowerCase().replace(/[^a-z0-9]/g, ""))) throw new Error(`upstream: ${u.name} impersonates a builtin namespace`);
    if (seen.has(u.name)) throw new Error(`upstream: duplicate upstream name ${u.name}`);
    seen.add(u.name);
    if (u.transport === "stdio") throw notImplemented("upstream.connectUpstreams(stdio)");
    if (u.transport !== "http") throw new Error(`upstream: ${u.name}: unknown transport`);
    if (u.command !== undefined || u.args !== undefined) throw new Error(`upstream: ${u.name}: command/args belong to the stdio transport`);
    let url: URL;
    try { url = new URL(String(u.url)); } catch { throw new Error(`upstream: ${u.name}: url is not a valid URL`); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`upstream: ${u.name}: url must be http(s)`);
    if (url.username || url.password) throw new Error(`upstream: ${u.name}: credentials in the URL are refused; use the secrets directory`);
    const found = await secrets.get(u.name);
    const bearer = typeof found["bearerToken"] === "string" && found["bearerToken"].length > 0 ? found["bearerToken"] : undefined;
    clients.set(u.name, new HttpClient(u.name, url.toString(), bearer, inflight, () => closed));
  }
  const tools: ToolInfo[] = [];
  const rejected: RejectedTool[] = [];
  const params = new Map<string, HeaderParam[]>(); // `${server}\0${tool}` → the tool's validated x-mcp-header parameters
  try {
    for (const [name, client] of clients) {
      const discover = await client.detect();
      if (discover) {
        const sv = discover["supportedVersions"];
        if (!Array.isArray(sv)) throw new UpstreamError(`upstream ${name}: server/discover result has no supportedVersions array`);
        const versions = sv.filter((v): v is string => typeof v === "string" && VERSION_RE.test(v));
        if (!versions.includes(UPSTREAM_PROTOCOL_VERSION)) {
          const bad = sv.length - versions.length;
          throw new UpstreamError(`upstream ${name} does not support MCP ${UPSTREAM_PROTOCOL_VERSION} (supportedVersions: ${JSON.stringify(versions)}${bad > 0 ? ` and ${bad} unparseable entries` : ""})`);
        }
      }
      const names = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= UPSTREAM_MAX_LIST_PAGES) throw new UpstreamError(`upstream ${name}: tools/list did not end within ${UPSTREAM_MAX_LIST_PAGES} pages`);
        const result = await client.request("tools/list", cursor === undefined ? {} : { cursor }, undefined, UPSTREAM_TIMEOUT_MS, false);
        if (!Array.isArray(result["tools"])) throw new UpstreamError(`upstream ${name}: tools/list result has no tools array`);
        (result["tools"] as unknown[]).forEach((raw, i) => {
          if (!isRecord(raw)) throw new UpstreamError(`upstream ${name}: tools/list page ${page} tool #${i} is not an object`);
          const toolName = raw["name"];
          if (typeof toolName !== "string" || !UPSTREAM_TOOL_NAME_RE.test(toolName)) throw new UpstreamError(`upstream ${name}: tools/list page ${page} tool #${i} has a name outside [A-Za-z0-9_.-]{1,128}`);
          if (names.has(toolName)) throw new UpstreamError(`upstream ${name}: duplicate tool name ${toolName}`);
          names.add(toolName);
          let hp: HeaderParam[];
          try { hp = headerParams(raw["inputSchema"]); }
          catch (e) { rejected.push({ server: name, tool: toolName, reason: e instanceof Error ? e.message : "x-mcp-header: invalid" }); return; } // transport: the client MUST exclude the tool
          params.set(`${name}\0${toolName}`, client.era === "legacy" ? [] : hp);
          const info: ToolInfo = { server: name, name: toolName };
          if (typeof raw["description"] === "string") info.description = raw["description"];
          if (raw["inputSchema"] !== undefined) info.inputSchema = raw["inputSchema"];
          if (isRecord(raw["annotations"])) info.annotations = raw["annotations"] as ToolAnnotations;
          tools.push(info);
        });
        const next = result["nextCursor"];
        if (next === undefined || next === null) break;
        if (typeof next !== "string" || next.length === 0) throw new UpstreamError(`upstream ${name}: tools/list nextCursor is not a string`);
        cursor = next;
      }
    }
  } catch (e) {
    closed = true;
    for (const c of inflight) c.abort(new UpstreamClosed("upstream: closed"));
    await Promise.all([...clients.values()].map(c => c.deleteSession()));
    throw e instanceof UpstreamTimeout || e instanceof TransportFailure ? new UpstreamUnavailable(e.message) : e;
  }
  return {
    eras: Object.freeze(Object.fromEntries([...clients].map(([name, client]) => [name, client.era]))),
    rejectedTools: Object.freeze(rejected.map((r) => ({ ...r }))),
    async listTools() { return structuredClone(tools); },
    async execute(call) {
      if (!call || typeof call.server !== "string" || typeof call.tool !== "string") throw new Error("upstream: malformed call");
      const client = clients.get(call.server);
      if (!client) throw new Error(`upstream: unknown upstream ${call.server}`);
      const args = isRecord(call.args) ? call.args : {};
      const extra: Record<string, string> = {};
      for (const p of params.get(`${call.server}\0${call.tool}`) ?? []) {
        const v = mirrorValue(valueAt(args, p.path));
        if (v === null) throw new UpstreamError(`upstream ${call.server}: argument for header parameter ${p.name} is not mirrorable`);
        if (v !== undefined) extra[`mcp-param-${p.name.toLowerCase()}`] = encodeHeaderValue(v);
      }
      const result = await client.request("tools/call", { name: call.tool, arguments: args }, call.tool, UPSTREAM_TIMEOUT_MS, true, extra);
      if (result["resultType"] === "input_required") return { content: [{ type: "text", text: UPSTREAM_INPUT_REQUIRED_TEXT }], isError: true };
      const content = result["content"];
      if (!Array.isArray(content)) throw new UpstreamError(`upstream ${call.server}: tools/call result is malformed (content)`);
      content.forEach((b, i) => { if (!validContentBlock(b)) throw new UpstreamError(`upstream ${call.server}: tools/call result is malformed (content[${i}])`); });
      const isError = result["isError"];
      if (isError !== undefined && typeof isError !== "boolean") throw new UpstreamError(`upstream ${call.server}: tools/call result is malformed (isError)`);
      return { content: structuredClone(content), isError: isError === true };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const c of inflight) c.abort(new UpstreamClosed("upstream: closed"));
      inflight.clear();
      await Promise.all([...clients.values()].map(c => c.deleteSession()));
    },
  };
}

/** Tools page "Tool Result": the five content block types and the fields each one requires (re-read 2026-10-03). */
function validContentBlock(b: unknown): boolean {
  if (!isRecord(b) || typeof b["type"] !== "string") return false;
  switch (b["type"]) {
    case "text": return typeof b["text"] === "string";
    case "image": case "audio": return typeof b["data"] === "string" && typeof b["mimeType"] === "string";
    case "resource_link": return typeof b["uri"] === "string" && typeof b["name"] === "string";
    case "resource": { const r = b["resource"]; return isRecord(r) && typeof r["uri"] === "string" && (typeof r["text"] === "string" || typeof r["blob"] === "string"); }
    default: return false;
  }
}

// ---------- x-mcp-header (transport §Custom Headers from Tool Parameters, re-read 2026-10-03) ----------
export interface HeaderParam { path: string[]; name: string; type: "string" | "integer" | "boolean"; }
/** RFC 9110 §5.6.2 token. */
const TCHAR_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SCHEMA_SINGLE_KEYWORDS = new Set(["items", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema"]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/**
 * The valid `x-mcp-header` parameters of an `inputSchema`, in schema order, or a thrown `Error("x-mcp-header: <reason>")`
 * when ANY annotation violates the transport's constraints (non-empty tchar token, case-insensitively unique, on a
 * string/integer/boolean parameter, reachable from the root through `properties` keys only: not through `items`,
 * composition or conditional keywords, `$ref`, or map keywords other than `properties`). The walk is bounded.
 * The front has the same function (modules do not import each other); keep them identical.
 */
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
/** The instance value at an exact `properties` path, or undefined (transport: "If no value is present at that path … the header is omitted"). */
export function valueAt(args: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = args;
  for (const k of path) { if (!isRecord(cur) || !Object.hasOwn(cur, k)) return undefined; cur = cur[k]; }
  return cur;
}
/** Transport §Value Encoding type conversion; `undefined` = omit the header (absent or null), `null` = not a mirrorable primitive. */
export function mirrorValue(v: unknown): string | undefined | null {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  return null;
}
/** RFC 9110 field values are visible ASCII, space and tab; the transport's Base64 sentinel carries anything else (and anything that looks like the sentinel). */
export function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/.test(value);
  if (plain && !(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Enforce our deadline even if an injected transport or stream ignores AbortSignal. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); throw signal.reason; }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

class TransportFailure extends UpstreamError {}
class HttpFailure extends UpstreamError { constructor(message: string, readonly status: number, readonly modernCode?: number, readonly sessionInvalid = false) { super(message); } }

/** One upstream over `fetch`. The bearer is a private field of this object, which never leaves the closure of `connectUpstreams`. */
class HttpClient {
  #bearer: string | undefined;
  #id = 0;
  era: "modern" | "legacy" = "modern";
  #version: string = UPSTREAM_PROTOCOL_VERSION;
  #session: string | undefined;
  #sessionful = false;
  #initializing: Promise<void> | undefined;
  constructor(private readonly name: string, private readonly url: string, bearer: string | undefined, private readonly inflight: Set<AbortController>, private readonly isClosed: () => boolean) { this.#bearer = bearer; }

  async detect(): Promise<Record<string, unknown> | undefined> {
    try { return await this.request("server/discover", {}, undefined, UPSTREAM_TIMEOUT_MS, false); }
    catch (e) {
      if (!(e instanceof HttpFailure) || e.modernCode !== undefined || ![400, 404, 405].includes(e.status)) throw e;
      this.era = "legacy";
      await this.initialize();
      return undefined;
    }
  }
  private initialize(): Promise<void> {
    this.#initializing ??= (async () => {
      this.#session = undefined;
      const r = await this.requestOnce("initialize", { protocolVersion: UPSTREAM_LEGACY_VERSIONS[0], capabilities: {}, clientInfo: { name: UPSTREAM_CLIENT_NAME, version: clientVersion } }, undefined, UPSTREAM_TIMEOUT_MS, false);
      const version = r["protocolVersion"];
      if (typeof version !== "string" || !(UPSTREAM_LEGACY_VERSIONS as readonly string[]).includes(version)) {
        await this.deleteSession(); throw new UpstreamError(`upstream ${this.name}: unsupported legacy protocol version`);
      }
      this.#version = version;
      await this.requestOnce("notifications/initialized", {}, undefined, UPSTREAM_TIMEOUT_MS, false);
      this.#sessionful = this.#session !== undefined;
    })().catch(async e => { await this.deleteSession(); throw e; }).finally(() => { this.#initializing = undefined; });
    return this.#initializing;
  }
  async deleteSession(): Promise<void> {
    const session = this.#session; this.#session = undefined;
    if (!session) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const headers: Record<string, string> = { "mcp-session-id": session, "mcp-protocol-version": this.#version };
    if (this.#bearer) headers["authorization"] = `Bearer ${this.#bearer}`;
    try {
      await Promise.race([
        fetch(this.url, { method: "DELETE", headers, redirect: "error", signal: controller.signal }).then(async res => { await res.body?.cancel(); }),
        new Promise<void>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(); }, 2000); }),
      ]);
    } catch { /* best effort; no upstream text escapes */ } finally { clearTimeout(timer); }
  }
  async request(method: string, params: Record<string, unknown>, mcpName: string | undefined, timeoutMs: number, allowInputRequired: boolean, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (this.#initializing) await this.#initializing;
    else if (this.era === "legacy" && this.#sessionful && this.#session === undefined) await this.initialize();
    const session = this.#session;
    try { return await this.requestOnce(method, params, mcpName, timeoutMs, allowInputRequired, extraHeaders); }
    catch (e) {
      if (this.era !== "legacy" || !session || !(e instanceof HttpFailure) || !(e.status === 404 || e.sessionInvalid)) throw e;
      if (this.#initializing) await this.#initializing;
      else if (session === this.#session) await this.initialize();
      return this.requestOnce(method, params, mcpName, timeoutMs, allowInputRequired, extraHeaders);
    }
  }

  /** One JSON-RPC request; resolves to the validated `result` object (`resultType` absent or `complete`, or `input_required` when `allowInputRequired`). */
  private async requestOnce(method: string, params: Record<string, unknown>, mcpName: string | undefined, timeoutMs: number, allowInputRequired: boolean, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
    if (this.isClosed()) throw new UpstreamClosed("upstream: closed");
    const id = ++this.#id;
    const initialize = this.era === "legacy" && method === "initialize";
    const notification = this.era === "legacy" && method === "notifications/initialized";
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.era === "modern") {
      Object.assign(headers, extraHeaders, { "mcp-protocol-version": UPSTREAM_PROTOCOL_VERSION, "mcp-method": method });
      if (mcpName !== undefined) headers["mcp-name"] = encodeHeaderValue(mcpName);
    } else if (!initialize) {
      headers["mcp-protocol-version"] = this.#version;
      if (this.#session) headers["mcp-session-id"] = this.#session;
    }
    if (this.#bearer !== undefined) headers["authorization"] = `Bearer ${this.#bearer}`;
    const body = JSON.stringify({ jsonrpc: "2.0", ...(!notification ? { id } : {}), method, params: this.era === "legacy" ? params : { ...params, _meta: { [META_VERSION]: UPSTREAM_PROTOCOL_VERSION, [META_CAPS]: {}, [META_CLIENT]: { name: UPSTREAM_CLIENT_NAME, version: clientVersion } } } });
    const controller = new AbortController();
    this.inflight.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new UpstreamTimeout(`upstream ${this.name}: no response to ${method} within ${timeoutMs} ms`)); }, timeoutMs);
    try {
      let res: Response;
      try {
        res = await abortable(fetch(this.url, { method: "POST", headers, body, signal: controller.signal, redirect: "error" }).then(response => {
          if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); throw controller.signal.reason; }
          return response;
        }), controller.signal);
      }
      catch (e) { throw this.abortReason(controller, timedOut, e, method); }
      if (notification && res.status >= 200 && res.status < 300) { await abortable(res.body?.cancel().catch(() => undefined) ?? Promise.resolve(), controller.signal); return {}; }
      if (res.status !== 200) {
        let code: number | undefined; let sessionInvalid = false;
        const legacySessionError = this.era === "legacy" && headers["mcp-session-id"] !== undefined && res.status === 400;
        if ((method === "server/discover" && res.status >= 400 && res.status < 500) || legacySessionError) {
          const chunks: Uint8Array[] = [];
          await this.readBody(res, controller, timedOut, method, c => { chunks.push(c); return false; });
          const data = tryJson(Buffer.concat(chunks).toString("utf8"));
          // server-everything 2026.8.31 rejects an unknown session in its POST router before dispatch.
          // Match the exact error, not arbitrary -32000/400 responses; retain only a boolean, never server text.
          sessionInvalid = legacySessionError && isRecord(data) && data["jsonrpc"] === "2.0" && data["id"] === id &&
            !Object.hasOwn(data, "result") && isRecord(data["error"]) && data["error"]["code"] === -32000 &&
            data["error"]["message"] === "Bad Request: No valid session ID provided";
          if (isRecord(data) && data["jsonrpc"] === "2.0" && !Object.hasOwn(data, "result") && isRecord(data["error"]) && (MODERN_ERROR_CODES as readonly unknown[]).includes(data["error"]["code"])) code = data["error"]["code"] as number;
        } else await abortable(res.body?.cancel().catch(() => undefined) ?? Promise.resolve(), controller.signal);
        const message = `upstream ${this.name}: HTTP ${res.status} on ${method}${code === undefined ? "" : ` (JSON-RPC error ${code})`}`;
        if (res.status >= 500) throw new TransportFailure(message);
        throw new HttpFailure(message, res.status, code, sessionInvalid);
      }
      if (initialize) {
        const session = res.headers.get("mcp-session-id");
        if (session !== null && !/^[\x21-\x7e]{1,256}$/.test(session)) { await abortable(res.body?.cancel().catch(() => undefined) ?? Promise.resolve(), controller.signal); throw new UpstreamError(`upstream ${this.name}: invalid legacy session header`); }
        this.#session = session ?? undefined;
      }
      const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      let message: unknown;
      if (ct === "application/json") {
        const chunks: Uint8Array[] = [];
        await this.readBody(res, controller, timedOut, method, (c) => { chunks.push(c); return false; });
        message = tryJson(Buffer.concat(chunks).toString("utf8"));
        if (message === undefined) throw new UpstreamError(`upstream ${this.name}: ${method} response is not JSON`);
      } else if (ct === "text/event-stream") {
        const parser = new SseParser();
        const take = (msgs: unknown[]) => {
          for (const m of msgs) {
            if (message !== undefined) break;
            if (isRecord(m) && "method" in m && "id" in m) throw new UpstreamError("upstream sent a server-to-client request; not supported");
            if (isRecord(m) && m["id"] === id && ("result" in m || "error" in m)) message = m;
          }
          return message !== undefined;
        };
        await this.readBody(res, controller, timedOut, method, (c) => take(parser.push(c)));
        if (message === undefined) take(parser.end());
        if (message === undefined) throw new UpstreamError(`upstream ${this.name}: ${method} SSE stream ended without a response`);
      } else { await abortable(res.body?.cancel().catch(() => undefined) ?? Promise.resolve(), controller.signal); throw new UpstreamError(`upstream ${this.name}: ${method} response has an unsupported content-type`); }
      if (isRecord(message) && "method" in message && "id" in message) throw new UpstreamError("upstream sent a server-to-client request; not supported");
      // JSON-RPC envelope (base protocol "Responses", re-read 2026-10-03): 2.0, same id, exactly one of result/error (F2)
      if (!isRecord(message) || message["jsonrpc"] !== "2.0") throw new UpstreamError(`upstream ${this.name}: ${method} response is not a JSON-RPC 2.0 message`);
      if (message["id"] !== id) throw new UpstreamError(`upstream ${this.name}: ${method} response id does not match`);
      const hasResult = "result" in message, hasError = "error" in message;
      if (hasResult && hasError) throw new UpstreamError(`upstream ${this.name}: ${method} response carries both result and error`);
      if (hasError) {
        const err = message["error"];
        const code = isRecord(err) && Number.isInteger(err["code"]) ? (err["code"] as number) : undefined;
        throw new UpstreamError(`upstream ${this.name}: ${method} failed (${code === undefined ? "malformed JSON-RPC error" : `JSON-RPC error ${code}`})`);
      }
      if (!hasResult) throw new UpstreamError(`upstream ${this.name}: ${method} response has neither result nor error`);
      const result = message["result"];
      if (!isRecord(result)) throw new UpstreamError(`upstream ${this.name}: ${method} result is not an object`);
      const rt = result["resultType"]; // absent = complete (base protocol MUST, for servers of earlier revisions); any unrecognised value is invalid
      if (!(rt === undefined || rt === "complete" || (allowInputRequired && rt === "input_required"))) throw new UpstreamError(`upstream ${this.name}: ${method} result is malformed (resultType)`);
      return result;
    } finally { clearTimeout(timer); this.inflight.delete(controller); }
  }

  private abortReason(controller: AbortController, timedOut: boolean, e: unknown, method: string): Error {
    if (controller.signal.aborted) {
      const reason: unknown = controller.signal.reason;
      if (reason instanceof UpstreamTimeout || reason instanceof UpstreamClosed) return reason;
      return timedOut ? new UpstreamTimeout(`upstream ${this.name}: ${method} timed out`) : new UpstreamClosed("upstream: closed");
    }
    return new TransportFailure(`upstream ${this.name}: ${method} request failed`);
  }

  /** Streams the body through `sink` under the UPSTREAM_MAX_RESPONSE_BYTES cap; a `true` from the sink stops reading and cancels the stream (F7). */
  private async readBody(res: Response, controller: AbortController, timedOut: boolean, method: string, sink: (chunk: Uint8Array) => boolean): Promise<void> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > UPSTREAM_MAX_RESPONSE_BYTES) { controller.abort(); throw new UpstreamError(`upstream ${this.name}: ${method} response exceeds ${UPSTREAM_MAX_RESPONSE_BYTES} bytes`); }
    if (!res.body) return;
    const reader = res.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), controller.signal);
        if (done) return;
        size += value.byteLength;
        if (size > UPSTREAM_MAX_RESPONSE_BYTES) { await abortable(reader.cancel().catch(() => undefined), controller.signal); throw new UpstreamError(`upstream ${this.name}: ${method} response exceeds ${UPSTREAM_MAX_RESPONSE_BYTES} bytes`); }
        if (sink(value)) { await abortable(reader.cancel().catch(() => undefined), controller.signal); return; }
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw this.abortReason(controller, timedOut, e, method);
    } finally { await abortable(reader.cancel().catch(() => undefined), controller.signal).catch(() => undefined); reader.releaseLock(); }
  }
}

function tryJson(text: string): unknown { try { return JSON.parse(text) as unknown; } catch { return undefined; } }

/**
 * Incremental WHATWG event-stream parser (https://html.spec.whatwg.org/multipage/server-sent-events.html, "Interpreting an
 * event stream", read 2026-10-03): lines end with CRLF, LF or CR (CR dispatches immediately; a directly following LF is swallowed); a leading BOM is dropped once; `:` lines are comments; field = text before the first `:`, value = the rest minus
 * one leading space; `data` appends value + LF; a blank line dispatches (trailing LF removed; empty buffer = no event);
 * `event`/`id`/`retry` are ignored. `push(chunk)` returns the JSON objects dispatched so far; `end()` processes a final
 * unterminated line and then DISCARDS any pending event data, as the spec requires at EOF (Astra F7).
 */
export class SseParser {
  #decoder = new TextDecoder("utf-8");
  #buf = ""; #data = ""; #start = true; #swallowLF = false;
  push(chunk: Uint8Array): unknown[] { this.#buf += this.#decoder.decode(chunk, { stream: true }); return this.#drain(false); }
  end(): unknown[] { this.#buf += this.#decoder.decode(); const out = this.#drain(true); this.#data = ""; return out; }
  #drain(eof: boolean): unknown[] {
    const out: unknown[] = [];
    if (this.#start && this.#buf.length > 0) { if (this.#buf.startsWith("﻿")) this.#buf = this.#buf.slice(1); this.#start = false; }
    for (;;) {
      if (this.#swallowLF && this.#buf.length > 0) { if (this.#buf[0] === "\n") this.#buf = this.#buf.slice(1); this.#swallowLF = false; }
      const i = this.#buf.search(/[\r\n]/);
      if (i === -1) { if (eof && this.#buf.length > 0) { this.#line(this.#buf, out); this.#buf = ""; } return out; }
      const line = this.#buf.slice(0, i);
      this.#swallowLF = this.#buf[i] === "\r";
      this.#buf = this.#buf.slice(i + 1);
      this.#line(line, out);
    }
  }
  #line(line: string, out: unknown[]): void {
    if (line.length === 0) {
      if (this.#data.length === 0) return;
      const payload = this.#data.endsWith("\n") ? this.#data.slice(0, -1) : this.#data;
      this.#data = "";
      const msg = tryJson(payload);
      if (isRecord(msg)) out.push(msg);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.#data += `${value}\n`;
  }
}
