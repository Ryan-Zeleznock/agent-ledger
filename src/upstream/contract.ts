import { createRequire } from "node:module";
import type { ToolAnnotations, ToolCall, ToolInfo, ToolResult } from "../types/index.js";
import { MCP_SERVER_NAME_RE, RESERVED_SERVER_NAMES } from "../types/index.js";
import type { SecretsProvider } from "../secrets/contract.js";
import { notImplemented } from "../types/not-implemented.js";

export interface UpstreamConfig { name: string; transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; }
export interface Upstream { listTools(): Promise<ToolInfo[]>; execute(call: ToolCall): Promise<ToolResult>; close(): Promise<void>; }

// ---------- MCP 2026-07-28 client constants (Slice 2a pin 4; re-read 2026-10-03, see README) ----------
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
/** What `execute` answers for a `resultType !== "complete"` (MRTR `input_required`) result: never forwarded (pin 4). */
export const UPSTREAM_INPUT_REQUIRED_TEXT = "upstream requires interactive input; not supported by the proxy" as const;
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";

/** The upstream did not answer within UPSTREAM_TIMEOUT_MS. `name` is the pipeline's `errorClass`. */
export class UpstreamTimeout extends Error { override name = "UpstreamTimeout"; }
/** `close()` aborted the request. */
export class UpstreamClosed extends Error { override name = "UpstreamClosed"; }
/** The upstream answered, but not with a usable 2026-07-28 response (HTTP status, JSON-RPC error, framing, size). */
export class UpstreamError extends Error { override name = "UpstreamError"; }

const clientVersion = (() => { try { return String((createRequire(import.meta.url)("../../package.json") as { version?: unknown }).version ?? "0.0.0"); } catch { return "0.0.0"; } })();

