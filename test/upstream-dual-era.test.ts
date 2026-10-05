import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyUpstream } from './helpers/legacy-upstream.js';
import { frontFetch } from './helpers/inproc-http.js';
import { FakeMcpFetch } from './helpers/fake-mcp-fetch.js';
import { connectUpstreams, headerParams, SseParser, type Upstream } from '../src/upstream/contract.js';
import type { ToolCall } from '../src/types/index.js';
let fake: FakeMcpFetch; const clients: Upstream[] = [];
const config = [{ name: 'demo', transport: 'http' as const, url: 'https://demo.example/mcp' }];
const secrets = { get: async () => ({ bearerToken: 'upstream-secret' }) };
const call: ToolCall = { callId: 'c', sessionId: 's', agentId: 'a', server: 'demo', tool: 'echo', args: {}, receivedAt: new Date(0).toISOString() };
const connect = async () => { const up = await connectUpstreams(config, secrets); clients.push(up); return up; };
beforeEach(() => { fake = new FakeMcpFetch(); vi.stubGlobal('fetch', fake.fetch); });
afterEach(async () => { for (const c of clients.splice(0)) await c.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('dual-era upstream client', () => {
  it.each([false, true])('initializes legacy once, paginates and executes over SSE=%s without modern metadata', async sse => {
    fake.sse = sse; fake.pages.push([{ name: 'other' }]); const up = await connect();
    expect((await up.listTools()).map(t => t.name)).toEqual(['echo', 'other']); expect((await up.execute(call)).isError).toBe(false);
    const initialize = fake.seen.find(r => r.body.method === 'initialize')!;
    expect(initialize.body.params).toMatchObject({ protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-ledger-proxy' } });
    expect(initialize.headers.has('mcp-protocol-version')).toBe(false);
    for (const r of fake.seen.slice(1)) { expect(r.body.params?._meta).toBeUndefined(); expect(r.headers.has('mcp-method')).toBe(false); expect(r.headers.has('mcp-name')).toBe(false); expect(r.headers.get('authorization')).toBe('Bearer upstream-secret'); }
    for (const r of fake.seen.slice(2)) { expect(r.headers.get('mcp-session-id')).toBe('session-1'); expect(r.headers.get('mcp-protocol-version')).toBe('2025-11-25'); }
    expect(fake.seen.filter(r => r.body.method === 'initialize')).toHaveLength(1);
  });
  it('retains modern framing and detects each upstream independently', async () => {
    fake.era = 'modern'; const up = await connect(); await up.execute(call);
    expect(fake.seen.map(r => r.body.method)).toEqual(['server/discover', 'tools/list', 'tools/call']);
    expect(fake.seen.at(-1)!.headers.get('mcp-name')).toBe('echo'); expect(fake.seen.at(-1)!.body.params._meta).toBeDefined();
  });
  it.each([400,404,405])('falls back on non-modern HTTP %s', async status => {
    fake.script = r => r.body.method === 'server/discover' ? new Response('not json', { status }) : undefined;
    await connect(); expect(fake.seen.some(r => r.body.method === 'initialize')).toBe(true);
  });
  it.each([-32020,-32021,-32022])('refuses modern error %s without downgrade or reflected data', async code => {
    fake.script = r => r.body.method === 'server/discover' ? Response.json({ jsonrpc: '2.0', id: r.body.id, error: { code, message: 'upstream-secret' } }, { status: 400 }) : undefined;
    await expect(connect()).rejects.toThrow(String(code)); expect(fake.seen).toHaveLength(1);
  });
  it.each([401,403])('never downgrades on HTTP %s', async status => {
    fake.script = () => new Response('upstream-secret', { status }); await expect(connect()).rejects.toThrow(`HTTP ${status}`); expect(fake.seen).toHaveLength(1);
  });
  it.each([500,502,503])('classifies HTTP %s startup failures as UpstreamUnavailable', async status => {
    fake.script = () => new Response('upstream-secret', { status }); await expect(connect()).rejects.toMatchObject({ name: 'UpstreamUnavailable' }); expect(fake.seen).toHaveLength(1);
  });
  it('classifies network failure as unavailable with no exception text', async () => {
    fake.script = () => { throw Error('upstream-secret'); }; await expect(connect()).rejects.toMatchObject({ name: 'UpstreamUnavailable' });
  });
  it.each(['2025-11-25','2025-06-18','2025-03-26'])('accepts negotiated version %s', async version => {
    fake.version = version; await connect(); expect(fake.seen.at(-1)!.headers.get('mcp-protocol-version')).toBe(version);
  });
  it('refuses HTTP+SSE revision without a GET and best-effort deletes the assigned session', async () => {
    fake.version = '2024-11-05'; await expect(connect()).rejects.toThrow(); expect(fake.seen.at(-1)?.method).toBe('DELETE'); expect(fake.seen.some(r => r.method === 'GET')).toBe(false);
  });
  it('supports an optional session header and does not mirror valid legacy x-mcp-header annotations', async () => {
    fake.sessionHeader = null; fake.script = r => r.body.method === 'server/discover' ? new Response(null, { status: 400 }) : undefined;
    fake.pages = [[{ name: 'echo', inputSchema: { properties: { x: { type: 'string', 'x-mcp-header': 'X' } } } }]];
    const up = await connect(); expect(await up.listTools()).toHaveLength(1); await up.execute({ ...call, args: { x: {} } }); expect(fake.seen.at(-1)!.headers.has('mcp-session-id')).toBe(false);
  });
  it.each(['', 'has space', 'a'.repeat(257)])('rejects invalid session header %j', async session => {
    fake.script = r => r.body.method === 'initialize' ? fake.ok(r, { protocolVersion: '2025-11-25' }, { 'mcp-session-id': session }) : undefined;
    await expect(connect()).rejects.toThrow();
  });
  it('reinitializes once single-flight for concurrent requests to an expired session', async () => {
    const up = await connect(); fake.sessions.clear(); expect(await Promise.all([up.execute(call), up.execute(call)])).toHaveLength(2);
    expect(fake.seen.filter(r => r.body.method === 'initialize')).toHaveLength(2);
    expect(fake.seen.filter(r => r.body.method === 'tools/call' && r.headers.get('mcp-session-id') === 'session-2')).toHaveLength(2);
  });
  it('throws after a second session 404', async () => {
    const up = await connect(); fake.script = r => r.body.method === 'tools/call' ? new Response(null, { status: 404 }) : undefined;
    await expect(up.execute(call)).rejects.toThrow(); expect(fake.seen.filter(r => r.body.method === 'initialize')).toHaveLength(2);
  });
  it('refuses a server-to-client request on an SSE stream instead of waiting', async () => {
    const up = await connect(); fake.script = r => r.body.method === 'tools/call' ? new Response('data: {"jsonrpc":"2.0","method":"sampling/createMessage","id":99}\n\n', { headers: { 'content-type': 'text/event-stream' } }) : undefined;
    await expect(up.execute(call)).rejects.toThrow('upstream sent a server-to-client request; not supported');
  });
  it('deletes the session on close, tolerates 405, and refuses later execution', async () => {
    const up = await connect(); fake.script = r => r.method === 'DELETE' ? new Response(null, { status: 405 }) : undefined;
    await up.close(); expect(fake.seen.at(-1)!.headers.get('mcp-session-id')).toBe('session-1'); expect(fake.seen.at(-1)!.method).toBe('DELETE'); await expect(up.execute(call)).rejects.toMatchObject({ name: 'UpstreamClosed' });
  });
});
describe('verification P2 regressions', () => {
  it('dispatches a terminal CR-only SSE event immediately, without another byte or EOF', () => {
    const p = new SseParser(); expect(p.push(Buffer.from('data: {"id":1,"result":{}}\r\r'))).toEqual([{ id: 1, result: {} }]);
  });
  it('swallows LF after CR across chunks without introducing empty lines', () => {
    const p = new SseParser(); expect(p.push(Buffer.from('data: {"id":1,\r'))).toEqual([]);
    expect(p.push(Buffer.from('\ndata: "result":{}}\r'))).toEqual([]); expect(p.push(Buffer.from('\n\r'))).toEqual([{ id: 1, result: {} }]); expect(p.push(Buffer.from('\n'))).toEqual([]);
  });
  it.each(['default','example','examples','const','enum'])('does not traverse annotation-like data in %s', keyword => {
    expect(headerParams({ type: 'object', [keyword]: { 'x-mcp-header': 'not schema' } })).toEqual([]);
  });
  it('still refuses annotations on schemas outside properties chains', () => {
    expect(() => headerParams({ allOf: [{ properties: { x: { type: 'string', 'x-mcp-header': 'X' } } }] })).toThrow();
  });
});

describe('upstream failure boundaries', () => {
  it('reports frozen per-upstream eras, including mixed modern and legacy origins', async () => {
    const modern = new FakeMcpFetch(); modern.era = 'modern';
    vi.stubGlobal('fetch', ((url: string | URL | Request, init?: RequestInit) => String(url).includes('modern.example') ? modern.fetch(url, init) : fake.fetch(url, init)) as typeof fetch);
    const up = await connectUpstreams([...config, { name: 'modern', transport: 'http', url: 'https://modern.example/mcp' }], secrets); clients.push(up);
    expect(up.eras).toEqual({ demo: 'legacy', modern: 'modern' }); expect(Object.isFrozen(up.eras)).toBe(true);
  });
  it.each([404,405,422])('does not downgrade modern protocol errors on status %s', async status => {
    fake.script = r => Response.json({ jsonrpc: '2.0', id: r.body.id, error: { code: -32022, message: 'upstream-secret' } }, { status });
    await expect(connect()).rejects.toThrow('-32022'); expect(fake.seen).toHaveLength(1);
  });
  it('converts a discovery timeout to UpstreamUnavailable for root retry', async () => {
    vi.useFakeTimers();
    fake.script = r => new Promise<Response>((_, reject) => r.signal?.addEventListener('abort', () => reject(r.signal?.reason)));
    const p = expect(connect()).rejects.toMatchObject({ name: 'UpstreamUnavailable' }); await vi.advanceTimersByTimeAsync(30_000); await p;
  });
  it('retains UpstreamTimeout for execution, and close aborts an in-flight legacy call before DELETE', async () => {
    const up = await connect(); vi.useFakeTimers();
    fake.script = r => r.body.method === 'tools/call' ? new Promise<Response>((_, reject) => r.signal?.addEventListener('abort', () => reject(r.signal?.reason))) : undefined;
    const timeout = expect(up.execute(call)).rejects.toMatchObject({ name: 'UpstreamTimeout' }); await vi.advanceTimersByTimeAsync(30_000); await timeout;
    const closed = expect(up.execute(call)).rejects.toMatchObject({ name: 'UpstreamClosed' }); await Promise.resolve(); await up.close(); await closed;
    expect(fake.seen.at(-1)?.method).toBe('DELETE');
  });
  it('bounds a stalled best-effort DELETE to two seconds', async () => {
    const up = await connect(); vi.useFakeTimers(); fake.script = r => r.method === 'DELETE' ? new Promise(() => {}) : undefined;
    const p = up.close(); await vi.advanceTimersByTimeAsync(2000); await p; expect(fake.seen.at(-1)!.signal?.aborted).toBe(true);
  });
  it.each([400,401,500])('rejects failed initialized notification HTTP %s', async status => {
    fake.script = r => r.body.method === 'notifications/initialized' ? new Response(null, { status }) : undefined;
    await expect(connect()).rejects.toThrow(); expect(fake.seen.some(r => r.method === 'DELETE')).toBe(true);
  });
  it.each([200,202,204])('accepts initialized notification HTTP %s without parsing a body', async status => {
    fake.script = r => r.body.method === 'notifications/initialized' ? new Response(null, { status }) : undefined;
    await connect(); expect(fake.seen.find(r => r.body.method === 'notifications/initialized')!.body.id).toBeUndefined();
  });
  it.each([
    { content: 'wrong' }, { content: [{ type: 'text' }] }, { content: [], isError: 'false' }, { content: [], resultType: 'other' },
  ])('refuses malformed legacy tool result %j', async result => {
    const up = await connect(); fake.script = r => r.body.method === 'tools/call' ? fake.ok(r, result) : undefined; await expect(up.execute(call)).rejects.toMatchObject({ name: 'UpstreamError' });
  });
  it.each([{ page: [{ name: 'bad name' }] }, { page: [{ name: 'same' }, { name: 'same' }] }])('refuses invalid or duplicate legacy tool names', async ({ page }) => {
    fake.pages = [page]; await expect(connect()).rejects.toThrow(); expect(fake.seen.at(-1)?.method).toBe('DELETE');
  });
  it('does not reinterpret a 200 malformed discovery as legacy', async () => {
    fake.script = r => r.body.method === 'server/discover' ? fake.ok(r, { supportedVersions: ['2025-11-25'] }) : undefined;
    await expect(connect()).rejects.toThrow('does not support'); expect(fake.seen).toHaveLength(1);
  });
  it('enforces the response cap and rejects a server request in JSON too', async () => {
    const up = await connect();
    fake.script = r => r.body.method === 'tools/call' ? new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024 * 1024 + 1) } }) : undefined;
    await expect(up.execute(call)).rejects.toThrow('exceeds');
    fake.script = r => r.body.method === 'tools/call' ? Response.json({ jsonrpc: '2.0', id: 1, method: 'roots/list' }) : undefined;
    await expect(up.execute(call)).rejects.toThrow('server-to-client request');
  });
  it('completes a terminal CR-only event while the stream stays open', async () => {
    const up = await connect(); let cancelled = false;
    fake.script = r => r.body.method === 'tools/call' ? new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(`data: ${JSON.stringify({ jsonrpc: '2.0', id: r.body.id, result: { content: [], isError: false } })}\r\r`)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } }) : undefined;
    expect(await up.execute(call)).toEqual({ content: [], isError: false }); expect(cancelled).toBe(true);
  });
  it('keeps modern tools with annotation-like data while excluding unreachable real schema annotations', async () => {
    fake.era = 'modern'; fake.pages = [[{ name: 'valid', inputSchema: { default: { 'x-mcp-header': 'data' }, properties: { x: { type: 'string', 'x-mcp-header': 'X' } } } }, { name: 'excluded', inputSchema: { items: { 'x-mcp-header': 'X', type: 'string' } } }]];
    const up = await connect(); expect((await up.listTools()).map(t => t.name)).toEqual(['valid']); expect(up.rejectedTools).toHaveLength(1);
    await up.execute({ ...call, tool: 'valid', args: { x: 'value' } }); expect(fake.seen.at(-1)!.headers.get('mcp-param-x')).toBe('value');
  });
});

