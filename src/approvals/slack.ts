import { randomBytes } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import type { ApprovalResult, PolicyDecision, SecretRef, ToolCall } from '../types/index.js';
import { SLACK_ACTION_IDS, SLACK_BLOCK_ID_PREFIX, SLACK_BUTTON_VALUE_RE, SLACK_NONCE_BYTES, type PendingApproval, type SlackApprovalRouter, type SlackChannel } from './contract.js';

export const SLACK_API_BASE_URL = 'https://slack.com/api/' as const;
export const SLACK_PROXY_MAX_TIMEOUT_MS = 240_000;
export const SLACK_HTTP_TIMEOUT_MS = 10_000;
// Kept local: only the pipeline may import another module; frozen hooks timing margin is 5 s.
const APPROVAL_MIN_MARGIN_MS = 5_000;
const SETTLED_FEEDBACK_MS = 30_000;
const MAX_SETTLED_FEEDBACK = 1024;
export interface WebSocketLike {
  readyState: number; send(data: string): void; close(code?: number): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (ev: { data?: unknown }) => void): void;
}
export interface SlackApprovalsConfig {
  apiBaseUrl?: string; fetch?: typeof fetch; WebSocket?: new (url: string) => WebSocketLike;
  now?: () => number; randomBytes?: (n: number) => Buffer; readSecret?: (ref: SecretRef) => Promise<string>;
}
let config: SlackApprovalsConfig = {};
let configured = false, used = false, shutdown = false;
let router: Router | undefined;
const now = () => (config.now ?? Date.now)();
const record = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function configureSlackApprovals(cfg: SlackApprovalsConfig): void {
  if (configured || used || router || shutdown) throw new Error('Slack approvals configuration is already fixed');
  const base = cfg.apiBaseUrl ?? SLACK_API_BASE_URL;
  if (base !== SLACK_API_BASE_URL && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api\/$/.test(base)) throw new Error('Slack apiBaseUrl is not allowed');
  const parsed = new URL(base);
  if (parsed.port && Number(parsed.port) > 65535) throw new Error('Slack apiBaseUrl is not allowed');
  config = { ...cfg }; configured = true;
}
async function readSecret(ref: SecretRef): Promise<string> {
  if (config.readSecret) return config.readSecret(ref);
  let value: string;
  if (ref.kind === 'env') value = process.env[ref.name] ?? '';
  else {
    const fd = openSync(ref.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > 4096) throw new Error('secret');
      const buf = Buffer.alloc(4097); let offset = 0;
      while (offset < buf.length) { const n = readSync(fd, buf, offset, buf.length - offset, null); if (!n) break; offset += n; }
      if (offset > 4096) throw new Error('secret');
      value = buf.subarray(0, offset).toString('utf8');
    } finally { closeSync(fd); }
  }
  value = value.trim(); if (!value) throw new Error('secret'); return value;
}
export async function validateSlackChannelImpl(c: SlackChannel): Promise<string[]> {
  used = true; const problems: string[] = [];
  if (!c || c.kind !== 'slack') return ['kind'];
  if (!/^[CG][A-Z0-9]{8,}$/.test(c.channelId)) problems.push('channelId');
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs <= 0 || c.timeoutMs > SLACK_PROXY_MAX_TIMEOUT_MS) problems.push('timeoutMs');
  if (c.transport !== 'socket-mode') problems.push('transport');
  if (!Array.isArray(c.approvers) || !c.approvers.length || c.approvers.some(u => typeof u !== 'string' || !/^[UW][A-Z0-9]{8,}$/.test(u))) problems.push('approvers');
  for (const [key, prefix] of [['botToken', 'xoxb-'], ['appToken', 'xapp-']] as const) {
    try { if (!(await readSecret(c[key])).startsWith(prefix)) problems.push(key); } catch { problems.push(key); }
  }
  return problems;
}
class SlackFailure extends Error { constructor(readonly step: string, readonly retryMs?: number) { super(step); } }
async function api(method: string, token: string, body: unknown): Promise<Record<string, any>> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const res = await (config.fetch ?? fetch)(`${config.apiBaseUrl ?? SLACK_API_BASE_URL}${method}`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body), redirect: 'error', signal: controller.signal,
        });
        if (res.status === 429) {
          const retry = res.headers.get('retry-after'); await res.body?.cancel();
          throw new SlackFailure(`${method}: ratelimited`, retry !== null && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : undefined);
        }
        if (res.status !== 200) { await res.body?.cancel(); throw new SlackFailure(`${method}: error`); }
        const data: unknown = await res.json();
        if (!record(data) || data.ok !== true) throw new SlackFailure(`${method}: ${record(data) && typeof data.error === 'string' && /^[a-z_]{1,64}$/.test(data.error) ? data.error : 'error'}`);
        return data;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SlackFailure(`${method}: error`)); }, SLACK_HTTP_TIMEOUT_MS); }),
    ]);
  } catch (e) { throw e instanceof SlackFailure ? e : new SlackFailure(`${method}: error`); }
  finally { clearTimeout(timer); }
}
function result(callId: string, decision: ApprovalResult['decision'], reason: string, approver?: string): ApprovalResult {
  return { callId, decision, reason, channel: 'slack', decidedAt: new Date(now()).toISOString(), ...(approver ? { approver } : {}) };
}
function unavailable(callId: string, step: string) { return result(callId, 'unavailable', `Slack unreachable: ${step}`); }
interface Connection { socket: WebSocketLike; appId: string; }
class Router implements SlackApprovalRouter {
  pending = new Map<string, PendingApproval>();
  justSettled = new Map<string, { entry: Pick<PendingApproval, "callId" | "nonce" | "messageTs" | "channelId">; outcome: ApprovalResult; expiresAt: number }>();
  sockets = new Set<WebSocketLike>();
  current: Connection | undefined;
  opening: Promise<Connection> | undefined;
  reconnecting = false;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  cancelReconnect: (() => void) | undefined;
  bot = ''; app = ''; teamId = ''; botUserId = '';
  credentials: Promise<void> | undefined;
  closed = false;
  constructor(readonly channel: SlackChannel) {}
  get pendingCount() { return this.pending.size; }
  register(p: PendingApproval): void {
    if (this.closed || shutdown) { p.settle(unavailable(p.callId, 'proxy shutting down')); return; }
    if (this.pending.has(p.callId)) { p.settle(unavailable(p.callId, 'websocket')); return; }
    this.pending.set(p.callId, p);
    void this.ready().catch(e => this.fail(e instanceof SlackFailure ? e.step : 'websocket'));
  }
  async auth(): Promise<void> {
    this.credentials ??= (async () => {
      try { this.bot = (await readSecret(this.channel.botToken)).trim(); this.app = (await readSecret(this.channel.appToken)).trim(); if (!this.bot.startsWith('xoxb-') || !this.app.startsWith('xapp-')) throw Error(); }
      catch { throw new SlackFailure('secret'); }
      const r = await api('auth.test', this.bot, {});
      if (typeof r.team_id !== 'string' || typeof r.user_id !== 'string') throw new SlackFailure('auth.test: error');
      this.teamId = r.team_id; this.botUserId = r.user_id;
    })().catch(e => { this.credentials = undefined; throw e; });
    return this.credentials;
  }
  ready(): Promise<Connection> {
    if (this.closed || shutdown) return Promise.reject(new SlackFailure('proxy shutting down'));
    if (this.current?.socket.readyState === 1) return Promise.resolve(this.current);
    this.opening ??= this.connect().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  async connect(): Promise<Connection> {
    await this.auth();
    if (this.closed || shutdown) throw new SlackFailure('proxy shutting down');
    const r = await api('apps.connections.open', this.app, {});
    let url: URL;
    try { url = new URL(r.url); } catch { throw new SlackFailure('websocket'); }
    const loopback = config.apiBaseUrl !== undefined && config.apiBaseUrl !== SLACK_API_BASE_URL;
    if (url.username || url.password || !((url.protocol === 'wss:' && url.hostname.endsWith('.slack.com')) || (loopback && url.protocol === 'ws:' && url.hostname === '127.0.0.1' && url.port))) throw new SlackFailure('websocket');
    if (this.closed || shutdown) throw new SlackFailure('proxy shutting down');
    return new Promise<Connection>((resolve, reject) => {
      let socket: WebSocketLike;
      try { socket = new (config.WebSocket ?? WebSocket)(url.toString()); } catch { reject(new SlackFailure('websocket')); return; }
      this.sockets.add(socket); let hello = false, finished = false; let appId = '';
      const failed = () => { if (!finished) { finished = true; clearTimeout(timer); this.sockets.delete(socket); socket.close(); reject(new SlackFailure('websocket')); } };
      const timer = setTimeout(failed, SLACK_HTTP_TIMEOUT_MS);
      socket.addEventListener('message', ev => {
        let frame: unknown; try { frame = JSON.parse(String(ev.data)); } catch { return; }
        if (!record(frame)) return;
        // The acknowledgement happens synchronously before examining any payload fields.
        if (typeof frame.envelope_id === 'string') { try { socket.send(JSON.stringify({ envelope_id: frame.envelope_id })); } catch { failed(); return; } }
        if (frame.type === 'hello') {
          if (hello || finished || !record(frame.connection_info) || typeof frame.connection_info.app_id !== 'string' || !frame.connection_info.app_id) return;
          appId = frame.connection_info.app_id;
          if (this.current && appId !== this.current.appId) { failed(); return; }
          hello = true; finished = true; clearTimeout(timer);
          const old = this.current; this.current = { socket, appId };
          if (old && old.socket !== socket) { this.sockets.delete(old.socket); old.socket.close(); }
          resolve(this.current);
          if (this.closed || shutdown || this.pendingCount === 0) this.closeSockets();
          return;
        }
        if (!hello) return;
        if (frame.type === 'disconnect') {
          if (frame.reason === 'link_disabled') this.fail('link_disabled');
          else if (frame.reason === 'warning' || frame.reason === 'refresh_requested') void this.reconnect(true);
        } else if (frame.type === 'interactive' && record(frame.payload) && frame.payload.type === 'block_actions') this.click(frame.payload, appId);
      });
      socket.addEventListener('error', () => { if (!hello) failed(); else socket.close(); });
      socket.addEventListener('close', () => {
        this.sockets.delete(socket);
        if (!hello) { failed(); return; }
        if (this.current?.socket === socket) { this.current = undefined; if (this.pendingCount && !this.closed) void this.reconnect(false); }
      });
    });
  }
  async reconnect(immediate: boolean): Promise<void> {
    if (this.reconnecting || this.closed || !this.pendingCount) return;
    this.reconnecting = true;
    try {
      for (let i = 0; i < 3 && this.pendingCount && !this.closed; i++) {
        if (!immediate || i > 0) await new Promise<void>(resolve => { this.cancelReconnect = resolve; this.reconnectTimer = setTimeout(resolve, 1000 * 2 ** i); });
        if (!this.pendingCount || this.closed) return;
        try { await this.connect(); return; } catch { /* bounded retry */ }
      }
      if (this.pendingCount && !this.closed) this.fail('websocket');
    } finally { this.reconnecting = false; this.cancelReconnect = undefined; }
  }
  click(p: Record<string, any>, appId: string): void {
    if (p.api_app_id !== appId || !record(p.user) || (p.user.team_id !== undefined && this.teamId && p.user.team_id !== this.teamId) || !Array.isArray(p.actions) || p.actions.length !== 1) return;
    const action: unknown = p.actions[0];
    if (!record(action) || !Object.values(SLACK_ACTION_IDS).includes(action.action_id) || typeof action.value !== 'string' || !SLACK_BUTTON_VALUE_RE.test(action.value)) return;
    this.pruneFeedback();
    const [callId, nonce] = action.value.split(':'); const recent = this.justSettled.get(action.value); const pending = this.pending.get(callId!);
    const entry = recent?.entry ?? pending;
    if (!entry || action.block_id !== SLACK_BLOCK_ID_PREFIX + callId || nonce !== entry.nonce || !entry.messageTs) return;
    const ts = p.container?.message_ts ?? p.message?.ts, channelId = p.container?.channel_id ?? p.channel?.id;
    if (ts !== entry.messageTs || channelId !== entry.channelId || (p.message?.ts !== undefined && p.message.ts !== entry.messageTs) || (p.channel?.id !== undefined && p.channel.id !== entry.channelId)) return;
    if (!this.channel.approvers.includes(p.user.id)) {
      void api('chat.postEphemeral', this.bot, { channel: entry.channelId, user: p.user.id, text: 'only the configured approvers can decide' }).catch(() => undefined); return;
    }
    if (recent) {
      void api('chat.postEphemeral', this.bot, { channel: entry.channelId, user: p.user.id, text: `already decided by ${recent.outcome.approver ?? 'proxy'} at ${recent.outcome.decidedAt}` }).catch(() => undefined); return;
    }
    const approve = action.action_id === SLACK_ACTION_IDS.approve;
    pending?.settle(result(entry.callId, approve ? 'approved' : 'denied', `slack: ${approve ? 'Approve' : 'Deny'} clicked by ${p.user.id}`, p.user.id));
  }
  // Keep only binding fields, not a PendingApproval's closure (which retains the whole call).
  remember(p: PendingApproval, outcome: ApprovalResult): void {
    if (!p.messageTs || this.closed) return;
    this.pruneFeedback();
    const expiresAt = Date.parse(outcome.decidedAt) + SETTLED_FEEDBACK_MS;
    if (expiresAt <= now()) return;
    const key = `${p.callId}:${p.nonce}`;
    this.justSettled.set(key, { entry: { callId: p.callId, nonce: p.nonce, messageTs: p.messageTs, channelId: p.channelId }, outcome, expiresAt });
    while (this.justSettled.size > MAX_SETTLED_FEEDBACK) this.justSettled.delete(this.justSettled.keys().next().value!);
  }
  pruneFeedback(): void { for (const [key, recent] of this.justSettled) if (recent.expiresAt <= now()) this.justSettled.delete(key); }
  remove(p: PendingApproval): void { if (this.pending.get(p.callId) === p) this.pending.delete(p.callId); if (!this.pendingCount) this.closeSockets(); }
  fail(step: string): void { for (const p of [...this.pending.values()]) p.settle(unavailable(p.callId, step)); this.closeSockets(); }
  closeSockets(): void {
    clearTimeout(this.reconnectTimer); this.cancelReconnect?.(); this.current = undefined;
    for (const socket of this.sockets) socket.close(); this.sockets.clear();
  }
}
export function getRouter(channel: SlackChannel): Router {
  used = true;
  if (!router) router = new Router(structuredClone(channel));
  if (JSON.stringify(router.channel) !== JSON.stringify(channel)) throw new Error('Slack approvals channel is already fixed');
  return router;
}
export async function probeSlack(channel: SlackChannel): Promise<{ ok: true; teamId: string; botUserId: string; appId: string } | { ok: false; reason: string }> {
  used = true; const probe = new Router(structuredClone(channel));
  try {
    if (shutdown) throw new SlackFailure('proxy shutting down');
    // A probe must never create a competing Socket Mode consumer beside a live router.
    if (router?.pendingCount) throw new SlackFailure('websocket');
    const c = await probe.ready(); return { ok: true, teamId: probe.teamId, botUserId: probe.botUserId, appId: c.appId };
  } catch (e) { return { ok: false, reason: `Slack unreachable: ${e instanceof SlackFailure ? e.step : 'websocket'}` }; }
  finally { probe.closed = true; probe.closeSockets(); }
}
export async function closeSlackApprovals(): Promise<void> { shutdown = true; if (router) { router.closed = true; router.fail('proxy shutting down'); router.justSettled.clear(); } }
function escape(text: string): string { return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
export async function requestApprovalImpl(call: ToolCall, policy: PolicyDecision, channel: SlackChannel, deadlineAt?: number): Promise<ApprovalResult> {
  const callId = call?.callId ?? '';
  const wait = Math.max(0, Math.min(channel.timeoutMs, deadlineAt === undefined ? Infinity : deadlineAt - now() - APPROVAL_MIN_MARGIN_MS));
  if (wait <= 0) return result(callId, 'timeout', `no approver answered within ${wait} ms`);
  if (!Number.isFinite(wait) || shutdown) return unavailable(callId, shutdown ? 'proxy shutting down' : 'secret');
  let r: Router;
  try { r = getRouter(channel); } catch { return unavailable(callId, 'secret'); }
  return new Promise<ApprovalResult>(resolve => {
    let nonce: string;
    try { nonce = (config.randomBytes ?? randomBytes)(SLACK_NONCE_BYTES).toString('hex'); if (!SLACK_BUTTON_VALUE_RE.test(`${callId}:${nonce}`) || (SLACK_BLOCK_ID_PREFIX + callId).length > 255) throw Error(); }
    catch { resolve(unavailable(callId, 'secret')); return; }
    const expires = now() + wait; let settled: ApprovalResult | undefined, updated = false; let blocks: unknown[] = [];
    const update = () => {
      if (!settled || !entry.messageTs || updated) return; updated = true; r.remember(entry, settled);
      const text = settled.decision === 'approved' ? `Approved by <@${settled.approver}> at ${settled.decidedAt}` : settled.decision === 'denied' ? `Denied by <@${settled.approver}> at ${settled.decidedAt}` : settled.decision === 'timeout' ? `Expired after ${wait} ms` : 'Not decided: Slack unavailable';
      void api('chat.update', r.bot, { channel: entry.channelId, ts: entry.messageTs, text, blocks: [...blocks.slice(0, 2), { type: 'context', elements: [{ type: 'mrkdwn', text }] }] }).catch(() => undefined);
    };
    const entry: PendingApproval = { callId, nonce, messageTs: '', channelId: channel.channelId, state: 'pending', settle(outcome) {
      if (entry.state !== 'pending') return false;
      entry.state = 'settled'; settled = outcome; clearTimeout(timer); r.remove(entry); update(); resolve(outcome); return true;
    } };
    const timer = setTimeout(() => entry.settle(result(callId, 'timeout', `no approver answered within ${wait} ms`)), wait);
    r.register(entry);
    void (async () => {
      await r.ready(); if (entry.state !== 'pending') return;
      const clean = (s: string) => escape(s.replaceAll(r.bot, '[secret]').replaceAll(r.app, '[secret]').replaceAll(nonce, '[nonce]'));
      const name = clean(`${call.server}/${call.tool}`);
      const text = `Agent Ledger: approval needed for ${name} (${policy.risk})`;
      const preview = JSON.stringify(call.args);
      blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `${clean(call.agentId)} — ${name}\nRisk: ${policy.risk}; rule: ${clean(policy.ruleId)}\n${clean(policy.reason)}\n${clean(preview).slice(0, 1500)}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `${clean(callId)}; expiresAt ${new Date(expires).toISOString()}` }] },
        { type: 'actions', block_id: SLACK_BLOCK_ID_PREFIX + callId, elements: [
          { type: 'button', action_id: SLACK_ACTION_IDS.approve, text: { type: 'plain_text', text: 'Approve' }, style: 'primary', value: `${callId}:${nonce}`, confirm: { title: { type: 'plain_text', text: 'Approve action?' }, text: { type: 'plain_text', text: `Approve ${name}?` }, confirm: { type: 'plain_text', text: 'Approve' }, deny: { type: 'plain_text', text: 'Cancel' } } },
          { type: 'button', action_id: SLACK_ACTION_IDS.deny, text: { type: 'plain_text', text: 'Deny' }, style: 'danger', value: `${callId}:${nonce}` },
        ] },
      ];
      let posted: Record<string, any>;
      const post = () => api('chat.postMessage', r.bot, { channel: channel.channelId, text, blocks });
      try { posted = await post(); }
      catch (e) {
        if (!(e instanceof SlackFailure) || e.retryMs === undefined || e.retryMs > 5000 || now() + e.retryMs >= expires) throw e;
        await new Promise<void>(resolve => setTimeout(resolve, e.retryMs));
        if (entry.state !== 'pending') return;
        posted = await post();
      }
      if (typeof posted.ts !== 'string' || !posted.ts || posted.channel !== channel.channelId) throw new SlackFailure('chat.postMessage: error');
      entry.messageTs = posted.ts; update();
    })().catch(e => entry.settle(unavailable(callId, e instanceof SlackFailure ? e.step : 'websocket')));
  });
}
