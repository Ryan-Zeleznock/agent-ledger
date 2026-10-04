import { duplexPair, type Duplex } from 'node:stream';
import { connect, type TLSSocket } from 'node:tls';
import type { Server } from 'node:http';
import type { Server as HttpsServer } from 'node:https';

export interface InprocResponse { status: number; headers: Headers; text: string; body: any; }
export interface InprocOptions { method?: string; path?: string; headers?: Record<string, string>; body?: unknown; raw?: string; tls?: { ca: Buffer; servername?: string; minVersion?: 'TLSv1.2' | 'TLSv1.3'; maxVersion?: 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3' }; }
/** Feed the actual Node HTTP/TLS parser through a stream pair, without binding a port. */
export function openInprocRequest(server: Server | HttpsServer, options: InprocOptions = {}) {
  const [serverSocket, clientSocket] = duplexPair();
  serverSocket.on('error', () => undefined); clientSocket.on('error', () => undefined);
  let wire: Duplex = clientSocket;
  server.emit('connection', serverSocket);
  if (options.tls) wire = connect({ socket: clientSocket, ca: options.tls.ca, servername: options.tls.servername ?? 'localhost', minVersion: options.tls.minVersion, maxVersion: options.tls.maxVersion });
  let protocol: string | null = null;
  const response = new Promise<InprocResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    wire.on('data', (c: Buffer) => chunks.push(c));
    wire.on('error', reject);
    wire.on('close', () => reject(new Error('in-process connection closed')));
    wire.on('end', () => {
      try {
        const all = Buffer.concat(chunks).toString('utf8'), split = all.indexOf('\r\n\r\n');
        if (split < 0) throw new Error('in-process response ended without HTTP headers');
        const head = all.slice(0, split).split('\r\n'); const status = Number(head.shift()!.split(' ')[1]);
        const headers = new Headers(); for (const line of head) { const i = line.indexOf(':'); if (i > 0) headers.append(line.slice(0, i), line.slice(i + 1).trim()); }
        let text = all.slice(split + 4);
        if (headers.get('transfer-encoding') === 'chunked') {
          let data = Buffer.from(text), out: Buffer[] = [];
          while (data.length) { const i = data.indexOf('\r\n'); const n = parseInt(data.subarray(0, i).toString(), 16); if (!n) break; out.push(data.subarray(i + 2, i + 2 + n)); data = data.subarray(i + 2 + n + 2); }
          text = Buffer.concat(out).toString('utf8');
        }
        let body: unknown; try { body = JSON.parse(text); } catch { body = undefined; }
        resolve({ status, headers, text, body });
      } catch (e) { reject(e); }
      finally { wire.destroy(); serverSocket.destroy(); }
    });
    const send = () => {
      const body = options.raw ?? (options.body === undefined ? '' : JSON.stringify(options.body));
      const headers = { host: 'localhost', connection: 'close', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...options.headers };
      wire.write(`${options.method ?? 'POST'} ${options.path ?? '/mcp'} HTTP/1.1\r\n${Object.entries(headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`);
    };
    if (options.tls) (wire as TLSSocket).once('secureConnect', () => { protocol = (wire as TLSSocket).getProtocol(); send(); }); else send();
  });
  return { response, disconnect() { wire.destroy(); clientSocket.destroy(); serverSocket.destroy(); }, get protocol() { return protocol; } };
}
export function inprocRequest(server: Server | HttpsServer, opts: InprocOptions = {}) { return openInprocRequest(server, opts).response; }
/** Adapter used for front↔upstream compatibility tests. The optional probe response selects legacy in that row. */
export function frontFetch(server: Server | HttpsServer, legacyProbe = false): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (legacyProbe && body?.method === 'server/discover') return new Response(null, { status: 400 });
    const headers = Object.fromEntries(new Headers(init?.headers));
    const active = openInprocRequest(server, { method: init?.method ?? 'GET', headers, body });
    const abort = () => active.disconnect(); init?.signal?.addEventListener('abort', abort, { once: true });
    try { const r = await active.response; return new Response([204,304].includes(r.status) ? null : r.text, { status: r.status, headers: r.headers }); }
    finally { init?.signal?.removeEventListener('abort', abort); }
  }) as typeof fetch;
}