describe('coordinator startup refusal regressions', () => {
  it.each([500, 404])('refuses reflected HTTP %s value-free, attempting legacy only for the non-modern 404', async status => {
    fake.script = r => Response.json({ jsonrpc: '2.0', id: r.body.id, error: { code: -32603, message: `saw ${r.headers.get('authorization')}` } }, { status });
    const error = await connect().catch(e => e as Error);
    expect(error).toMatchObject({ name: status === 500 ? 'UpstreamUnavailable' : 'UpstreamError', message: `upstream demo: HTTP ${status} on ${status === 500 ? 'server/discover' : 'initialize'}` });
    expect(fake.seen.map(r => r.body.method)).toEqual(status === 500 ? ['server/discover'] : ['server/discover', 'initialize']);
    expect(String(error)).not.toContain('upstream-secret'); expect(String(error)).not.toContain('saw ');
  });
  it.each(['fetch-aborts', 'fetch-stalls', 'json-stalls', 'sse-stalls', 'cancel-stalls'])('bounds a legacy initialize after reflected 404 when %s', async fault => {
    vi.useFakeTimers();
    let aborted = false;
    fake.script = r => {
      if (r.body.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: r.body.id, error: { code: -32603, message: `saw ${r.headers.get('authorization')}` } }, { status: 404 });
      if (r.body.method !== 'initialize') return undefined;
      r.signal?.addEventListener('abort', () => { aborted = true; });
      if (fault === 'fetch-aborts') return new Promise<Response>((_, reject) => r.signal?.addEventListener('abort', () => reject(r.signal?.reason)));
      if (fault === 'fetch-stalls') return new Promise<Response>(() => {});
      return new Response(new ReadableStream({
        start(c) { if (fault === 'cancel-stalls') { c.enqueue(Buffer.from(`data: ${JSON.stringify({ jsonrpc: '2.0', id: r.body.id, result: { protocolVersion: '2025-11-25' } })}\n\n`)); } },
        cancel() { if (fault === 'cancel-stalls') return new Promise<void>(() => {}); },
      }), { headers: { 'content-type': fault === 'json-stalls' ? 'application/json' : 'text/event-stream' } });
    };
    let outcome: unknown;
    void connect().then(value => { outcome = value; }, error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(29_999); expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toMatchObject({ name: 'UpstreamUnavailable', message: 'upstream demo: no response to initialize within 30000 ms' });
    expect(aborted).toBe(true); expect(String(outcome)).not.toContain('upstream-secret');
    expect(fake.seen.map(r => r.body.method)).toEqual(['server/discover', 'initialize']);
  });
});