/**
 * Pin 4. `transport: "http"` only (`stdio` → notImplemented, 2b). At construction, per upstream: `secrets.get(name)`
 * (a `bearerToken` entry becomes `Authorization: Bearer …` on every request to THAT upstream; the value is closed over,
 * never on the returned object or in an error) → `server/discover` (must list 2026-07-28) → `tools/list` (every page).
 * Every request carries `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name` (tools/call; Base64 sentinel when needed),
 * `Accept: application/json, text/event-stream`, and `_meta` { protocolVersion, clientCapabilities: {}, clientInfo }.
 * `application/json` and `text/event-stream` responses are both accepted; an SSE stream is read to the JSON-RPC
 * response with the request's id (notifications ignored); no terminal response → throw. Bodies over 4 MiB → throw.
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
    if (typeof u.name !== "string" || !MCP_SERVER_NAME_RE.test(u.name)) throw new Error(`upstream: ${JSON.stringify(String(u.name))} is not an MCP server name`);
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
  for (const [name, client] of clients) {
    const discover = asRecord(await client.request("server/discover", {}, undefined, UPSTREAM_TIMEOUT_MS), name, "server/discover result");
    const versions = Array.isArray(discover["supportedVersions"]) ? (discover["supportedVersions"] as unknown[]).map(String) : [];
    if (!versions.includes(UPSTREAM_PROTOCOL_VERSION)) throw new UpstreamError(`upstream ${name} does not support MCP ${UPSTREAM_PROTOCOL_VERSION} (supportedVersions: ${JSON.stringify(versions)})`);
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= UPSTREAM_MAX_LIST_PAGES) throw new UpstreamError(`upstream ${name}: tools/list did not end within ${UPSTREAM_MAX_LIST_PAGES} pages`);
      const result = asRecord(await client.request("tools/list", cursor === undefined ? {} : { cursor }, undefined, UPSTREAM_TIMEOUT_MS), name, "tools/list result");
      if (!Array.isArray(result["tools"])) throw new UpstreamError(`upstream ${name}: tools/list result has no tools array`);
      for (const raw of result["tools"] as unknown[]) {
        const t = asRecord(raw, name, "tool");
        const toolName = t["name"];
        if (typeof toolName !== "string" || !UPSTREAM_TOOL_NAME_RE.test(toolName)) throw new UpstreamError(`upstream ${name}: tool name ${JSON.stringify(String(toolName)).slice(0, 160)} is outside [A-Za-z0-9_.-]{1,128}`);
        if (names.has(toolName)) throw new UpstreamError(`upstream ${name}: duplicate tool name ${toolName}`);
        names.add(toolName);
        const info: ToolInfo = { server: name, name: toolName };
        if (typeof t["description"] === "string") info.description = t["description"];
        if (t["inputSchema"] !== undefined) info.inputSchema = t["inputSchema"];
        if (t["annotations"] !== undefined && typeof t["annotations"] === "object" && t["annotations"] !== null) info.annotations = t["annotations"] as ToolAnnotations;
        tools.push(info);
      }
      const next = result["nextCursor"];
      if (next === undefined || next === null) break;
      if (typeof next !== "string" || next.length === 0) throw new UpstreamError(`upstream ${name}: tools/list nextCursor is not a string`);
      cursor = next;
    }
  }
  return {
    async listTools() { return structuredClone(tools); },
    async execute(call) {
      if (!call || typeof call.server !== "string" || typeof call.tool !== "string") throw new Error("upstream: malformed call");
      const client = clients.get(call.server);
      if (!client) throw new Error(`upstream: unknown upstream ${call.server}`);
      const args = typeof call.args === "object" && call.args !== null && !Array.isArray(call.args) ? call.args : {};
      const result = asRecord(await client.request("tools/call", { name: call.tool, arguments: args }, call.tool, UPSTREAM_TIMEOUT_MS), call.server, "tools/call result");
      if (result["resultType"] !== "complete") return { content: [{ type: "text", text: UPSTREAM_INPUT_REQUIRED_TEXT }], isError: true };
      return { content: Array.isArray(result["content"]) ? result["content"] : [], isError: result["isError"] === true };
    },
    async close() {
      closed = true;
      for (const c of inflight) c.abort(new UpstreamClosed("upstream: closed"));
      inflight.clear();
    },
  };
}

function asRecord(v: unknown, name: string, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new UpstreamError(`upstream ${name}: ${what} is not an object`);
  return v as Record<string, unknown>;
}

/** RFC 9110 field values are visible ASCII, space and tab; the transport's Base64 sentinel carries anything else (and anything that looks like the sentinel). */
export function encodeHeaderValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e\t]*[\x21-\x7e])?$/.test(value);
  if (plain && !(value.startsWith("=?base64?") && value.endsWith("?="))) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** One upstream over `fetch`. The bearer is a private field of this object, which never leaves the closure of `connectUpstreams`. */
