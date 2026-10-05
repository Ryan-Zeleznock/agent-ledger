// ADR-018 §1/§2 (server audit P2-1, P2-2; /cso LOWs 557b4677, e67ede20): the front authenticates FIRST, caps
// connections, bounds the body read in time, and caps requests in flight per agent. Real node:http on 127.0.0.1:0.
import { afterEach, describe, expect, it, vi } from "vitest";
import net from "node:net";
import type { IncomingCall, ToolResult } from "../src/types/index.js";
import { JSONRPC_OVERLOADED, MCP_ENDPOINT_PATH, REFUSED_LINGER_MS, createFrontServer, startFront, type FrontAuthenticate, type RunningFront } from "../src/front/contract.js";
import { mcpPost } from "./helpers/mcp-client.js";

const AGENTS: Record<string, string> = { "key-a-7f3e": "agent-a", "key-b-91c2": "agent-b" };
const known: FrontAuthenticate = (b) => AGENTS[b];
const TOOLS = [{ server: "demo", name: "echo", inputSchema: { type: "object" } }, { server: "demo", name: "wipe" }];
const running: RunningFront[] = [];
afterEach(async () => { for (const f of running.splice(0)) await f.stop(); });

async function start(o: { authenticate?: FrontAuthenticate; maxConnections?: number; maxInFlightPerAgent?: number; bodyTimeoutMs?: number; hold?: () => Promise<void> } = {}) {
  const calls: IncomingCall[] = [];
  const handler = vi.fn(async (c: IncomingCall): Promise<ToolResult> => { calls.push(c); if (o.hold) await o.hold(); return { content: [{ type: "text", text: "ok" }], isError: false }; });
  const authenticate = vi.fn(o.authenticate ?? known);
  const f = await startFront(handler, { mode: "http", port: 0, allowedOrigins: [], tools: async () => TOOLS, authenticate,
    ...(o.maxConnections !== undefined ? { maxConnections: o.maxConnections } : {}), ...(o.maxInFlightPerAgent !== undefined ? { maxInFlightPerAgent: o.maxInFlightPerAgent } : {}),
    ...(o.bodyTimeoutMs !== undefined ? { bodyTimeoutMs: o.bodyTimeoutMs } : {}) });
  running.push(f);
  return { url: `http://127.0.0.1:${f.port}${MCP_ENDPOINT_PATH}`, port: f.port, handler, authenticate, calls };
}
/** Raw socket: write `head` (and optional body bytes), collect what the server sends, resolve when it closes. */
function raw(port: number, head: string, body?: Buffer): { closed: Promise<string>; socket: net.Socket } {
  const socket = net.connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  socket.on("data", (c: Buffer) => chunks.push(c)); socket.on("error", () => undefined);
  socket.write(head); if (body) socket.write(body);
  return { socket, closed: new Promise((resolve) => socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")))) };
}
const legacyInit = (url: string, token: string) => mcpPost({ url, token, method: "initialize", meta: false, params: { protocolVersion: "2025-11-25", capabilities: {} }, headers: { "mcp-protocol-version": null, "mcp-method": null } });

describe("ADR-018 §1: authenticate first", () => {
  it("authenticate is required and the new limits are validated at construction", () => {
    const h = async () => ({ content: [], isError: false });
    expect(() => createFrontServer(h, { mode: "http", allowedOrigins: [], tools: async () => [] } as never)).toThrow(/authenticate/);
    expect(() => createFrontServer(h, { mode: "http", allowedOrigins: [], tools: async () => [], authenticate: known, maxConnections: 0 })).toThrow(/maxConnections/);
    expect(() => createFrontServer(h, { mode: "http", allowedOrigins: [], tools: async () => [], authenticate: known, maxInFlightPerAgent: 0 })).toThrow(/maxInFlightPerAgent/);
    expect(() => createFrontServer(h, { mode: "http", allowedOrigins: [], tools: async () => [], authenticate: known, bodyTimeoutMs: 0 })).toThrow(/bodyTimeoutMs/);
  });
  it.each(["tools/list", "server/discover", "tools/call"])("Bearer x → 401 on %s, nothing echoed, no handler call", async (method) => {
    const f = await start();
    const r = await mcpPost({ url: f.url, token: "x", method, params: method === "tools/call" ? { name: "demo__echo", arguments: {} } : {} });
    expect(r.status).toBe(401); expect(r.headers.get("www-authenticate")).toBe('Bearer realm="agent-ledger"');
    expect(r.text).not.toContain("demo__"); expect(r.text).not.toMatch(/"x"/); expect(f.handler).not.toHaveBeenCalled();
    expect(f.authenticate).toHaveBeenCalledWith("x");
  });
  it("legacy initialize and DELETE with an unknown bearer → 401 and no session; a known agent still initializes", async () => {
    const f = await start();
    const bad = await legacyInit(f.url, "unknown"); expect(bad.status).toBe(401); expect(bad.headers.get("mcp-session-id")).toBeNull();
    const ok = await legacyInit(f.url, "key-a-7f3e"); expect(ok.status).toBe(200);
    const del = await mcpPost({ url: f.url, token: "unknown", method: "x", httpMethod: "DELETE", headers: { "mcp-session-id": ok.headers.get("mcp-session-id")! } });
    expect(del.status).toBe(401);
  });
  it("authenticate throwing, returning a non-string or an empty id → 401 (fail closed)", async () => {
    for (const authenticate of [() => { throw new Error("db down"); }, () => 42 as never, () => "", async () => Promise.reject(new Error("x"))] as FrontAuthenticate[]) {
      const f = await start({ authenticate });
      expect((await mcpPost({ url: f.url, token: "key-a-7f3e", method: "tools/list" })).status).toBe(401);
      expect(f.handler).not.toHaveBeenCalled();
    }
  });
  it("the bearer is checked BEFORE the body is read: a 1 MiB declared body that never arrives still gets 401 at once, and the connection is cut", async () => {
    const f = await start();
    const started = Date.now();
    const c = raw(f.port, `POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer junk\r\nContent-Type: application/json\r\nContent-Length: ${1024 * 1024}\r\n\r\n`, Buffer.alloc(1000, 0x20));
    const text = await c.closed;
    expect(text).toMatch(/^HTTP\/1\.1 401 /); expect(Date.now() - started).toBeLessThan(REFUSED_LINGER_MS + 2_000);
    expect(f.authenticate).toHaveBeenCalledTimes(1);
  });
  it("probe: 150 held 1 MiB bodies with a bogus bearer are all refused and cut; the server buffers none of them", async () => {
    const f = await start();
    const before = process.memoryUsage().rss;
    const chunk = Buffer.alloc(1024 * 1024 - 10, 0x20);
    const conns = Array.from({ length: 150 }, (_, i) => raw(f.port, `POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer junk${i}\r\nContent-Type: application/json\r\nContent-Length: ${1024 * 1024}\r\n\r\n`, chunk));
    const texts = await Promise.all(conns.map((c) => c.closed));
    // each is a 401 or a cut connection (an RST can race the client's read of the 401); never any other answer
    expect(texts.map((t) => t.slice(0, 12)).filter((t) => t !== "HTTP/1.1 401" && t !== "")).toEqual([]);
    expect(texts.filter((t) => t.startsWith("HTTP/1.1 401 ")).length).toBeGreaterThan(100);
    expect(f.handler).not.toHaveBeenCalled();
    // generous: the client side of these sockets lives in this process too; the old front buffered ~150 MiB here
    expect((process.memoryUsage().rss - before) / 1048576).toBeLessThan(100);
  }, 20_000);
});

describe("ADR-018 §1: connection cap and body deadline (slowloris)", () => {
  it("an authenticated body that does not arrive within bodyTimeoutMs → 408 and the connection is cut; no handler call", async () => {
    const f = await start({ bodyTimeoutMs: 200 });
    const c = raw(f.port, `POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer key-a-7f3e\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"jsonrpc"`);
    const text = await c.closed;
    expect(text).toMatch(/^HTTP\/1\.1 408 /); expect(f.handler).not.toHaveBeenCalled();
  });
  it("maxConnections: connections beyond the cap are dropped without an answer; capacity returns when one closes", async () => {
    const f = await start({ maxConnections: 2 });
    const held = [raw(f.port, "POST /mcp HTTP/1.1\r\n"), raw(f.port, "POST /mcp HTTP/1.1\r\n")];
    await new Promise((r) => setTimeout(r, 100));
    const third = raw(f.port, "GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(await third.closed).toBe("");
    for (const h of held) h.socket.destroy();
    await Promise.all(held.map((h) => h.closed));
    await new Promise((r) => setTimeout(r, 50));
    const fourth = raw(f.port, "GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(await fourth.closed).toMatch(/^HTTP\/1\.1 200 /);
  });
});

describe("ADR-018 §2: per-agent requests in flight", () => {
  it("one agent at its cap gets 503 -30503; another agent is still admitted; the slot frees on settlement", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const f = await start({ maxInFlightPerAgent: 1, hold: () => gate });
    const call = (token: string) => mcpPost({ url: f.url, token, method: "tools/call", params: { name: "demo__echo", arguments: {} } });
    const first = call("key-a-7f3e");
    await vi.waitFor(() => expect(f.handler).toHaveBeenCalledTimes(1));
    const second = await call("key-a-7f3e");
    expect(second.status).toBe(503); expect((second.json as { error: { code: number } }).error.code).toBe(JSONRPC_OVERLOADED);
    const other = call("key-b-91c2");
    await vi.waitFor(() => expect(f.handler).toHaveBeenCalledTimes(2));
    release();
    expect((await first).status).toBe(200); expect((await other).status).toBe(200);
    expect((await call("key-a-7f3e")).status).toBe(200);
  });
});
