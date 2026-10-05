// Slice 2b pin 8: a hand-written MCP 2025-11-25 (legacy-era) Streamable HTTP server for the e2e, on 127.0.0.1:<ephemeral>.
// Behaviour per https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle and .../basic/transports (read
// 2026-10-04): `initialize` negotiates a version (same if supported, else ours) and assigns `Mcp-Session-Id` (visible
// ASCII); later requests MUST carry it (missing → 400, unknown/terminated → 404) and `MCP-Protocol-Version`; DELETE
// terminates (→ 204); GET → 405 (we offer no server-initiated stream); `notifications/initialized` → 202. A non-initialize
// POST without a session gets 400 with JSON-RPC -32000, exactly like the SDK 1.x reference server, which is NOT a
// recognized modern error, so a dual-era client falls back to `initialize` (2026-07-28 "Backward Compatibility").
// Tools: `echo { message }` and `env {}` (returns a fixed fake environment). Responses are JSON or SSE per `mode`.
// Nothing here imports product code.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const LEGACY_ENV_TEXT = "LEGACY_FAKE_ENV=harmless\nPORT=3001" as const;
export interface LegacyRequestLog { httpMethod: string; method?: string; tool?: string; session?: string; protocolVersion?: string; status: number; }
export interface LegacyUpstreamOptions {
  /** "json" (default), "sse" (every request answered as an SSE stream), or "alternate". */
  mode?: "json" | "sse" | "alternate";
  /** Optional bearer token the server demands (absent → no auth, like server-everything). */
  token?: string;
  /** SDK reference app returns 400 for a session forgotten on restart; spec expiry is 404. */
  unknownSessionStatus?: 400 | 404;
}

export class LegacyUpstream {
  readonly log: LegacyRequestLog[] = [];
  /** session id → negotiated version; every id ever minted is kept in `minted` for the leak sweep. */
  readonly sessions = new Map<string, string>();
  readonly minted: string[] = [];
  readonly server: Server = createServer((req, res) => { void this.handle(req, res); });
  private port = 0; private n = 0;
  constructor(private readonly o: LegacyUpstreamOptions = {}) {}
  get url(): string { return `http://127.0.0.1:${this.port}/mcp`; }
  toolCalls(): string[] { return this.log.filter((l) => l.method === "tools/call").map((l) => l.tool ?? "?"); }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>((r) => this.server.close(() => r())); }
  /** Simulates session expiry: the next request with that id gets 404 (the client must re-initialize). */
  expire(sessionId: string): void { this.sessions.delete(sessionId); }
  /** A restarted process has forgotten every previously issued session. */
  restart(): void { this.sessions.clear(); }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const session = header(req, "mcp-session-id"); const pv = header(req, "mcp-protocol-version");
    const entry: LegacyRequestLog = { httpMethod: req.method ?? "?", status: 0 };
    if (session !== undefined) entry.session = session;
    if (pv !== undefined) entry.protocolVersion = pv;
    this.log.push(entry);
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      entry.status = status;
      if (body === undefined) { res.writeHead(status, headers).end(); return; }
      const sse = this.o.mode === "sse" || (this.o.mode === "alternate" && this.n++ % 2 === 1);
      if (sse && status === 200) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
        // The SDK 1.x reference server (server-everything 2026.8.31, run on loopback 2026-10-04) opens every SSE response
        // with a resumability priming event whose data is EMPTY (`id: <uuid>\ndata: \n\n`); a client must skip it.
        res.end(`id: ${randomUUID()}\ndata: \n\nevent: message\nid: ${randomUUID()}\ndata: ${JSON.stringify(body)}\n\n`);
      } else { res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body)); }
    };
    const err = (status: number, code: number, message: string, id: unknown = null) => send(status, { jsonrpc: "2.0", id, error: { code, message } });
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return send(404);
    if (this.o.token !== undefined && header(req, "authorization") !== `Bearer ${this.o.token}`) return err(401, -32001, "unauthorized");
    if (req.method === "GET") return send(405, undefined, { allow: "POST, DELETE" });
    if (req.method === "DELETE") {
      if (session === undefined || !this.sessions.has(session)) return send(404);
      this.sessions.delete(session); return send(204);
    }
    if (req.method !== "POST") return send(405);
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof msg; } catch { return err(400, -32700, "Parse error"); }
    if (typeof msg.method === "string") entry.method = msg.method;
    const accept = header(req, "accept") ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return err(406, -32000, "Not Acceptable: Client must accept both application/json and text/event-stream");
    if (session === undefined) {
      if (msg.method !== "initialize") return err(400, -32000, "Bad Request: No valid session ID provided", msg.id ?? null);
      const params = msg.params ?? {};
      if (typeof params["protocolVersion"] !== "string" || typeof params["capabilities"] !== "object") return err(400, -32602, "Invalid params", msg.id);
      const requested = params["protocolVersion"];
      const negotiated = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];
      const id = randomUUID(); this.sessions.set(id, negotiated); this.minted.push(id); entry.session = id;
      return send(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: negotiated, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "legacy-fixture", version: "1.0.0" }, instructions: "hand-written 2025-11-25 fixture" } }, { "mcp-session-id": id });
    }
    const negotiated = this.sessions.get(session);
    if (negotiated === undefined) return this.o.unknownSessionStatus === 400
      ? err(400, -32000, "Bad Request: No valid session ID provided", msg.id ?? null)
      : err(404, -32001, "Session not found", msg.id ?? null);
    if (pv !== undefined ? pv !== negotiated : negotiated !== "2025-03-26") return err(400, -32000, "Bad Request: Unsupported protocol version", msg.id ?? null);
    if (msg.id === undefined) return send(202);                                          // a notification (notifications/initialized)
    switch (msg.method) {
      case "ping": return send(200, { jsonrpc: "2.0", id: msg.id, result: {} });
      case "tools/list": return send(200, { jsonrpc: "2.0", id: msg.id, result: { tools: [
        { name: "echo", description: "Echoes the message back", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
        { name: "env", description: "Returns a fake process environment", inputSchema: { type: "object", properties: {} } },
      ] } });
      case "tools/call": {
        const name = msg.params?.["name"]; const args = (msg.params?.["arguments"] ?? {}) as Record<string, unknown>;
        entry.tool = typeof name === "string" ? name : "?";
        if (name === "echo") return send(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `Echo: ${String(args["message"])}` }], isError: false } });
        if (name === "env") return send(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: LEGACY_ENV_TEXT }], isError: false } });
        return err(200, -32602, `Unknown tool`, msg.id);
      }
      default: return err(200, -32601, "Method not found", msg.id);
    }
  }
}
function header(req: IncomingMessage, name: string): string | undefined { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; }
