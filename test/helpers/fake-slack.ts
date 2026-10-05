// Slice 2b pin 8: a REAL loopback Slack, Web API + Socket Mode, for the e2e (no dependency, no real Slack call).
// node:http on 127.0.0.1:<ephemeral> serving POST /api/{auth.test, users.info, apps.connections.open, chat.postMessage, chat.update,
// chat.postEphemeral} and a WebSocket upgrade on /link with minimal RFC 6455 text framing (client frames must be masked,
// server frames are not; no extensions, no subprotocol). Shapes follow docs.slack.dev (read 2026-10-04):
// apps.connections.open → { ok, url }; first frame `hello` with connection_info.app_id; envelopes
// { envelope_id, type, payload, accepts_response_payload }; acks { envelope_id }; `disconnect` { reason }.
// Nothing here imports product code. Every API call is recorded as { method, body } with the Authorization header CHECKED
// and DROPPED, so the leak sweep can assert that no token ever reached a body.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"; // RFC 6455 §1.3

export interface FakeSlackOptions { botToken: string; appToken: string; teamId?: string; appId?: string; botUserId?: string; }
export interface ApiCall { method: string; body: Record<string, unknown>; at: number; }
export interface PostedMessage { ts: string; channel: string; body: Record<string, unknown>; }
export interface WsConn {
  readonly id: number; readonly openedAt: number; closedAt?: number;
  /** Every parsed text frame the client sent. */
  readonly received: Record<string, unknown>[];
  /** Frames that violated the client rules (unmasked, bad opcode); must stay 0. */
  violations: number;
  send(obj: unknown): void; close(code?: number): void; readonly open: boolean;
}
export interface ClickOptions {
  action?: "approve" | "deny"; userId: string; teamId?: string;
  /** Forgeries for pin 8 step 7: each replaces exactly one field of an otherwise valid click. */
  forge?: { nonce?: string; ts?: string; channel?: string; appId?: string; blockId?: string; extraAction?: boolean };
  /** Which connection gets it: the newest open one (default) or a specific connection id. */
  connId?: number;
}

