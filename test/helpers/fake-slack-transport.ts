import type { WebSocketLike } from '../../src/approvals/contract.js';
export class FakeSlackTransport {
  calls: { method: string; body: any; headers: Headers }[] = [];
  sockets: FakeSocket[] = [];
  replies = new Map<string, (() => Response | Promise<Response>)[]>();
  hello = true;
  appId = 'A0123456789';
  teamId = 'T0123456789';
  sequence = 0;
  WebSocket: new (url: string) => WebSocketLike;
  constructor() {
    const owner = this;
    this.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(url); owner.sockets.push(this);
        queueMicrotask(() => { this.readyState = 1; this.emit('open'); if (owner.hello) this.frame({ type: 'hello', connection_info: { app_id: owner.appId } }); });
      }
    };
  }
  fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}'));
    this.calls.push({ method, body, headers: new Headers(init?.headers) });
    const scripted = this.replies.get(method)?.shift();
    if (scripted) return scripted();
    const result = method === 'auth.test' ? { team_id: this.teamId, user_id: 'U0000000000' }
      : method === 'apps.connections.open' ? { url: 'wss://slack.example/socket' }
      : method === 'chat.postMessage' ? { channel: body.channel, ts: `${++this.sequence}.001` } : {};
    return Response.json({ ok: true, ...result });
  }) as typeof fetch;
  posts() { return this.calls.filter(c => c.method === 'chat.postMessage'); }
  click(index = 0, overrides: Record<string, unknown> = {}, socket = this.sockets.at(-1)!) {
    const post = this.posts()[index]!.body;
    const actions = post.blocks.find((b: any) => b.type === 'actions');
    const payload = { type: 'block_actions', api_app_id: this.appId, user: { id: 'U0123456789', team_id: this.teamId },
      container: { channel_id: post.channel, message_ts: `${index + 1}.001` },
      actions: [{ ...actions.elements[0], block_id: actions.block_id }], ...overrides };
    socket.frame({ type: 'interactive', envelope_id: `env-${index}`, payload });
  }
}
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]); }
  emit(type: string, ev: { data?: unknown } = {}) { for (const fn of this.listeners.get(type) ?? []) fn(ev); }
  frame(data: unknown) { this.emit('message', { data: JSON.stringify(data) }); }
  send(data: string) { this.sent.push(data); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
}
