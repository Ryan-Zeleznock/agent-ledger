import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingCall, ToolInfo, ToolResult } from "../src/types/index.js";
import {
  DEFAULT_BIND_HOST, DISCOVER_INSTRUCTIONS, DISCOVER_TTL_MS, HEALTH_PATH, INITIALIZE_MESSAGE, JSONRPC_HEADER_MISMATCH, JSONRPC_INTERNAL_ERROR, JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST, JSONRPC_METHOD_NOT_FOUND, JSONRPC_PARSE_ERROR, JSONRPC_UNSUPPORTED_VERSION, MAX_BODY_BYTES, MCP_ENDPOINT_PATH, MCP_PROTOCOL_VERSION,
  TOOLS_TTL_MS, buildExposedTable, decodeSentinel, exposedToolName, packageVersion, startFront, type RunningFront,
} from "../src/front/contract.js";
import { META_SERVER_INFO, mcpCall, mcpPost, toolText } from "./helpers/mcp-client.js";

// Slice 2a pins 3 and 5 over a REAL node:http server bound to 127.0.0.1:0 (hard rule: ephemeral ports, loopback only).
const KEY = "agent-key-canary-3f9a1c7e";
const TOOLS: ToolInfo[] = [
  { server: "demo", name: "wipe", description: "wipes nothing" },
  { server: "demo", name: "echo", description: "echoes", inputSchema: { type: "object", properties: { message: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { server: "other", name: "a.b-c_D", inputSchema: { type: "object" } },
];
const running: RunningFront[] = [];
afterEach(async () => { for (const f of running.splice(0)) await f.stop(); });
interface Started { url: string; health: string; port: number; calls: IncomingCall[]; handler: ReturnType<typeof vi.fn>; }
async function start(o: { tools?: ToolInfo[]; origins?: string[]; bindHost?: string; result?: ToolResult | Error } = {}): Promise<Started> {
  const calls: IncomingCall[] = [];
  const handler = vi.fn(async (incoming: IncomingCall): Promise<ToolResult> => {
    calls.push(incoming);
    if (o.result instanceof Error) throw o.result;
    return o.result ?? { content: [{ type: "text", text: `ran ${incoming.server}/${incoming.tool} ${JSON.stringify(incoming.args)}` }], isError: false };
  });
  const front = await startFront(handler, { mode: "http", port: 0, allowedOrigins: o.origins ?? ["https://ok.example"], tools: async () => o.tools ?? TOOLS, ...(o.bindHost ? { bindHost: o.bindHost } : {}) });
  running.push(front);
  return { url: `http://127.0.0.1:${front.port}${MCP_ENDPOINT_PATH}`, health: `http://127.0.0.1:${front.port}${HEALTH_PATH}`, port: front.port, calls, handler };
}
const rpc = (r: { json: unknown }) => r.json as { jsonrpc?: string; id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };
const serverInfo = { name: "agent-ledger", version: packageVersion };

describe("front: /healthz and routing", () => {
  it("GET /healthz → 200 {ok:true} with no auth and no handler call; HEAD 200; POST /healthz 405; unknown paths 404", async () => {
    const f = await start();
    const r = await fetch(f.health); expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true }); expect(r.headers.get("content-type")).toBe("application/json");
    expect((await fetch(f.health, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(f.health, { method: "POST" })).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${f.port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${f.port}/mcp/extra`, { method: "POST" })).status).toBe(404);
    expect(f.handler).not.toHaveBeenCalled();
  });
  it("default bind is 127.0.0.1 (IPv6 loopback refuses); bindHost 0.0.0.0 must be explicit and is accepted", async () => {
    expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
    const f = await start();
    expect((await fetch(f.health)).status).toBe(200);
    await expect(fetch(`http://[::1]:${f.port}${HEALTH_PATH}`)).rejects.toThrow();
    const any = await start({ bindHost: "0.0.0.0" });
    expect((await fetch(any.health)).status).toBe(200);
  });
  it("stop() closes the listener; stdio is not implemented; malformed options are refused before listening", async () => {
    const f = await start();
    await running.pop()!.stop();
    await expect(fetch(f.health)).rejects.toThrow();
    const h = async () => ({ content: [], isError: false });
    await expect(startFront(h, { mode: "stdio", tools: async () => [] })).rejects.toThrow(/^not implemented: front\.startFront\(stdio\)/);
    await expect(startFront(h, { mode: "http", port: 70000, allowedOrigins: [], tools: async () => [] })).rejects.toThrow(/port/);
    await expect(startFront(h, { mode: "http", port: 0, allowedOrigins: "x" as unknown as string[], tools: async () => [] })).rejects.toThrow(/allowedOrigins/);
    await expect(startFront("nope" as never, { mode: "http", port: 0, allowedOrigins: [], tools: async () => [] })).rejects.toThrow(/CallHandler/);
  });
});

describe("front: pin 3 status/code matrix (real node:http server)", () => {
  const discover = { method: "server/discover" } as const;
  const callEcho = { method: "tools/call", params: { name: "demo__echo", arguments: { message: "hi" } } } as const;
  type Case = [label: string, request: Parameters<typeof mcpPost>[0] extends infer O ? Omit<O, "url"> : never, status: number, code: number | null, extra?: (r: Awaited<ReturnType<typeof mcpPost>>) => void];
  const cases: Case[] = [
    ["GET /mcp → 405 Allow: POST", { ...discover, token: KEY, httpMethod: "GET" }, 405, null, (r) => expect(r.headers.get("allow")).toBe("POST")],
    ["DELETE /mcp → 405", { ...discover, token: KEY, httpMethod: "DELETE" }, 405, null],
    ["Origin not allowed → 403, error body without id", { ...discover, token: KEY, headers: { origin: "https://evil.example" } }, 403, JSONRPC_INVALID_REQUEST, (r) => { expect(Object.hasOwn(r.json as object, "id")).toBe(false); }],
    ["Origin allowed → 200", { ...discover, token: KEY, headers: { origin: "https://ok.example" } }, 200, null],
    ["no Authorization → 401 + WWW-Authenticate", { ...discover }, 401, JSONRPC_INVALID_REQUEST, (r) => { expect(r.headers.get("www-authenticate")).toBe('Bearer realm="agent-ledger"'); expect(Object.hasOwn(r.json as object, "id")).toBe(false); }],
    ["Basic auth → 401", { ...discover, headers: { authorization: "Basic YWJj" } }, 401, JSONRPC_INVALID_REQUEST],
    ["Bearer with no token → 401", { ...discover, headers: { authorization: "Bearer " } }, 401, JSONRPC_INVALID_REQUEST],
    ["Bearer with a non-token68 value → 401", { ...discover, headers: { authorization: "Bearer bad token!" } }, 401, JSONRPC_INVALID_REQUEST],
    ["Content-Type text/plain → 415", { ...discover, token: KEY, headers: { "content-type": "text/plain" } }, 415, JSONRPC_INVALID_REQUEST],
    ["Content-Type with charset → accepted", { ...discover, token: KEY, headers: { "content-type": "application/json; charset=utf-8" } }, 200, null],
    ["invalid JSON → 400 -32700", { ...discover, token: KEY, rawBody: "{not json" }, 400, JSONRPC_PARSE_ERROR],
    ["a batch array → 400 -32600", { ...discover, token: KEY, rawBody: "[]" }, 400, JSONRPC_INVALID_REQUEST],
    ["jsonrpc 1.0 → 400 -32600", { ...discover, token: KEY, rawBody: JSON.stringify({ jsonrpc: "1.0", id: 1, method: "server/discover" }) }, 400, JSONRPC_INVALID_REQUEST],
    ["initialize (legacy client, no version header) → 404 -32601 naming 2026-07-28", { method: "initialize", token: KEY, params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "old", version: "1" } }, meta: false, headers: { "mcp-protocol-version": null, "mcp-method": null } }, 404, JSONRPC_METHOD_NOT_FOUND, (r) => { expect(rpc(r).error!.message).toBe(INITIALIZE_MESSAGE); expect(rpc(r).error!.message).toContain("2026-07-28"); expect(rpc(r).error!.data).toEqual({ supported: ["2026-07-28"] }); }],
    ["initialize with modern headers → still 404 -32601", { method: "initialize", token: KEY }, 404, JSONRPC_METHOD_NOT_FOUND],
    ["missing MCP-Protocol-Version → 400 -32020", { ...discover, token: KEY, headers: { "mcp-protocol-version": null } }, 400, JSONRPC_HEADER_MISMATCH],
    ["missing Mcp-Method → 400 -32020", { ...discover, token: KEY, headers: { "mcp-method": null } }, 400, JSONRPC_HEADER_MISMATCH],
    ["Mcp-Method ≠ body method → 400 -32020", { ...discover, token: KEY, headers: { "mcp-method": "tools/list" } }, 400, JSONRPC_HEADER_MISMATCH],
    ["tools/call missing Mcp-Name → 400 -32020", { ...callEcho, token: KEY, headers: { "mcp-name": null } }, 400, JSONRPC_HEADER_MISMATCH],
    ["tools/call Mcp-Name ≠ params.name → 400 -32020", { ...callEcho, token: KEY, headers: { "mcp-name": "demo__wipe" } }, 400, JSONRPC_HEADER_MISMATCH],
    ["tools/call Mcp-Name in the Base64 sentinel form, decoded before comparing → 200", { ...callEcho, token: KEY, headers: { "mcp-name": `=?base64?${Buffer.from("demo__echo").toString("base64")}?=` } }, 200, null],
    ["MCP-Protocol-Version 2025-11-25 → 400 -32022 with supported/requested", { ...discover, token: KEY, protocolVersion: "2025-11-25" }, 400, JSONRPC_UNSUPPORTED_VERSION, (r) => expect(rpc(r).error!.data).toEqual({ supported: ["2026-07-28"], requested: "2025-11-25" })],
    ["_meta absent → 400 -32602", { ...discover, token: KEY, meta: false }, 400, JSONRPC_INVALID_PARAMS],
    ["_meta without clientCapabilities → 400 -32602", { ...discover, token: KEY, meta: false, params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } }, 400, JSONRPC_INVALID_PARAMS],
    ["_meta.protocolVersion ≠ header → 400 -32020", { ...discover, token: KEY, meta: false, params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25", "io.modelcontextprotocol/clientCapabilities": {} } } }, 400, JSONRPC_HEADER_MISMATCH],
    ["a notification → 202 with no body", { method: "notifications/initialized", token: KEY, notification: true }, 202, null, (r) => expect(r.text).toBe("")],
    ["unknown method → 404 -32601", { method: "resources/list", token: KEY }, 404, JSONRPC_METHOD_NOT_FOUND],
    ["unknown tool → 400 -32602 'Unknown tool: …'", { method: "tools/call", token: KEY, params: { name: "demo__nope", arguments: {} } }, 400, JSONRPC_INVALID_PARAMS, (r) => expect(rpc(r).error!.message).toBe("Unknown tool: demo__nope")],
    ["raw pair instead of the exposed name → unknown tool", { method: "tools/call", token: KEY, params: { name: "echo", arguments: {} } }, 400, JSONRPC_INVALID_PARAMS],
    ["arguments not an object → 400 -32602", { method: "tools/call", token: KEY, params: { name: "demo__echo", arguments: [1] } }, 400, JSONRPC_INVALID_PARAMS],
    ["params not an object → 400 -32600", { method: "server/discover", token: KEY, rawBody: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: [] }) }, 400, JSONRPC_INVALID_REQUEST],
    ["Mcp-Session-Id and Last-Event-ID are ignored, never echoed → 200", { ...discover, token: KEY, headers: { "mcp-session-id": "sess-123", "last-event-id": "7" } }, 200, null, (r) => { expect(r.headers.get("mcp-session-id")).toBeNull(); expect(r.text).not.toContain("sess-123"); }],
  ];
  it.each(cases)("%s", async (_label, request, status, code, extra) => {
    const f = await start();
    const r = await mcpPost({ url: f.url, ...request });
    expect(r.status).toBe(status);
    if (code !== null) {
      expect(r.headers.get("content-type")).toBe("application/json");
      expect(rpc(r).jsonrpc).toBe("2.0"); expect(rpc(r).error!.code).toBe(code); expect(typeof rpc(r).error!.message).toBe("string");
      expect(f.handler).not.toHaveBeenCalled();
      expect(r.text).not.toContain(KEY);
    }
    if (status === 200) expect(rpc(r).result).toBeDefined();
    extra?.(r);
  });
  it("a 2 MiB body → 413 and no handler call; a body just under the cap is served", async () => {
    const f = await start();
    const big = await mcpPost({ url: f.url, token: KEY, method: "server/discover", rawBody: "x".repeat(2 * 1024 * 1024) });
    expect(big.status).toBe(413); expect(f.handler).not.toHaveBeenCalled();
    const pad = "p".repeat(MAX_BODY_BYTES - 600);
    const under = await mcpPost({ url: f.url, token: KEY, method: "tools/call", params: { name: "demo__echo", arguments: { message: pad } } });
    expect(under.status).toBe(200); expect(f.handler).toHaveBeenCalledOnce();
  });
  it("every rejection before a call writes nothing through the handler: the matrix above plus a wrong key, which the front does NOT judge (identity does)", async () => {
    const f = await start({ result: { content: [{ type: "text", text: "agent-ledger: denied: unknown agent" }], isError: true } });
    const r = await mcpCall(f.url, "some-other-key", "tools/call", { name: "demo__echo", arguments: {} });
    expect(r["isError"]).toBe(true); expect(f.calls[0]!.credential).toEqual({ kind: "api_key", value: "some-other-key" });
  });
});

describe("front: discover, list, call", () => {
  it("server/discover: the pinned shape", async () => {
    const f = await start();
    expect(await mcpCall(f.url, KEY, "server/discover")).toEqual({
      resultType: "complete", supportedVersions: [MCP_PROTOCOL_VERSION], capabilities: { tools: {} },
      _meta: { [META_SERVER_INFO]: serverInfo }, instructions: DISCOVER_INSTRUCTIONS, ttlMs: DISCOVER_TTL_MS, cacheScope: "private",
    });
    expect(DISCOVER_TTL_MS).toBe(3_600_000); expect(TOOLS_TTL_MS).toBe(60_000);
  });
  it("tools/list: exposed names <server>__<tool> sorted, [server]-prefixed descriptions, inputSchema/annotations verbatim, ttlMs, cacheScope, resultType, no nextCursor", async () => {
    const f = await start();
    const r = await mcpCall(f.url, KEY, "tools/list");
    expect(r).toEqual({
      resultType: "complete", ttlMs: TOOLS_TTL_MS, cacheScope: "private", _meta: { [META_SERVER_INFO]: serverInfo },
      tools: [
        { name: "demo__echo", description: "[demo] echoes", inputSchema: { type: "object", properties: { message: { type: "string" } } }, annotations: { readOnlyHint: true } },
        { name: "demo__wipe", description: "[demo] wipes nothing", inputSchema: { type: "object" } },
        { name: "other__a.b-c_D", description: "[other]", inputSchema: { type: "object" } },
      ],
    });
    expect(Object.hasOwn(r, "nextCursor")).toBe(false);
    expect(await mcpCall(f.url, KEY, "tools/list")).toEqual(r); // deterministic
  });
  it("tools/call: the handler gets IncomingCall { callId uuid, credential api_key = bearer, raw server/tool, args, receivedAt }; the response carries resultType/content/isError/_meta and never the key", async () => {
    const f = await start();
    const r = await mcpPost({ url: f.url, token: KEY, id: "req-9", method: "tools/call", params: { name: "demo__echo", arguments: { message: "hi", n: 2 } } });
    expect(r.status).toBe(200);
    expect(rpc(r).id).toBe("req-9");
    expect(rpc(r).result).toEqual({ resultType: "complete", content: [{ type: "text", text: 'ran demo/echo {"message":"hi","n":2}' }], isError: false, _meta: { [META_SERVER_INFO]: serverInfo } });
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c.callId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(c.credential).toEqual({ kind: "api_key", value: KEY });
    expect([c.server, c.tool, c.args]).toEqual(["demo", "echo", { message: "hi", n: 2 }]);
    expect(Number.isFinite(Date.parse(c.receivedAt))).toBe(true);
    expect(c.agentSessionId).toBeUndefined(); expect(c.onBehalfOf).toBeUndefined();
    expect(Object.keys(c).sort()).toEqual(["args", "callId", "credential", "receivedAt", "server", "tool"]);
    expect(r.text).not.toContain(KEY);
    const second = await mcpCall(f.url, KEY, "tools/call", { name: "other__a.b-c_D" });
    expect(f.calls[1]!.args).toEqual({}); expect(f.calls[1]!.callId).not.toBe(c.callId);
    expect(toolText(second)).toBe("ran other/a.b-c_D {}");
  });
  it("an isError ToolResult is passed through; a handler throw → 500 -32603 'internal error' without the exception text", async () => {
    const denied = await start({ result: { content: [{ type: "text", text: "agent-ledger: denied (risky; registry:demo/wipe): no channel" }], isError: true } });
    const r = await mcpCall(denied.url, KEY, "tools/call", { name: "demo__wipe", arguments: { target: "prod" } });
    expect(r["isError"]).toBe(true); expect(toolText(r)).toContain("denied (risky; registry:demo/wipe)");
    const boom = await start({ result: new Error("stack-canary-leak") });
    const e = await mcpPost({ url: boom.url, token: KEY, method: "tools/call", params: { name: "demo__echo", arguments: {} } });
    expect(e.status).toBe(500); expect(rpc(e).error).toEqual({ code: JSONRPC_INTERNAL_ERROR, message: "internal error" }); expect(e.text).not.toContain("stack-canary-leak");
  });
});

describe("front: exposed-name table (pin 5)", () => {
  it("exposedToolName joins with __; buildExposedTable sorts and keeps server/tool raw", () => {
    expect(exposedToolName("demo", "echo")).toBe("demo__echo");
    const t = buildExposedTable(TOOLS);
    expect([...t.keys()]).toEqual(["demo__echo", "demo__wipe", "other__a.b-c_D"]);
    expect(t.get("demo__echo")).toMatchObject({ server: "demo", tool: "echo" });
  });
  it("refuses to start on a collision (a__b/c vs a/b__c: the __ ambiguity ADR-006 showed), on a name over 128 characters, on a bad character, on a malformed ToolInfo", async () => {
    const h = async () => ({ content: [], isError: false });
    const collide: ToolInfo[] = [{ server: "a__b", name: "c" }, { server: "a", name: "b__c" }];
    expect(() => buildExposedTable(collide)).toThrow(/collision: a__b\/c and a\/b__c both map to a__b__c/);
    await expect(startFront(h, { mode: "http", port: 0, allowedOrigins: [], tools: async () => collide })).rejects.toThrow(/collision/);
    expect(() => buildExposedTable([{ server: "s".repeat(64), name: "t".repeat(64) }])).toThrow(/not 1-128 characters/);
    expect(() => buildExposedTable([{ server: "ok", name: "has space" }])).toThrow(/not 1-128 characters/);
    expect(() => buildExposedTable([{ server: "ok" } as ToolInfo])).toThrow(/malformed ToolInfo/);
    expect(() => buildExposedTable("nope" as never)).toThrow(/must resolve to an array/);
    expect(buildExposedTable([{ server: "s".repeat(60), name: "t".repeat(66) }]).size).toBe(1); // exactly 128
  });
  it("naming 'tool' (the demo upstream's single-server mode) exposes raw names and still refuses a cross-server collision; the default stays server__tool", async () => {
    const raw = buildExposedTable(TOOLS, "tool");
    expect([...raw.keys()]).toEqual(["a.b-c_D", "echo", "wipe"]);
    expect(raw.get("echo")).toMatchObject({ server: "demo", tool: "echo" });
    expect(() => buildExposedTable([{ server: "a", name: "search" }, { server: "b", name: "search" }], "tool")).toThrow(/collision: a\/search and b\/search both map to search/);
    expect(() => buildExposedTable(TOOLS, "raw" as never)).toThrow(/naming must be/);
    const calls: IncomingCall[] = [];
    const front = await startFront(async (c) => { calls.push(c); return { content: [], isError: false }; }, { mode: "http", port: 0, allowedOrigins: [], naming: "tool", tools: async () => TOOLS });
    running.push(front);
    const url = `http://127.0.0.1:${front.port}${MCP_ENDPOINT_PATH}`;
    expect(((await mcpCall(url, KEY, "tools/list"))["tools"] as { name: string }[]).map((t) => t.name)).toEqual(["a.b-c_D", "echo", "wipe"]);
    await mcpCall(url, KEY, "tools/call", { name: "echo", arguments: { message: "x" } });
    expect(calls[0]).toMatchObject({ server: "demo", tool: "echo" });
    const r = await mcpPost({ url, token: KEY, method: "tools/call", params: { name: "demo__echo", arguments: {} } });
    expect(r.status).toBe(400); expect(rpc(r).error!.message).toBe("Unknown tool: demo__echo");
  });
  it("decodeSentinel: literal values pass through; =?base64?…?= is decoded; a broken sentinel is undefined", () => {
    expect(decodeSentinel("demo__echo")).toBe("demo__echo");
    expect(decodeSentinel("=?base64?SGVsbG8sIOS4lueVjA==?=")).toBe("Hello, 世界");
    expect(decodeSentinel("=?base64?literal!?=")).toBe("=?base64?literal!?="); // not the sentinel grammar: literal
  });
});