export class FakeSlack {
  readonly calls: ApiCall[] = [];
  readonly posted: PostedMessage[] = [];
  readonly conns: WsConn[] = [];
  /** Per-envelope ack counts (envelope_id → acks received). */
  readonly acks = new Map<string, number>();
  readonly sentEnvelopes: string[] = [];
  /** Requests that carried a missing or wrong token (never the value). */
  readonly authFailures: string[] = [];
  /** method → Slack error code answered with ok:false until cleared. */
  readonly failures = new Map<string, string>();
  readonly teamId: string; readonly appId: string; readonly botUserId: string;
  private server!: Server; private port = 0; private tsCounter = 100; private connCounter = 0;
  private readonly tickets = new Set<string>();
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly o: FakeSlackOptions) {
    this.teamId = o.teamId ?? "T0FAKETEAM1"; this.appId = o.appId ?? "A0FAKEAPP01"; this.botUserId = o.botUserId ?? "U0FAKEBOT01";
  }

  get apiBaseUrl(): string { return `http://127.0.0.1:${this.port}/api/`; }

  async start(): Promise<void> {
    this.server = createServer((req, res) => { void this.handle(req).then(({ status, body }) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); }); });
    this.server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => this.upgrade(req, socket, head));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.port = (this.server.address() as AddressInfo).port;
  }
  async stop(): Promise<void> {
    for (const c of this.conns) if (c.open) c.close(1001);
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Resolves when `pred` holds (checked on every event), or rejects after `ms`. */
  async waitFor(pred: () => boolean, ms = 10_000, what = "fake Slack condition"): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((r) => { const t = setTimeout(r, 50); this.waiters.push(() => { clearTimeout(t); r(); }); });
    }
  }
  private notify(): void { for (const w of this.waiters.splice(0)) w(); }
  /** ts of every posted message a test has already paired with a call (Astra F1: never hand one message to two calls). */
  readonly claimed = new Set<string>();
  /** Waits for the oldest posted message nobody has claimed yet, claims it and returns it. */
  async claimNext(ms = 10_000, what = "an unclaimed chat.postMessage"): Promise<PostedMessage> {
    const t0 = Date.now();
    for (;;) {
      // re-checked after every wake-up: several waiters may wake for one message, and only the first may claim it
      await this.waitFor(() => this.posted.some((m) => !this.claimed.has(m.ts)), Math.max(0, ms - (Date.now() - t0)), what);
      const m = this.posted.find((x) => !this.claimed.has(x.ts));
      if (m !== undefined) { this.claimed.add(m.ts); return m; }
    }
  }
  callsOf(method: string): ApiCall[] { return this.calls.filter((c) => c.method === method); }
  openConns(): WsConn[] { return this.conns.filter((c) => c.open); }

  // ---------- Web API ----------
  private async handle(req: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "POST" || !url.pathname.startsWith("/api/")) return { status: 404, body: { ok: false, error: "unknown_method" } };
    const method = url.pathname.slice("/api/".length);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    const ct = String(req.headers["content-type"] ?? "");
    try { body = raw.length === 0 ? {} : ct.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : (JSON.parse(raw) as Record<string, unknown>); }
    catch { return { status: 200, body: { ok: false, error: "invalid_json" } }; }
    for (const k of ["blocks", "attachments"]) if (typeof body[k] === "string") { try { body[k] = JSON.parse(body[k] as string); } catch { /* recorded as sent */ } }
    // token check: then the header is dropped (never recorded)
    const auth = String(req.headers["authorization"] ?? "");
    const want = method === "apps.connections.open" ? this.o.appToken : this.o.botToken;
    this.calls.push({ method, body, at: Date.now() }); this.notify();
    if (auth !== `Bearer ${want}`) {
      this.authFailures.push(method);
      const wrongType = auth === `Bearer ${method === "apps.connections.open" ? this.o.botToken : this.o.appToken}`;
      return { status: 200, body: { ok: false, error: wrongType ? "not_allowed_token_type" : "invalid_auth" } };
    }
    const fail = this.failures.get(method);
    if (fail !== undefined) return { status: 200, body: { ok: false, error: fail } };
    switch (method) {
      case "auth.test": return { status: 200, body: { ok: true, url: "https://fake.slack.test/", team: "fake", user: "agent-ledger", team_id: this.teamId, user_id: this.botUserId, bot_id: "B0FAKEBOT01" } };
      case "users.info": return { status: 200, body: { ok: true, user: { id: body["user"], profile: { real_name: "Ryan Zeleznock" } } } };
      case "apps.connections.open": {
        const ticket = randomBytes(12).toString("hex"); this.tickets.add(ticket);
        return { status: 200, body: { ok: true, url: `ws://127.0.0.1:${this.port}/link?ticket=${ticket}` } };
      }
      case "chat.postMessage": {
        const ts = `1790000000.${String(this.tsCounter++).padStart(6, "0")}`;
        const channel = String(body["channel"] ?? "");
        this.posted.push({ ts, channel, body }); this.notify();
        return { status: 200, body: { ok: true, channel, ts, message: { type: "message", ts, text: body["text"], bot_id: "B0FAKEBOT01" } } };
      }
      case "chat.update": return { status: 200, body: { ok: true, channel: body["channel"], ts: body["ts"], text: body["text"] } };
      case "chat.postEphemeral": return { status: 200, body: { ok: true, message_ts: `1790000000.${String(this.tsCounter++).padStart(6, "0")}` } };
      default: return { status: 200, body: { ok: false, error: "unknown_method" } };
    }
  }

  // ---------- Socket Mode (RFC 6455, text frames only) ----------
  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const ticket = url.searchParams.get("ticket") ?? "";
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== "/link" || !this.tickets.delete(ticket) || typeof key !== "string" || String(req.headers["upgrade"]).toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    const conn = this.makeConn(socket);
    this.conns.push(conn);
    if (head.length > 0) socket.unshift(head);
    conn.send({ type: "hello", num_connections: this.openConns().length, debug_info: { host: "fake-slack", build_number: 1, approximate_connection_time: 18060 }, connection_info: { app_id: this.appId } });
    this.notify();
  }

  private makeConn(socket: Socket): WsConn {
    const self = this;
    let buf = Buffer.alloc(0); let fragments: Buffer[] = []; let open = true;
    const conn: WsConn = {
      id: ++this.connCounter, openedAt: Date.now(), received: [], violations: 0,
      get open() { return open; },
      send(obj: unknown) { if (open) socket.write(frame(0x1, Buffer.from(JSON.stringify(obj), "utf8"))); },
      close(code = 1000) {
        if (!open) return;
        const p = Buffer.alloc(2); p.writeUInt16BE(code); socket.write(frame(0x8, p));
        finish(); setTimeout(() => socket.destroy(), 200).unref();
      },
    };
    const finish = () => { if (open) { open = false; conn.closedAt = Date.now(); self.notify(); } };
    socket.on("close", finish); socket.on("error", finish);
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0]! & 0x80) !== 0; const op = buf[0]! & 0x0f; const masked = (buf[1]! & 0x80) !== 0;
        let len = buf[1]! & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (!masked) { conn.violations++; conn.close(1002); return; } // RFC 6455 §5.1: a client MUST mask
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4); const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
        buf = buf.subarray(off + 4 + len);
        if (op === 0x8) { if (open) { socket.write(frame(0x8, payload.subarray(0, 2))); } finish(); socket.end(); return; }
        if (op === 0x9) { socket.write(frame(0xa, payload)); continue; }
        if (op === 0xa) continue;
        if (op === 0x1 || op === 0x0) {
          fragments.push(payload);
          if (!fin) continue;
          const text = Buffer.concat(fragments).toString("utf8"); fragments = [];
          try {
            const msg = JSON.parse(text) as Record<string, unknown>;
            conn.received.push(msg);
            if (typeof msg["envelope_id"] === "string") self.acks.set(msg["envelope_id"], (self.acks.get(msg["envelope_id"]) ?? 0) + 1);
          } catch { conn.violations++; }
          self.notify();
          continue;
        }
        conn.violations++; // binary or reserved opcode: Socket Mode is JSON text only
      }
    });
    return conn;
  }

  // ---------- injections ----------
  /** Sends a `block_actions` envelope built from a posted message (its button value, ts, channel); returns the envelope id. */
  click(message: PostedMessage, o: ClickOptions): string {
    const blocks = (message.body["blocks"] ?? []) as { type?: string; block_id?: string; elements?: { action_id?: string; value?: string }[] }[];
    const actions = blocks.find((b) => b.type === "actions");
    if (!actions) throw new Error("posted message has no actions block");
    const want = o.action === "deny" ? "agent-ledger:deny" : "agent-ledger:approve";
    const button = (actions.elements ?? []).find((e) => e.action_id === want);
    if (!button || typeof button.value !== "string") throw new Error(`posted message has no ${want} button`);
    const value = o.forge?.nonce !== undefined ? `${button.value.split(":")[0]}:${o.forge.nonce}` : button.value;
    const ts = o.forge?.ts ?? message.ts; const channel = o.forge?.channel ?? message.channel;
    const teamId = o.teamId ?? this.teamId;
    const action = { type: "button", action_id: want, block_id: o.forge?.blockId ?? actions.block_id, value, action_ts: `${Date.now() / 1000}`, text: { type: "plain_text", text: o.action === "deny" ? "Deny" : "Approve" } };
    const envelope_id = randomUUID();
    const envelope = {
      envelope_id, type: "interactive", accepts_response_payload: false,
      payload: {
        type: "block_actions", api_app_id: o.forge?.appId ?? this.appId, token: "verification-token-deprecated",
        user: { id: o.userId, username: `user-${o.userId}`, name: `user-${o.userId}`, team_id: teamId },
        team: { id: teamId, domain: "fake" },
        container: { type: "message", message_ts: ts, channel_id: channel, is_ephemeral: false },
        channel: { id: channel, name: "agent-ledger-approvals" },
        message: { type: "message", ts, text: message.body["text"], blocks, bot_id: "B0FAKEBOT01" },
        trigger_id: `${Date.now()}.fake`, response_url: `http://127.0.0.1:${this.port}/response/${randomBytes(6).toString("hex")}`,
        actions: o.forge?.extraAction ? [action, { ...action }] : [action],
      },
    };
    this.deliver(envelope, o.connId);
    return envelope_id;
  }
  /** A non-actionable envelope (e.g. an events_api push) that must still be acked. */
  sendEvent(connId?: number): string {
    const envelope_id = randomUUID();
    this.deliver({ envelope_id, type: "events_api", accepts_response_payload: false, payload: { type: "event_callback", event: { type: "app_mention" } } }, connId);
    return envelope_id;
  }
  disconnect(reason: "warning" | "refresh_requested" | "link_disabled", connId?: number): void {
    this.target(connId).send({ type: "disconnect", reason, debug_info: { host: "fake-slack" } });
  }
  private deliver(envelope: { envelope_id: string; [k: string]: unknown }, connId?: number): void { this.sentEnvelopes.push(envelope.envelope_id); this.target(connId).send(envelope); }
  private target(connId?: number): WsConn {
    const c = connId !== undefined ? this.conns.find((x) => x.id === connId && x.open) : this.openConns().at(-1);
    if (!c) throw new Error("no open Socket Mode connection");
    return c;
  }
}

/** A server→client frame: FIN set, never masked (RFC 6455 §5.1). */
function frame(op: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 0xff]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
  return Buffer.concat([head, payload]);
}
