import { readFileSync } from 'node:fs';
import { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as front from '../src/front/contract.js';
import { inprocRequest, openInprocRequest, frontFetch } from './helpers/inproc-http.js';
import { connectUpstreams } from '../src/upstream/contract.js';
import type { CallHandler, IncomingCall } from '../src/types/index.js';
const auth = { authorization: 'Bearer agent-one' };
const tools = [{ server: 'demo', name: 'echo', inputSchema: { type: 'object', properties: { message: { type: 'string', 'x-mcp-header': 'Message' } } } }];
let server: ReturnType<typeof front.createFrontServer>; let handler: ReturnType<typeof vi.fn<CallHandler>>;
const rpc = (method: string, params: unknown = {}, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, params });
const modern = (method: string, params: Record<string, unknown> = {}) => ({ headers: { ...auth, 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}) }, body: rpc(method, { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } }) });
async function initialize(version = '2025-11-25') { return inprocRequest(server, { headers: auth, body: rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } }) }); }
const sessionRequest = (id: string, method: string, params: Record<string, unknown> = {}, version: string | undefined = '2025-11-25') => inprocRequest(server, { headers: { ...auth, 'mcp-session-id': id, ...(version ? { 'mcp-protocol-version': version } : {}) }, body: rpc(method, params) });
beforeEach(() => { handler = vi.fn(async (_call: IncomingCall) => ({ content: [{ type: 'text', text: 'ok' }], isError: false })); server = front.createFrontServer(handler, { mode: 'http', allowedOrigins: [], tools: async () => tools }); });
afterEach(() => { server.close(); server.closeAllConnections(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('legacy and modern front on one endpoint', () => {
  it.each(['2025-11-25','2025-06-18','2025-03-26','2024-11-05'])('negotiates %s with a CSPRNG session', async version => {
    const r = await initialize(version); expect(r.status).toBe(200); expect(r.headers.get('mcp-session-id')).toMatch(/^[\x21-\x7e]{1,256}$/);
    expect(r.body.result).toMatchObject({ protocolVersion: version === '2024-11-05' ? '2025-11-25' : version, capabilities: { tools: {} }, serverInfo: { name: front.SERVER_NAME }, instructions: front.DISCOVER_INSTRUCTIONS });
  });
  it('interleaves both eras and passes the same identity, tool lookup and fresh call ids to the handler', async () => {
    const init = await initialize(), sid = init.headers.get('mcp-session-id')!;
    const list = await sessionRequest(sid, 'tools/list'); expect(Object.keys(list.body.result)).toEqual(['tools']); expect(list.body.result.tools[0].name).toBe('demo__echo');
    const legacy = await sessionRequest(sid, 'tools/call', { name: 'demo__echo', arguments: { message: 'hello' } });
    expect(legacy.body.result).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false }); expect(legacy.headers.has('mcp-session-id')).toBe(false);
    const m = modern('tools/call', { name: 'demo__echo', arguments: {} }); expect((await inprocRequest(server, m)).body.result.resultType).toBe('complete');
    expect(handler).toHaveBeenCalledTimes(2); const [one,two] = handler.mock.calls.map(c => c[0]);
    expect(one).toMatchObject({ credential: { kind: 'api_key', value: 'agent-one' }, server: 'demo', tool: 'echo', args: { message: 'hello' } }); expect(one!.callId).not.toBe(two!.callId); expect(JSON.stringify(one)).not.toContain(sid);
  });
  it('binds sessions to bearer hashes and never echoes unknown or foreign ids', async () => {
    const sid = (await initialize()).headers.get('mcp-session-id')!;
    const foreign = await inprocRequest(server, { headers: { authorization: 'Bearer agent-two', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' }, body: rpc('tools/list') });
    expect(foreign.status).toBe(404); expect(foreign.text).not.toContain(sid); expect(foreign.headers.has('mcp-session-id')).toBe(false);
    expect((await sessionRequest('unknown-session', 'tools/list')).status).toBe(404);
  });
  it.each(['2026-07-28','wrong',''])('rejects version %j for a newer legacy session', async version => {
    const sid = (await initialize()).headers.get('mcp-session-id')!; const r = await sessionRequest(sid, 'tools/list', {}, version); expect(r.status).toBe(400); expect(r.body.error.code).toBe(-32600);
  });
  it('assumes absent protocol version only for a 2025-03-26 session', async () => {
    const sid = (await initialize('2025-03-26')).headers.get('mcp-session-id')!; expect((await sessionRequest(sid, 'ping', {}, '')).body.result).toEqual({});
  });
  it('accepts initialized notifications and refuses unknown legacy methods', async () => {
    const sid = (await initialize()).headers.get('mcp-session-id')!;
    expect((await inprocRequest(server, { headers: { ...auth, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status).toBe(202);
    expect((await sessionRequest(sid, 'other')).body.error.code).toBe(-32601);
  });
  it('deletes only an owned session; GET and other DELETEs return 405', async () => {
    const sid = (await initialize()).headers.get('mcp-session-id')!;
    expect((await inprocRequest(server, { method: 'DELETE', headers: { authorization: 'Bearer other', 'mcp-session-id': sid } })).status).toBe(405);
    expect((await sessionRequest(sid, 'ping')).status).toBe(200);
    expect((await inprocRequest(server, { method: 'DELETE', headers: { ...auth, 'mcp-session-id': sid } })).status).toBe(204);
    expect((await sessionRequest(sid, 'ping')).status).toBe(404);
    expect((await inprocRequest(server, { method: 'GET', headers: auth })).status).toBe(405);
    expect((await inprocRequest(server, { method: 'DELETE', headers: auth })).status).toBe(405);
  });
  it('expires idle sessions and frees their capacity', async () => {
    const clock = vi.spyOn(Date, 'now'); clock.mockReturnValue(1000); const sid = (await initialize()).headers.get('mcp-session-id')!;
    clock.mockReturnValue(1000 + front.FRONT_LEGACY_SESSION_IDLE_MS); expect((await sessionRequest(sid, 'ping')).status).toBe(404);
    expect((await initialize()).status).toBe(200);
  });
  it('bounds live sessions and returns overload without minting another id', async () => {
    for (let n = 0; n < front.FRONT_MAX_LEGACY_SESSIONS; n++) expect((await initialize()).status).toBe(200);
    const r = await initialize(); expect(r.status).toBe(503); expect(r.body.error.code).toBe(-30503); expect(r.headers.has('mcp-session-id')).toBe(false);
  });
  it.each([{ protocolVersion: 1, capabilities: {} }, { protocolVersion: '2025-11-25', capabilities: [] }, {}])('rejects malformed initialization params %j', async params => {
    expect((await inprocRequest(server, { headers: auth, body: rpc('initialize', params) })).body.error.code).toBe(-32602);
  });
  it('keeps modern initialize and modern validation unchanged', async () => {
    const r = await inprocRequest(server, modern('initialize')); expect(r.status).toBe(404); expect(r.body.error.message).toContain(front.INITIALIZE_MESSAGE);
    expect((await inprocRequest(server, { headers: auth, body: rpc('tools/list') })).body.error.code).toBe(-32020);
  });
  it('checks origins, bearer, body size and JSON-RPC before legacy semantics', async () => {
    const body = rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
    expect((await inprocRequest(server, { headers: { ...auth, origin: 'https://evil.example' }, body })).status).toBe(403);
    expect((await inprocRequest(server, { body })).status).toBe(401);
    expect((await inprocRequest(server, { headers: auth, raw: '{' })).body.error.code).toBe(-32700);
    expect((await inprocRequest(server, { headers: auth, body: { ...body, id: null } })).body.error.code).toBe(-32600);
  });
  it('refuses unknown tools and malformed arguments without calling the handler', async () => {
    const sid = (await initialize()).headers.get('mcp-session-id')!;
    for (const params of [{ name: 'unknown' }, { name: 'demo__echo', arguments: [] }]) expect((await sessionRequest(sid, 'tools/call', params)).body.error.code).toBe(-32602);
    expect(handler).not.toHaveBeenCalled();
  });
  it('bridges our legacy upstream client through the actual front parser to the demo handler', async () => {
    vi.stubGlobal('fetch', frontFetch(server, true));
    const up = await connectUpstreams([{ name: 'proxy', transport: 'http', url: 'http://inproc/mcp' }], { get: async () => ({ bearerToken: 'agent-one' }) });
    try { expect(up.eras).toEqual({ proxy: 'legacy' }); expect((await up.execute({ callId: 'outer', agentId: 'a', sessionId: 's', server: 'proxy', tool: 'demo__echo', args: { message: 'hello' }, receivedAt: new Date().toISOString() })).isError).toBe(false); expect(handler).toHaveBeenCalledOnce(); }
    finally { await up.close(); }
  });
});
describe('TLS and front P2s', () => {
  it('round-trips a leading BOM in a header sentinel', () => { const value = '\uFEFFhello'; expect(front.decodeSentinel(`=?base64?${Buffer.from(value).toString('base64')}?=`)).toBe(value); });
  it.each(['default','example','examples','const','enum'])('ignores annotation-like data in %s', key => { expect(front.buildExposedTable([{ server: 'demo', name: 'data', inputSchema: { [key]: { 'x-mcp-header': 'data' } } }]).size).toBe(1); });
  it('serves HTTPS over duplexPair with TLS >= 1.2 and the same health and MCP routes', async () => {
    server.close(); const cert = readFileSync(new URL('./fixtures/tls/test-cert.pem', import.meta.url)), key = readFileSync(new URL('./fixtures/tls/test-key.pem', import.meta.url));
    server = front.createFrontServer(handler, { mode: 'http', allowedOrigins: [], tools: async () => tools, tls: { cert, key } });
    const health = openInprocRequest(server, { method: 'GET', path: '/healthz', tls: { ca: cert } }); expect((await health.response).body).toEqual({ ok: true }); expect(health.protocol).toMatch(/^TLSv1\.[23]$/);
    const r = await inprocRequest(server, { ...modern('tools/list'), tls: { ca: cert, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' } }); expect(r.status).toBe(200);
  });
});

describe('front admission and shutdown', () => {
  const turn = () => new Promise<void>(resolve => setImmediate(resolve));
  it('shares admission between eras and releases a disconnected client slot before its handler finishes', async () => {
    server.close(); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    handler.mockImplementationOnce(async () => { await gate; return { content: [], isError: false }; });
    server = front.createFrontServer(handler, { mode: 'http', allowedOrigins: [], tools: async () => tools, maxInFlight: 1 });
    const sid = (await initialize()).headers.get('mcp-session-id')!;
    const request = openInprocRequest(server, modern('tools/call', { name: 'demo__echo' }));
    const disconnected = request.response.catch(() => undefined); await turn(); expect(handler).toHaveBeenCalledOnce();
    expect((await sessionRequest(sid, 'tools/call', { name: 'demo__echo' })).status).toBe(503);
    request.disconnect(); await turn();
    expect((await sessionRequest(sid, 'tools/call', { name: 'demo__echo' })).status).toBe(200); expect(handler).toHaveBeenCalledTimes(2);
    release(); await turn(); await disconnected;
  });
  it('startFront uses the factory, and stop rejects new requests with 503 while draining the admitted handler', async () => {
    server.close(); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function(this: Server, ...args: unknown[]) {
      server = this; const callback = args.at(-1); if (typeof callback === 'function') queueMicrotask(() => callback()); return this;
    } as Server['listen']);
    handler.mockImplementationOnce(async () => { await gate; return { content: [], isError: false }; });
    const running = await front.startFront(handler, { mode: 'http', port: 0, allowedOrigins: [], tools: async () => tools });
    expect(listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function));
    const request = inprocRequest(server, modern('tools/call', { name: 'demo__echo' })); await turn();
    const stopped = running.stop();
    expect((await inprocRequest(server, modern('tools/call', { name: 'demo__echo' }))).body.error.code).toBe(-30503);
    expect((await inprocRequest(server, { method: 'GET', path: '/healthz' })).status).toBe(503);
    expect(handler).toHaveBeenCalledOnce(); release(); expect((await request).status).toBe(200); await stopped;
  });
  it('handles failed and malformed handler results with a generic error and frees capacity', async () => {
    const sid = (await initialize()).headers.get('mcp-session-id')!;
    handler.mockRejectedValueOnce(new Error('private detail')).mockResolvedValueOnce({ content: {} as never, isError: false });
    for (let n = 0; n < 2; n++) { const r = await sessionRequest(sid, 'tools/call', { name: 'demo__echo' }); expect(r.status).toBe(500); expect(r.text).not.toContain('private detail'); }
    expect((await sessionRequest(sid, 'tools/call', { name: 'demo__echo' })).status).toBe(200);
  });
  it('keeps modern parameter header checks, including a BOM value, through the real parser', async () => {
    const value = '\uFEFFhello'; const req = modern('tools/call', { name: 'demo__echo', arguments: { message: value } });
    expect((await inprocRequest(server, req)).body.error.code).toBe(-32020);
    expect((await inprocRequest(server, { ...req, headers: { ...req.headers, 'mcp-param-message': `=?base64?${Buffer.from(value).toString('base64')}?=` } })).status).toBe(200);
    expect(handler.mock.calls[0]![0].args.message).toBe(value);
  });
  it('updates the idle clock only for the owning bearer and reclaims capacity after expiry', async () => {
    const clock = vi.spyOn(Date, 'now'); clock.mockReturnValue(0); const sid = (await initialize()).headers.get('mcp-session-id')!;
    clock.mockReturnValue(front.FRONT_LEGACY_SESSION_IDLE_MS - 1); expect((await sessionRequest(sid, 'ping')).status).toBe(200);
    clock.mockReturnValue(front.FRONT_LEGACY_SESSION_IDLE_MS + 1); expect((await sessionRequest(sid, 'ping')).status).toBe(200);
    clock.mockReturnValue(2 * front.FRONT_LEGACY_SESSION_IDLE_MS);
    expect((await inprocRequest(server, { headers: { authorization: 'Bearer stranger', 'mcp-session-id': sid }, body: rpc('ping') })).status).toBe(404);
    clock.mockReturnValue(2 * front.FRONT_LEGACY_SESSION_IDLE_MS + 1); expect((await sessionRequest(sid, 'ping')).status).toBe(404);
  });
  it('does not mint a legacy session when modern metadata is present without its header', async () => {
    const r = await inprocRequest(server, { headers: auth, body: rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }) });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe(-32020); expect(r.headers.has('mcp-session-id')).toBe(false);
  });
});

describe('front transport boundary regressions', () => {
  it.each([
    { raw: '[]', code: -32600 },
    { body: { jsonrpc: '1.0', method: 'initialize', id: 1 }, code: -32600 },
    { body: { jsonrpc: '2.0', method: 'initialize', id: 1.5 }, code: -32600 },
    { body: { jsonrpc: '2.0', method: 'initialize', id: 1, params: [] }, code: -32600 },
  ])('rejects malformed legacy framing before creating a session: %j', async ({ code, ...request }) => {
    const r = await inprocRequest(server, { ...request, headers: auth }); expect(r.status).toBe(400); expect(r.body.error.code).toBe(code); expect(r.headers.has('mcp-session-id')).toBe(false);
  });
  it('enforces content type and body cap before legacy initialization', async () => {
    expect((await inprocRequest(server, { headers: { ...auth, 'content-type': 'text/plain' }, body: rpc('initialize') })).status).toBe(415);
    const r = await inprocRequest(server, { headers: auth, raw: 'x'.repeat(front.MAX_BODY_BYTES + 1) }); expect(r.status).toBe(413); expect(handler).not.toHaveBeenCalled();
  });
  it('ignores Last-Event-ID and keeps modern list metadata and schema details intact', async () => {
    const request = modern('tools/list'); const r = await inprocRequest(server, { ...request, headers: { ...request.headers, 'last-event-id': 'ignored' } });
    expect(r.body.result).toMatchObject({ resultType: 'complete', ttlMs: front.TOOLS_TTL_MS, cacheScope: 'private', tools: [{ name: 'demo__echo', description: '[demo]', inputSchema: tools[0]!.inputSchema }] });
    expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.has('mcp-session-id')).toBe(false);
  });
  it('validates the exposed table before startFront can listen', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen');
    await expect(front.startFront(handler, { mode: 'http', allowedOrigins: [], tools: async () => [{ server: 'a__b', name: 'c' }, { server: 'a', name: 'b__c' }] })).rejects.toThrow('collision');
    expect(listen).not.toHaveBeenCalled();
  });
  it('uses TLSv1.2 as the configured minimum and refuses invalid TLS material before listening', () => {
    server.close(); const cert = readFileSync(new URL('./fixtures/tls/test-cert.pem', import.meta.url)), key = readFileSync(new URL('./fixtures/tls/test-key.pem', import.meta.url));
    server = front.createFrontServer(handler, { mode: 'http', allowedOrigins: [], tools: async () => [], tls: { cert, key } });
    expect((server as unknown as { minVersion: string }).minVersion).toBe('TLSv1.2');
    expect(() => front.createFrontServer(handler, { mode: 'http', allowedOrigins: [], tools: async () => [], tls: { cert: Buffer.from('bad'), key } })).toThrow();
  });
});
