/** Fetch boundary fake: no listeners, network or SDK; scripts protocol responses and expiry. */
export interface McpRequest { url: string; method: string; headers: Headers; body: any; signal: AbortSignal | null | undefined; }
export class FakeMcpFetch {
  seen: McpRequest[] = [];
  sessions = new Set<string>();
  serial = 0;
  era: 'modern' | 'legacy' = 'legacy';
  version = '2025-11-25';
  sessionHeader: string | null | undefined;
  sse = false;
  pages: unknown[][] = [[{ name: 'echo', inputSchema: { type: 'object' } }]];
  script: ((r: McpRequest) => Response | Promise<Response> | undefined) | undefined;
  fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const r: McpRequest = { url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : {}, signal: init?.signal };
    this.seen.push(r);
    const scripted = this.script?.(r); if (scripted !== undefined) return scripted;
    const session = r.headers.get('mcp-session-id');
    if (r.method === 'DELETE') { if (session) this.sessions.delete(session); return new Response(null, { status: 204 }); }
    if (this.era === 'modern') {
      if (r.body.method === 'server/discover') return this.ok(r, { supportedVersions: ['2026-07-28'] });
    } else {
      if (r.body.method === 'initialize') {
        const id = this.sessionHeader === undefined ? `session-${++this.serial}` : this.sessionHeader;
        if (id) this.sessions.add(id);
        return this.ok(r, { protocolVersion: this.version, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }, id ? { 'mcp-session-id': id } : {});
      }
      if (session && !this.sessions.has(session)) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Session not found' } }, { status: 404 });
      if (!session && this.sessionHeader !== null) return Response.json({ jsonrpc: '2.0', id: r.body.id ?? null, error: { code: -32000, message: 'no session' } }, { status: 400 });
      if (r.body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    }
    if (r.body.method === 'tools/list') {
      const page = Number(r.body.params?.cursor ?? 0);
      return this.ok(r, { tools: this.pages[page] ?? [], ...(page + 1 < this.pages.length ? { nextCursor: String(page + 1) } : {}) });
    }
    if (r.body.method === 'tools/call') return this.ok(r, { content: [{ type: 'text', text: 'echoed' }], isError: false });
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  ok(r: McpRequest, result: unknown, headers: Record<string, string> = {}) {
    const body = { jsonrpc: '2.0', id: r.body.id, result };
    return this.sse ? new Response(`: comment\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message' })}\r\n\r\ndata: ${JSON.stringify(body)}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream', ...headers } }) : Response.json(body, { headers });
  }
}