it.each(['fetch', 'stream'])('close settles an execution whose %s ignores abort, without waiting for its timeout', async fault => {
  const up = await connect();
  fake.script = r => r.body.method === 'tools/call' ? fault === 'fetch' ? new Promise<Response>(() => {})
    : new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } }) : undefined;
  const p = expect(up.execute(call)).rejects.toMatchObject({ name: 'UpstreamClosed', message: 'upstream: closed' });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await up.close(); await p;
  expect(fake.seen.filter(r => r.body.method === 'tools/call')).toHaveLength(1);
});

describe('Fable review legacy recovery and schema regressions', () => {
  it('P2-2 retries a failed reinitialize on the next call, single-flight across concurrent callers', async () => {
    const up = await connect(); fake.sessions.clear(); let fail = true;
    fake.script = r => fail && r.body.method === 'initialize' ? new Response(null, { status: 503 }) : undefined;
    await expect(up.execute(call)).rejects.toThrow('HTTP 503 on initialize'); fail = false;
    expect((await Promise.all([up.execute(call), up.execute(call), up.execute(call)])).every(r => !r.isError)).toBe(true);
    expect(fake.seen.filter(r => r.body.method === 'initialize')).toHaveLength(3);
    expect(fake.seen.filter(r => r.body.method === 'tools/call').every(r => r.headers.has('mcp-session-id'))).toBe(true);
  });
  it('P2-2 discards a partially initialized session and recovers after its notification fails', async () => {
    const up = await connect(); fake.sessions.clear();
    fake.script = r => r.body.method === 'notifications/initialized' ? new Response(null, { status: 503 }) : undefined;
    await expect(up.execute(call)).rejects.toThrow('HTTP 503 on notifications/initialized');
    expect(fake.seen.at(-1)?.method).toBe('DELETE'); expect(fake.sessions.size).toBe(0);
    fake.script = undefined;
    expect((await up.execute(call)).isError).toBe(false);
    expect(fake.seen.filter(r => r.body.method === 'initialize')).toHaveLength(3);
    expect(fake.seen.at(-1)?.headers.get('mcp-session-id')).toBe('session-3');
  });
  it('P2-3 excludes invalid legacy header annotations before the front builds its table, and does not mirror valid ones', async () => {
    fake.pages = [[{ name: 'valid', inputSchema: { properties: { x: { type: 'string', 'x-mcp-header': 'X' } } } },
      { name: 'invalid', inputSchema: { items: { type: 'string', 'x-mcp-header': 'Item' } } }]];
    const up = await connect(); expect((await up.listTools()).map(t => t.name)).toEqual(['valid']);
    expect(up.rejectedTools).toEqual([{ server: 'demo', tool: 'invalid', reason: expect.stringContaining('not statically reachable') }]);
    const { buildExposedTable } = await import('../src/front/contract.js');
    expect(buildExposedTable(await up.listTools()).size).toBe(1);
    await up.execute({ ...call, tool: 'valid', args: { x: 'value' } }); expect(fake.seen.at(-1)!.headers.has('mcp-param-x')).toBe(false);
  });
  it('P3-4 skips the SDK empty-data priming event before a legacy JSON-RPC response', async () => {
    fake.sse = true;
    const ordinaryFetch = fake.fetch;
    vi.stubGlobal('fetch', (async (...args: Parameters<typeof fetch>) => {
      const response = await ordinaryFetch(...args);
      return response.headers.get('content-type') === 'text/event-stream'
        ? new Response(`id: sdk-prime\ndata: \n\n${await response.text()}`, { status: response.status, headers: response.headers }) : response;
    }) as typeof fetch);
    const up = await connect(); expect((await up.execute(call)).isError).toBe(false);
  });
});


