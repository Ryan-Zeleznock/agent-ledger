// Slice 2b pin 8: a hand-written MCP 2025-11-25 (legacy-era) client for the e2e, used against the proxy's dual-era front
// (pin 3) and, in the harness self-test, against test/helpers/legacy-upstream.ts. Lifecycle per
// https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle (read 2026-10-04): `initialize` (no
// MCP-Protocol-Version header, no modern `_meta`), keep `Mcp-Session-Id` if assigned, then `notifications/initialized`,
// then every request carries the session id and `MCP-Protocol-Version: <negotiated>`. Accepts JSON or SSE responses.
// Every knob exists so a test can send a WRONG request (another bearer, a stale session) on purpose. No product imports.
export interface LegacyReply { status: number; headers: Headers; text: string; json: Record<string, unknown> | undefined; }

export class LegacyClient {
  sessionId: string | undefined; protocolVersion: string | undefined;
  readonly replies: string[] = [];
  private nextId = 1;
  constructor(readonly url: string, public token?: string) {}

  async initialize(requested = "2025-11-25"): Promise<LegacyReply> {
    const r = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: "legacy-e2e-client", version: "0" } } }, { session: false });
    const result = r.json?.["result"] as { protocolVersion?: string } | undefined;
    if (r.status === 200 && result?.protocolVersion) { this.protocolVersion = result.protocolVersion; this.sessionId = r.headers.get("mcp-session-id") ?? undefined; }
    return r;
  }
  initialized(): Promise<LegacyReply> { return this.post({ jsonrpc: "2.0", method: "notifications/initialized" }); }
  listTools(): Promise<LegacyReply> { return this.request("tools/list", {}); }
  callTool(name: string, args: Record<string, unknown>): Promise<LegacyReply> { return this.request("tools/call", { name, arguments: args }); }
  request(method: string, params: Record<string, unknown>): Promise<LegacyReply> { return this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }); }
  async terminate(): Promise<LegacyReply> {
    const res = await fetch(this.url, { method: "DELETE", headers: this.headers(true), redirect: "manual" });
    const text = await res.text(); this.replies.push(text);
    return { status: res.status, headers: res.headers, text, json: undefined };
  }

  /** Raw POST. `session: false` omits the session and version headers (initialize). */
  async post(body: Record<string, unknown>, o: { session?: boolean } = {}): Promise<LegacyReply> {
    const res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.headers(o.session !== false) }, body: JSON.stringify(body), redirect: "manual" });
    const text = await res.text(); this.replies.push(text);
    return { status: res.status, headers: res.headers, text, json: parseReply(text, res.headers.get("content-type") ?? "", body["id"]) };
  }
  private headers(withSession: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.token !== undefined) h["authorization"] = `Bearer ${this.token}`;
    if (withSession && this.sessionId !== undefined) h["mcp-session-id"] = this.sessionId;
    if (withSession && this.protocolVersion !== undefined) h["mcp-protocol-version"] = this.protocolVersion;
    return h;
  }
}

/** JSON body, or the SSE `data:` event whose JSON-RPC id matches the request (the response, not a notification). */
export function parseReply(text: string, contentType: string, id: unknown): Record<string, unknown> | undefined {
  const tryJson = (s: string) => { try { const v = JSON.parse(s) as unknown; return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined; } catch { return undefined; } };
  if (!contentType.includes("text/event-stream")) return tryJson(text);
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    const msg = data ? tryJson(data) : undefined;
    if (msg && msg["id"] === id && ("result" in msg || "error" in msg)) return msg;
  }
  return undefined;
}
export const resultOf = (r: LegacyReply) => (r.json?.["result"] ?? {}) as Record<string, unknown>;
export const textOf = (r: LegacyReply) => ((resultOf(r)["content"] ?? []) as { type?: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
