import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolCall, ToolInfo } from "../src/types/index.js";
import type { SecretsProvider } from "../src/secrets/contract.js";
import {
  UPSTREAM_INPUT_REQUIRED_TEXT, UPSTREAM_MAX_LIST_PAGES, UPSTREAM_MAX_RESPONSE_BYTES, UPSTREAM_PROTOCOL_VERSION, UPSTREAM_TIMEOUT_MS,
  UpstreamClosed, UpstreamError, UpstreamTimeout, connectUpstreams, encodeHeaderValue, sseResponse,
} from "../src/upstream/contract.js";

// Slice 2a pin 4: a REAL node:http fake upstream speaking MCP 2026-07-28 (headers + _meta re-read from the spec on 2026-10-03).
interface Seen { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown>; method: string; }
interface FakeOptions {
  supportedVersions?: string[];
  pages?: unknown[][];                                  // tools/list pages; nextCursor between them
  bearer?: string;                                      // required Authorization: Bearer <bearer> (401 otherwise)
  call?: (params: Record<string, unknown>, id: unknown, res: ServerResponse) => void | Promise<void>; // custom tools/call answer
  rawResponse?: (req: IncomingMessage, res: ServerResponse) => boolean;
}
const TOKEN_A = "upstream-bearer-canary-A-5e1f"; const TOKEN_B = "upstream-bearer-canary-B-7a9c";
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const ok = (res: ServerResponse, id: unknown, result: unknown) => json(res, 200, { jsonrpc: "2.0", id, result });
const TOOL_ECHO = { name: "echo", description: "echoes", inputSchema: { type: "object", properties: { message: { type: "string" } } }, annotations: { readOnlyHint: true } };
const TOOL_WIPE = { name: "wipe", description: "wipes", inputSchema: { type: "object" }, annotations: { destructiveHint: true } };

const servers: Server[] = [];
afterEach(async () => { vi.useRealTimers(); for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r())); });
async function fake(o: FakeOptions = {}): Promise<{ url: string; seen: Seen[]; pending: ServerResponse[] }> {
  const seen: Seen[] = []; const pending: ServerResponse[] = [];
  const pages = o.pages ?? [[TOOL_ECHO, TOOL_WIPE]];
  const server = createServer((req, res) => {
    if (o.rawResponse?.(req, res)) return;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        seen.push({ headers: req.headers, body, method: req.method ?? "" });
        if (o.bearer !== undefined && req.headers.authorization !== `Bearer ${o.bearer}`) { res.writeHead(401, { "www-authenticate": 'Bearer realm="fake"' }); res.end(); return; }
        const id = body["id"]; const params = (body["params"] ?? {}) as Record<string, unknown>;
        switch (body["method"]) {
          case "server/discover": return ok(res, id, { resultType: "complete", supportedVersions: o.supportedVersions ?? [UPSTREAM_PROTOCOL_VERSION], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "0" } }, ttlMs: 1000, cacheScope: "public" });
          case "tools/list": {
            const idx = params["cursor"] === undefined ? 0 : Number(String(params["cursor"]).replace("page-", ""));
            const result: Record<string, unknown> = { resultType: "complete", tools: pages[idx] ?? [], ttlMs: 1000, cacheScope: "public" };
            if (idx + 1 < pages.length) result["nextCursor"] = `page-${idx + 1}`;
            return ok(res, id, result);
          }
          case "tools/call":
            if (o.call) { pending.push(res); return o.call(params, id, res); }
            return ok(res, id, { resultType: "complete", content: [{ type: "text", text: `called ${String(params["name"])} with ${JSON.stringify(params["arguments"])}` }], isError: false });
          default: return json(res, 404, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
        }
      })();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen, pending };
}
const secrets = (map: Record<string, Record<string, string>>): SecretsProvider => ({ async get(server) { return { ...(map[server] ?? {}) }; } });
const noSecrets = secrets({});
const call = (server: string, tool: string, args: Record<string, unknown> = {}): ToolCall => ({ callId: "c1", sessionId: "s1", agentId: "a1", server, tool, args, receivedAt: "2026-10-03T00:00:00.000Z" });
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