describe('live legacy restart regression', () => {
  it.each([400, 404] as const)('recovers once single-flight after the legacy server forgets sessions (HTTP %s)', async status => {
    const legacy = new LegacyUpstream({ unknownSessionStatus: status, mode: 'alternate' });
    vi.stubGlobal('fetch', frontFetch(legacy.server));
    const up = await connect(); legacy.restart();
    const results = await Promise.all([up.execute(call), up.execute(call)]);
    expect(results.every(r => !r.isError)).toBe(true);
    expect(legacy.log.filter(r => r.method === 'initialize')).toHaveLength(2);
    expect(legacy.log.filter(r => r.method === 'tools/call' && r.status === status)).toHaveLength(2);
    expect(legacy.log.filter(r => r.method === 'tools/call' && r.status === 200)).toHaveLength(2);
    expect(legacy.toolCalls().filter(t => t === 'echo')).toHaveLength(2);
  });
  it('stops after one resend of the exact reference-app 400 without exposing response values', async () => {
    const up = await connect();
    fake.script = r => r.body.method === 'tools/call' ? Response.json({ jsonrpc: '2.0', id: r.body.id,
      error: { code: -32000, message: 'Bad Request: No valid session ID provided', data: 'upstream-secret' } }, { status: 400 }) : undefined;
    await expect(up.execute(call)).rejects.toThrow('HTTP 400 on tools/call');
    expect(fake.seen.filter(r => r.body.method === 'initialize')).toHaveLength(2);
    expect(fake.seen.filter(r => r.body.method === 'tools/call')).toHaveLength(2);
  });
  it.each([
    { code: -32000, message: 'Bad Request: Unsupported protocol version' },
    { code: -32000, message: 'Bad Request: Server not initialized' },
    { code: -32602, message: 'Bad Request: No valid session ID provided' },
    { code: -32000, message: 'Bad Request: No valid session ID provided upstream-secret' },
  ])('does not retry other 400 errors: %j', async error => {
    const up = await connect(); fake.script = r => r.body.method === 'tools/call'
      ? Response.json({ jsonrpc: '2.0', id: r.body.id, error }, { status: 400 }) : undefined;
    await expect(up.execute(call)).rejects.toThrow(/^upstream demo: HTTP 400 on tools\/call$/);
    expect(fake.seen.filter(r => r.body.method === 'initialize')).toHaveLength(1);
    expect(fake.seen.filter(r => r.body.method === 'tools/call')).toHaveLength(1);
  });
  it.each(['bad-id', 'result', 'bad-json'])('does not recover a malformed session-error envelope: %s', async shape => {
    const up = await connect(); fake.script = r => r.body.method === 'tools/call' ? new Response(shape === 'bad-json' ? 'upstream-secret' : JSON.stringify({
      jsonrpc: '2.0', id: shape === 'bad-id' ? 999 : r.body.id,
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, ...(shape === 'result' ? { result: {} } : {}),
    }), { status: 400 }) : undefined;
    await expect(up.execute(call)).rejects.toThrow(/^upstream demo: HTTP 400 on tools\/call$/);
    expect(fake.seen.filter(r => r.body.method === 'initialize')).toHaveLength(1);
  });
});

it('bounds legacy 400 body inspection by the existing response cap and deadline', async () => {
  const up = await connect();
  fake.script = r => r.body.method === 'tools/call' ? new Response('private-value', { status: 400, headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }) : undefined;
  await expect(up.execute(call)).rejects.toThrow('response exceeds');
  vi.useFakeTimers();
  fake.script = r => r.body.method === 'tools/call' ? new Response(new ReadableStream({ start() {}, cancel() {} }), { status: 400 }) : undefined;
  const p = expect(up.execute(call)).rejects.toMatchObject({ name: 'UpstreamTimeout' });
  await vi.advanceTimersByTimeAsync(30_000); await p;
  expect(fake.seen.filter(r => r.body.method === 'initialize')).toHaveLength(1);
});