class HttpClient {
  #bearer: string | undefined;
  #id = 0;
  constructor(private readonly name: string, private readonly url: string, bearer: string | undefined, private readonly inflight: Set<AbortController>, private readonly isClosed: () => boolean) { this.#bearer = bearer; }

  async request(method: string, params: Record<string, unknown>, mcpName: string | undefined, timeoutMs: number): Promise<unknown> {
    if (this.isClosed()) throw new UpstreamClosed("upstream: closed");
    const id = ++this.#id;
    const headers: Record<string, string> = {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-protocol-version": UPSTREAM_PROTOCOL_VERSION, "mcp-method": method,
    };
    if (mcpName !== undefined) headers["mcp-name"] = encodeHeaderValue(mcpName);
    if (this.#bearer !== undefined) headers["authorization"] = `Bearer ${this.#bearer}`;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: { [META_VERSION]: UPSTREAM_PROTOCOL_VERSION, [META_CAPS]: {}, [META_CLIENT]: { name: UPSTREAM_CLIENT_NAME, version: clientVersion } } } });
    const controller = new AbortController();
    this.inflight.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new UpstreamTimeout(`upstream ${this.name}: no response to ${method} within ${timeoutMs} ms`)); }, timeoutMs);
    try {
      let res: Response;
      try { res = await fetch(this.url, { method: "POST", headers, body, signal: controller.signal, redirect: "error" }); }
      catch (e) { throw this.abortReason(controller, timedOut, e, method); }
      const text = await this.readBody(res, controller, timedOut, method);
      if (res.status !== 200) {
        const rpc = tryJson(text);
        const detail = rpc && typeof rpc === "object" && "error" in rpc ? ` (${clip(JSON.stringify((rpc as { error: unknown }).error))})` : "";
        throw new UpstreamError(`upstream ${this.name}: HTTP ${res.status} on ${method}${detail}`);
      }
      const ct = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      let message: unknown;
      if (ct === "application/json") message = tryJson(text) ?? (() => { throw new UpstreamError(`upstream ${this.name}: ${method} response is not JSON`); })();
      else if (ct === "text/event-stream") message = sseResponse(text, id) ?? (() => { throw new UpstreamError(`upstream ${this.name}: ${method} SSE stream ended without a response`); })();
      else throw new UpstreamError(`upstream ${this.name}: ${method} response has content-type ${JSON.stringify(ct)}`);
      const m = asRecord(message, this.name, `${method} response`);
      if (m["id"] !== id) throw new UpstreamError(`upstream ${this.name}: ${method} response id does not match`);
      if ("error" in m) throw new UpstreamError(`upstream ${this.name}: ${method} failed: ${clip(JSON.stringify(m["error"]))}`);
      if (!("result" in m)) throw new UpstreamError(`upstream ${this.name}: ${method} response has neither result nor error`);
      return m["result"];
    } finally { clearTimeout(timer); this.inflight.delete(controller); }
  }

  private abortReason(controller: AbortController, timedOut: boolean, e: unknown, method: string): Error {
    if (controller.signal.aborted) {
      const reason: unknown = controller.signal.reason;
      if (reason instanceof UpstreamTimeout || reason instanceof UpstreamClosed) return reason;
      return timedOut ? new UpstreamTimeout(`upstream ${this.name}: ${method} timed out`) : new UpstreamClosed("upstream: closed");
    }
    return new UpstreamError(`upstream ${this.name}: ${method} request failed (${e instanceof Error ? e.name : "error"})`);
  }

  /** Reads at most UPSTREAM_MAX_RESPONSE_BYTES; a longer body aborts the request and throws. */
  private async readBody(res: Response, controller: AbortController, timedOut: boolean, method: string): Promise<string> {
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > UPSTREAM_MAX_RESPONSE_BYTES) { controller.abort(); throw new UpstreamError(`upstream ${this.name}: ${method} response exceeds ${UPSTREAM_MAX_RESPONSE_BYTES} bytes`); }
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > UPSTREAM_MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new UpstreamError(`upstream ${this.name}: ${method} response exceeds ${UPSTREAM_MAX_RESPONSE_BYTES} bytes`); }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof UpstreamError) throw e;
      throw this.abortReason(controller, timedOut, e, method);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);
function tryJson(text: string): unknown { try { return JSON.parse(text) as unknown; } catch { return undefined; } }

/**
 * WHATWG HTML "Interpreting an event stream" (https://html.spec.whatwg.org/multipage/server-sent-events.html, read
 * 2026-10-03): lines end with CRLF, LF or CR; a line starting with `:` is a comment; field = text before the first `:`,
 * value = text after it minus one leading space; `data` appends value + LF to the buffer; a blank line dispatches (trailing
 * LF removed; empty buffer = no event); other fields (`event`, `id`, `retry`) are ignored here. Returns the JSON-RPC
 * message whose `id` is `wantId` and that carries `result` or `error`, or undefined when the stream had none.
 */
export function sseResponse(stream: string, wantId: number): unknown {
  const text = stream.startsWith("﻿") ? stream.slice(1) : stream;
  const lines = text.split(/\r\n|\n|\r/);
  let data = ""; let found: unknown;
  const dispatch = () => {
    if (data.length === 0) return;
    const payload = data.endsWith("\n") ? data.slice(0, -1) : data;
    data = "";
    const msg = tryJson(payload);
    if (found === undefined && typeof msg === "object" && msg !== null && !Array.isArray(msg) && (msg as { id?: unknown }).id === wantId && ("result" in msg || "error" in msg)) found = msg;
  };
  for (const line of lines) {
    if (line.length === 0) { dispatch(); continue; }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data += `${value}\n`;
  }
  dispatch();
  return found;
}