describe("upstream: connectUpstreams over Streamable HTTP 2026-07-28", () => {
  it("combines the tool lists of two upstreams with the config name as `server`, follows nextCursor pages, passes description/inputSchema/annotations through, and listTools() returns a copy", async () => {
    const a = await fake({ pages: [[TOOL_ECHO], [TOOL_WIPE]] });
    const b = await fake({ pages: [[{ name: "search", inputSchema: { type: "object" } }]] });
    const up = await connectUpstreams([{ name: "demo", transport: "http", url: a.url }, { name: "other", transport: "http", url: b.url }], noSecrets);
    const tools = await up.listTools();
    expect(tools).toEqual<ToolInfo[]>([
      { server: "demo", name: "echo", description: "echoes", inputSchema: TOOL_ECHO.inputSchema, annotations: { readOnlyHint: true } },
      { server: "demo", name: "wipe", description: "wipes", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
      { server: "other", name: "search", inputSchema: { type: "object" } },
    ]);
    expect(a.seen.map((s) => s.body["method"])).toEqual(["server/discover", "tools/list", "tools/list"]);
    expect((a.seen[2]!.body["params"] as Record<string, unknown>)["cursor"]).toBe("page-1");
    (tools[0] as { name: string }).name = "mutated"; tools.length = 0;
    expect((await up.listTools()).map((t) => t.name)).toEqual(["echo", "wipe", "search"]);
    await up.close();
  });
  it("every request carries the 2026-07-28 headers and _meta; Mcp-Name only on tools/call; the bearer from secrets goes only to its own upstream", async () => {
    const a = await fake({ bearer: TOKEN_A }); const b = await fake();
    const up = await connectUpstreams([{ name: "demo", transport: "http", url: a.url }, { name: "open", transport: "http", url: b.url }], secrets({ demo: { bearerToken: TOKEN_A, other: TOKEN_B } }));
    await up.execute(call("demo", "echo", { message: "hi" }));
    await up.execute(call("open", "echo", {}));
    for (const s of [...a.seen, ...b.seen]) {
      expect(s.method).toBe("POST");
      expect(s.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(s.headers["mcp-method"]).toBe(s.body["method"]);
      expect(s.headers["accept"]).toBe("application/json, text/event-stream");
      expect(s.headers["content-type"]).toBe("application/json");
      expect(s.body["jsonrpc"]).toBe("2.0"); expect(typeof s.body["id"]).toBe("number");
      const meta = (s.body["params"] as Record<string, unknown>)["_meta"] as Record<string, unknown>;
      expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
      expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
      expect(meta["io.modelcontextprotocol/clientInfo"]).toMatchObject({ name: "agent-ledger-proxy", version: expect.any(String) });
      if (s.body["method"] === "tools/call") expect(s.headers["mcp-name"]).toBe("echo"); else expect(s.headers["mcp-name"]).toBeUndefined();
      expect(s.headers["mcp-session-id"]).toBeUndefined();
    }
    expect(a.seen.every((s) => s.headers.authorization === `Bearer ${TOKEN_A}`)).toBe(true);
    expect(b.seen.every((s) => s.headers.authorization === undefined)).toBe(true);
    expect((a.seen.at(-1)!.body["params"] as Record<string, unknown>)["arguments"]).toEqual({ message: "hi" });
    // the token is held in a closure: not on the object, not serialisable, not in any own property descriptor
    expect(JSON.stringify(up)).toBe("{}"); expect(JSON.stringify(Object.getOwnPropertyDescriptors(up))).not.toContain(TOKEN_A);
    expect(JSON.stringify(await up.listTools())).not.toContain(TOKEN_A);
    await up.close();
  });
  it("execute: content and isError pass through; an unknown upstream throws `unknown upstream` without sending anything; an input_required result is never forwarded", async () => {
    let mode: "ok" | "error" | "input" = "ok";
    const a = await fake({ call: (params, id, res) => {
      if (mode === "error") return ok(res, id, { resultType: "complete", content: [{ type: "text", text: "bad input" }], isError: true });
      if (mode === "input") return ok(res, id, { resultType: "input_required", inputRequests: { login: { method: "elicitation/create", params: { message: "secret question canary" } } }, requestState: "state-canary" });
      return ok(res, id, { resultType: "complete", content: [{ type: "text", text: `echo ${String((params["arguments"] as Record<string, unknown>)["message"])}` }], isError: false });
    } });
    const up = await connectUpstreams([{ name: "demo", transport: "http", url: a.url }], noSecrets);
    expect(await up.execute(call("demo", "echo", { message: "hello" }))).toEqual({ content: [{ type: "text", text: "echo hello" }], isError: false });
    mode = "error";
    expect(await up.execute(call("demo", "echo"))).toEqual({ content: [{ type: "text", text: "bad input" }], isError: true });
    mode = "input";
    const r = await up.execute(call("demo", "echo"));
    expect(r).toEqual({ content: [{ type: "text", text: UPSTREAM_INPUT_REQUIRED_TEXT }], isError: true });
    expect(JSON.stringify(r)).not.toMatch(/canary|inputRequests|elicitation/);
    const before = a.seen.length;
    await expect(up.execute(call("nope", "echo"))).rejects.toThrow(/unknown upstream nope/);
    expect(a.seen.length).toBe(before);
    await up.close();
  });
  it("refuses an upstream whose server/discover does not list 2026-07-28, naming it and the versions it gave", async () => {
    const a = await fake({ supportedVersions: ["2025-11-25", "2025-06-18"] });
    await expect(connectUpstreams([{ name: "legacy", transport: "http", url: a.url }], noSecrets)).rejects.toThrow(/upstream legacy does not support MCP 2026-07-28 \(supportedVersions: \["2025-11-25","2025-06-18"\]\)/);
    expect(a.seen.map((s) => s.body["method"])).toEqual(["server/discover"]); // tools/list never asked
  });
  it("a text/event-stream response is read to the JSON-RPC response with the request's id (notifications, comments, CRLF ignored); a stream with no terminal response throws", async () => {
    let terminal = true;
    const a = await fake({ call: (_p, id, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": keep-alive\r\n\r\n");
      res.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\r\n\r\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { resultType: "complete", content: [{ type: "text", text: "wrong id" }] } })}\n\n`);
      if (terminal) res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", content: [{ type: "text", text: "streamed" }], isError: false } })}\n\n`);
      res.end();
    } });
    const up = await connectUpstreams([{ name: "demo", transport: "http", url: a.url }], noSecrets);
    expect(await up.execute(call("demo", "echo"))).toEqual({ content: [{ type: "text", text: "streamed" }], isError: false });
    terminal = false;
    await expect(up.execute(call("demo", "echo"))).rejects.toThrow(/SSE stream ended without a response/);
    await up.close();
  });
  it("30 s with no answer → UpstreamTimeout (name is the errorClass); the request is aborted", async () => {
    const a = await fake({ call: () => { /* never answers */ } });
    const up = await connectUpstreams([{ name: "demo", transport: "http", url: a.url }], noSecrets);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = up.execute(call("demo", "echo"));
    const settled = pending.then(() => "resolved", (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS - 1);
    expect(a.pending).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    const err = await settled;
    expect(err).toBeInstanceOf(UpstreamTimeout);
    expect((err as Error).name).toBe("UpstreamTimeout");
    expect((err as Error).message).toMatch(/upstream demo: no response to tools\/call within 30000 ms/);
    vi.useRealTimers();
    for (const res of a.pending) res.destroy();
    await up.close();
  });
  it("close() aborts in-flight requests with UpstreamClosed and refuses later ones", async () => {
    const a = await fake({ call: () => { /* never answers */ } });
    const up = await connectUpstreams([{ name: "demo", transport: "http", url: a.url }], noSecrets);
    const pending = up.execute(call("demo", "echo")).then(() => "resolved", (e: unknown) => e);
    await vi.waitFor(() => expect(a.pending).toHaveLength(1));
    await up.close();
    expect(await pending).toBeInstanceOf(UpstreamClosed);
    await expect(up.execute(call("demo", "echo"))).rejects.toBeInstanceOf(UpstreamClosed);
    for (const res of a.pending) res.destroy();
  });
  it("a response body over 4 MiB is refused (streamed and Content-Length forms)", async () => {
    let declared = false;
    const a = await fake({ call: (_p, id, res) => {
      const big = JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", content: [{ type: "text", text: "x".repeat(UPSTREAM_MAX_RESPONSE_BYTES + 1024) }] } });
      if (declared) { res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(big)) }); res.end(big); return; }
      res.writeHead(200, { "content-type": "application/json" });
      for (let i = 0; i < big.length; i += 65536) res.write(big.slice(i, i + 65536));
      res.end();
    } });
    const up = await connectUpstreams([{ name: "demo", transport: "http", url: a.url }], noSecrets);
    await expect(up.execute(call("demo", "echo"))).rejects.toThrow(/response exceeds 4194304 bytes/);
    declared = true;
    await expect(up.execute(call("demo", "echo"))).rejects.toThrow(/response exceeds 4194304 bytes/);
    await up.close();
  });
  it("non-200, JSON-RPC error, mismatched id and a foreign content-type are UpstreamError; the bearer appears in none of them", async () => {
    let mode = 0;
    const a = await fake({ bearer: TOKEN_A, call: (_p, id, res) => {
      if (mode === 1) return json(res, 500, { jsonrpc: "2.0", id, error: { code: -32603, message: "server exploded" } });
      if (mode === 2) return json(res, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool: echo" } });
      if (mode === 3) return ok(res, 12345, { resultType: "complete", content: [] });
      if (mode === 4) { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>"); return; }
      return ok(res, id, { resultType: "complete", content: [] });
    } });
    const up = await connectUpstreams([{ name: "demo", transport: "http", url: a.url }], secrets({ demo: { bearerToken: TOKEN_A } }));
    const expectations: [number, RegExp][] = [[1, /HTTP 500 on tools\/call \(.*server exploded/], [2, /tools\/call failed: .*Unknown tool: echo/], [3, /response id does not match/], [4, /content-type "text\/html"/]];
    for (const [m, re] of expectations) {
      mode = m;
      let err: unknown; try { await up.execute(call("demo", "echo")); } catch (e) { err = e; }
      expect(err, String(m)).toBeInstanceOf(UpstreamError);
      expect((err as Error).message, String(m)).toMatch(re);
      expect((err as Error).message).not.toContain(TOKEN_A);
    }
    // a wrong bearer at connect time: the 401 is reported without the token
    const b = await fake({ bearer: "something-else" });
    let err: unknown; try { await connectUpstreams([{ name: "demo", transport: "http", url: b.url }], secrets({ demo: { bearerToken: TOKEN_A } })); } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/HTTP 401 on server\/discover/); expect((err as Error).message).not.toContain(TOKEN_A);
    await up.close();
  });
  it("config refusals: invalid, reserved and duplicate names; stdio not implemented; unknown transport; bad URL; userinfo in the URL; command/args on http", async () => {
    const a = await fake();
    const bad: [Partial<Record<string, unknown>>[], RegExp][] = [
      [[{ name: "bad name", transport: "http", url: a.url }], /"bad name" is not an MCP server name/],
      [[{ name: "builtin_codex", transport: "http", url: a.url }], /impersonates a builtin namespace/],
      [[{ name: "demo", transport: "http", url: a.url }, { name: "demo", transport: "http", url: a.url }], /duplicate upstream name demo/],
      [[{ name: "local", transport: "stdio", command: "node" }], /^not implemented: upstream\.connectUpstreams\(stdio\)/],
      [[{ name: "demo", transport: "grpc", url: a.url }], /unknown transport/],
      [[{ name: "demo", transport: "http", url: "not a url" }], /url is not a valid URL/],
      [[{ name: "demo", transport: "http", url: "ftp://127.0.0.1/mcp" }], /url must be http\(s\)/],
      [[{ name: "demo", transport: "http", url: `http://user:${TOKEN_B}@127.0.0.1:1/mcp` }], /credentials in the URL are refused/],
      [[{ name: "demo", transport: "http", url: a.url, command: "node" }], /command\/args belong to the stdio transport/],
    ];
    for (const [config, re] of bad) {
      let err: unknown; try { await connectUpstreams(config as never, noSecrets); } catch (e) { err = e; }
      expect((err as Error).message, re.source).toMatch(re);
      expect((err as Error).message).not.toContain(TOKEN_B);
    }
    expect(a.seen).toEqual([]); // every refusal happened before any request
    await expect(connectUpstreams("nope" as never, noSecrets)).rejects.toThrow(/config must be an array/);
    await expect(connectUpstreams([], undefined as never)).rejects.toThrow(/secrets provider is required/);
    const empty = await connectUpstreams([], noSecrets);
    expect(await empty.listTools()).toEqual([]);
  });
  it("tool-name refusals: a name outside [A-Za-z0-9_.-]{1,128}, a duplicate, a non-array tools field and an unbounded cursor chain refuse the upstream", async () => {
    const a = await fake({ pages: [[{ name: "bad name!" }]] });
    await expect(connectUpstreams([{ name: "demo", transport: "http", url: a.url }], noSecrets)).rejects.toThrow(/tool name "bad name!" is outside/);
    const b = await fake({ pages: [[TOOL_ECHO, TOOL_ECHO]] });
    await expect(connectUpstreams([{ name: "demo", transport: "http", url: b.url }], noSecrets)).rejects.toThrow(/duplicate tool name echo/);
    const c = await fake({ rawResponse: (req, res) => { if (req.headers["mcp-method"] !== "tools/list") return false; json(res, 200, { jsonrpc: "2.0", id: 2, result: { resultType: "complete", tools: "nope" } }); return true; } });
    await expect(connectUpstreams([{ name: "demo", transport: "http", url: c.url }], noSecrets)).rejects.toThrow(/has no tools array/);
    const d = await fake({ rawResponse: (req, res) => { if (req.headers["mcp-method"] !== "tools/list") return false; const chunks: Buffer[] = []; req.on("data", (x: Buffer) => chunks.push(x)); req.on("end", () => { const id = (JSON.parse(Buffer.concat(chunks).toString()) as { id: number }).id; json(res, 200, { jsonrpc: "2.0", id, result: { resultType: "complete", tools: [], nextCursor: "again" } }); }); return true; } });
    await expect(connectUpstreams([{ name: "demo", transport: "http", url: d.url }], noSecrets)).rejects.toThrow(new RegExp(`did not end within ${UPSTREAM_MAX_LIST_PAGES} pages`));
  });
  it("encodeHeaderValue: plain header-safe values pass; non-ASCII, whitespace-padded and sentinel-looking values use the Base64 sentinel (transport §Value Encoding)", () => {
    expect(encodeHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeHeaderValue("admin.tools.list")).toBe("admin.tools.list");
    expect(encodeHeaderValue("Hello, 世界")).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
    expect(encodeHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(encodeHeaderValue("line1\nline2")).toBe("=?base64?bGluZTEKbGluZTI=?=");
    expect(encodeHeaderValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
  });
  it("sseResponse: CR, LF and CRLF line endings, a BOM, comments, multi-line data, unknown fields; returns the response with the wanted id", () => {
    const want = { jsonrpc: "2.0", id: 7, result: { resultType: "complete", content: [] } };
    const stream = `﻿: comment\r\nevent: message\rid: 1\nretry: 10\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0",\rdata: "id":7,"result":{"resultType":"complete","content":[]}}\r\n\r\n`;
    expect(sseResponse(stream, 7)).toEqual(want);
    expect(sseResponse(stream, 8)).toBeUndefined();
    expect(sseResponse(`data: {"jsonrpc":"2.0","id":7,"result":{}}`, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: {} }); // no trailing blank line: dispatched at end of stream
    expect(sseResponse("data:\n\n", 7)).toBeUndefined();
    expect(sseResponse("data: not json\n\n", 7)).toBeUndefined();
  });
});
