import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSlackTransport } from './helpers/fake-slack-transport.js';
import type { SlackChannel } from '../src/approvals/contract.js';
import type { ToolCall, PolicyDecision } from '../src/types/index.js';
const channel: SlackChannel = { kind: 'slack', channelId: 'C0123456789', timeoutMs: 30_000, transport: 'socket-mode', botToken: { kind: 'env', name: 'BOT' }, appToken: { kind: 'env', name: 'APP' }, approvers: ['U0123456789', 'U0987654321'] };
const call: ToolCall = { callId: 'call-1', sessionId: 'session', agentId: 'astra', server: 'demo', tool: 'danger', args: { safe: '<!channel>', secret: 'hmac-sha256:abc' }, receivedAt: new Date(0).toISOString() };
const policy: PolicyDecision = { verdict: 'require_approval', risk: 'risky', ruleId: 'registry:demo/danger', reason: 'reviewed risky' };
let a: typeof import('../src/approvals/contract.js');
let fake: FakeSlackTransport;
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
beforeEach(async () => { vi.resetModules(); vi.useFakeTimers(); a = await import('../src/approvals/contract.js'); fake = new FakeSlackTransport(); a.configureSlackApprovals({ fetch: fake.fetch, WebSocket: fake.WebSocket, readSecret: async r => r.kind === 'env' && r.name === 'BOT' ? 'xoxb-test-secret' : 'xapp-test-secret' }); });
afterEach(async () => { await a.closeSlackApprovals(); vi.useRealTimers(); });
describe('Slack approvals in process', () => {
  it.each(['approved', 'denied'] as const)('records %s with the actual user and acknowledges before settlement', async decision => {
    const p = a.requestApproval(call, policy, channel); await flush();
    const post = fake.posts()[0]!.body; const actions = post.blocks.find((b: any) => b.type === 'actions');
    expect(actions.elements).toHaveLength(2); expect(actions.elements[0].value).toMatch(a.SLACK_BUTTON_VALUE_RE);
    expect(actions.elements[0].confirm.text.text).toContain('demo/danger');
    expect(JSON.stringify(post)).toContain('&lt;!channel&gt;'); expect(JSON.stringify(post)).toContain('registry:demo/danger');
    expect(JSON.stringify(post)).not.toContain('xoxb-');
    fake.click(0, { actions: [{ ...actions.elements[decision === 'approved' ? 0 : 1], block_id: actions.block_id }] });
    expect(fake.sockets[0]!.sent).toEqual(['{"envelope_id":"env-0"}']);
    expect(await p).toMatchObject({ decision, callId: call.callId, approver: channel.approvers[0], reason: `slack: ${decision === 'approved' ? 'Approve' : 'Deny'} clicked by U0123456789` });
    await flush(); expect(fake.calls.filter(c => c.method === 'chat.update')).toHaveLength(1);
    expect(a.getSlackApprovalRouter(channel).pendingCount).toBe(0); expect(fake.sockets[0]!.readyState).toBe(3);
  });
  it('uses one connection for concurrent requests; unrelated, forged and duplicate clicks cannot settle another wait', async () => {
    const ps = [1,2,3].map(n => a.requestApproval({ ...call, callId: `call-${n}`, args: { ...call.args, n } }, policy, channel)); await flush();
    expect(fake.sockets).toHaveLength(1); expect(a.getSlackApprovalRouter(channel)).toBe(a.getSlackApprovalRouter(channel));
    for (const patch of [{ api_app_id: 'wrong' }, { user: { id: 'U0123456789', team_id: 'other' } }, { actions: [] }, { container: { channel_id: 'wrong', message_ts: '2.001' } }]) fake.click(1, patch);
    expect(a.getSlackApprovalRouter(channel).pendingCount).toBe(3);
    fake.click(1); fake.click(1); expect((await ps[1])?.decision).toBe('approved');
    expect(a.getSlackApprovalRouter(channel).pendingCount).toBe(2);
    await a.closeSlackApprovals(); expect((await ps[0])?.decision).toBe('unavailable'); expect((await ps[2])?.reason).toBe('Slack unreachable: proxy shutting down');
  });
  it('ignores a non-approver and sends a best-effort ephemeral explanation', async () => {
    const p = a.requestApproval(call, policy, channel); await flush(); fake.click(0, { user: { id: 'U1111111111', team_id: fake.teamId } }); await flush();
    expect(fake.calls.some(c => c.method === 'chat.postEphemeral')).toBe(true); expect(a.getSlackApprovalRouter(channel).pendingCount).toBe(1);
    fake.click(); expect((await p).decision).toBe('approved');
  });
  it('times out once, removes buttons, and ignores late clicks', async () => {
    const p = a.requestApproval(call, policy, channel); await flush(); const socket = fake.sockets[0]!;
    await vi.advanceTimersByTimeAsync(channel.timeoutMs); expect(await p).toMatchObject({ decision: 'timeout', reason: 'no approver answered within 30000 ms' });
    fake.click(0, {}, socket); await flush(); expect(fake.calls.filter(c => c.method === 'chat.update')).toHaveLength(1);
  });
  it('caps the wait to the deadline and skips all Slack calls inside the margin', async () => {
    expect((await a.requestApproval(call, policy, channel, Date.now() + 4999)).decision).toBe('timeout'); expect(fake.calls).toHaveLength(0);
    const p = a.requestApproval(call, policy, channel, Date.now() + 6000); await flush(); await vi.advanceTimersByTimeAsync(1000); expect((await p).reason).toBe('no approver answered within 1000 ms');
  });
  it.each(['auth.test','apps.connections.open','chat.postMessage'])('fails closed on %s and sanitizes the Slack error', async method => {
    fake.replies.set(method, [() => Response.json({ ok: false, error: 'xoxb-test-secret reflected' })]);
    const p = a.requestApproval(call, policy, channel); await flush(); expect(await p).toMatchObject({ decision: 'unavailable', reason: `Slack unreachable: ${method}: error` });
  });
  it('requires hello, refuses wrong socket schemes, and closes a successful startup probe', async () => {
    expect(await a.probeSlack(channel)).toMatchObject({ ok: true, appId: fake.appId }); expect(fake.sockets[0]!.readyState).toBe(3);
    fake.replies.set('apps.connections.open', [() => Response.json({ ok: true, url: 'ws://evil.example/socket' })]);
    const p = a.requestApproval(call, policy, channel); await flush(); expect((await p).reason).toBe('Slack unreachable: websocket');
  });
  it('bounds a missing hello', async () => {
    fake.hello = false; const p = a.requestApproval(call, policy, channel); await flush(); await vi.advanceTimersByTimeAsync(10_000); expect((await p).decision).toBe('unavailable');
  });
  it('opens the replacement before closing the old socket and preserves pending clicks', async () => {
    const p = a.requestApproval(call, policy, channel); await flush(); const old = fake.sockets[0]!; fake.hello = false;
    old.frame({ type: 'disconnect', reason: 'refresh_requested' }); await flush(); expect(fake.sockets).toHaveLength(2); expect(old.readyState).toBe(1);
    fake.sockets[1]!.frame({ type: 'hello', connection_info: { app_id: fake.appId } }); await flush(); expect(old.readyState).toBe(3);
    fake.click(); expect((await p).decision).toBe('approved');
  });
  it('settles link_disabled and keeps a failed update from changing a decision', async () => {
    const p = a.requestApproval(call, policy, channel); await flush(); fake.replies.set('chat.update', [() => { throw Error('secret'); }]);
    fake.sockets[0]!.frame({ type: 'disconnect', reason: 'link_disabled' }); expect((await p).reason).toBe('Slack unreachable: link_disabled');
  });
  it('retries a rate limited post only once and within the wait', async () => {
    fake.replies.set('chat.postMessage', [() => new Response('', { status: 429, headers: { 'retry-after': '1' } })]);
    const p = a.requestApproval(call, policy, channel); await flush(); expect(fake.posts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); expect(fake.posts()).toHaveLength(2); await a.closeSlackApprovals(); expect((await p).decision).toBe('unavailable');
  });
  it('validates field shapes, timeout cap and token prefixes without exposing values; config is set once', async () => {
    expect(await a.validateSlackChannel(channel)).toEqual([]);
    expect(await a.validateSlackChannel({ ...channel, channelId: 'bad', timeoutMs: 240001, approvers: [] })).toEqual(expect.arrayContaining(['channelId', 'timeoutMs', 'approvers']));
    expect(() => a.configureSlackApprovals({})).toThrow();
  });
});

describe('Slack fault and race regressions', () => {
  it.each(['nonce', 'message', 'channel', 'block', 'call', 'action', 'multiple'])('acks but rejects a forged %s', async field => {
    const p = a.requestApproval(call, policy, channel); await flush();
    const block = fake.posts()[0]!.body.blocks.find((b: any) => b.type === 'actions');
    const action = { ...block.elements[0], block_id: block.block_id };
    const patch: Record<string, unknown> = {};
    if (field === 'nonce') action.value = `${call.callId}:${'0'.repeat(32)}`;
    if (field === 'call') action.value = `other:${action.value.split(':')[1]}`;
    if (field === 'block') action.block_id += 'wrong';
    if (field === 'action') action.action_id = 'other';
    patch.actions = field === 'multiple' ? [action, action] : [action];
    if (field === 'message') patch.message = { ts: 'wrong' };
    if (field === 'channel') patch.channel = { id: 'wrong' };
    fake.click(0, patch); expect(fake.sockets[0]!.sent).toHaveLength(1); expect(a.getSlackApprovalRouter(channel).pendingCount).toBe(1);
    fake.click(); expect((await p).decision).toBe('approved');
  });
  it.each([true, false])('settles a timeout/click race once, click first=%s', async first => {
    const p = a.requestApproval(call, policy, channel); await flush();
    if (first) fake.click(); await vi.advanceTimersByTimeAsync(channel.timeoutMs); if (!first) fake.click();
    expect((await p).decision).toBe(first ? 'approved' : 'timeout'); await flush(); expect(fake.calls.filter(c => c.method === 'chat.update')).toHaveLength(1);
  });
  it('competing authorized clicks send already-decided feedback and cannot change the winner', async () => {
    const p = a.requestApproval(call, policy, channel); await flush(); fake.click(); fake.click(0, { user: { id: 'U0987654321', team_id: fake.teamId } });
    expect((await p).approver).toBe('U0123456789'); await flush(); expect(fake.calls.find(c => c.method === 'chat.postEphemeral')?.body.text).toContain('already decided');
  });
  it('mints a new nonce and reopens after the last request settles', async () => {
    const first = a.requestApproval(call, policy, channel); await flush(); fake.click(); await first;
    const second = a.requestApproval(call, policy, channel); await flush();
    const values = fake.posts().map(p => p.body.blocks.find((b: any) => b.type === 'actions').elements[0].value);
    expect(values[0]).not.toBe(values[1]); expect(fake.sockets).toHaveLength(2); fake.click(1); expect((await second).decision).toBe('approved');
  });
  it('reconnects after an unexpected close using 1, 2, 4 second backoff, then fails closed', async () => {
    const p = a.requestApproval(call, policy, channel); await flush();
    fake.replies.set('apps.connections.open', [1,2,3].map(() => () => Response.json({ ok: false, error: 'not_allowed_token_type' })));
    fake.sockets[0]!.close();
    for (const ms of [1000, 2000, 4000]) await vi.advanceTimersByTimeAsync(ms);
    expect((await p).reason).toBe('Slack unreachable: websocket'); expect(fake.calls.filter(c => c.method === 'apps.connections.open')).toHaveLength(4);
  });
  it.each(['6', 'invalid'])('refuses Retry-After=%s rather than waiting or retrying', async retry => {
    fake.replies.set('chat.postMessage', [() => new Response('', { status: 429, headers: { 'retry-after': retry } })]);
    const p = a.requestApproval(call, policy, channel); await flush(); expect((await p).decision).toBe('unavailable'); expect(fake.posts()).toHaveLength(1);
  });
  it('acks noninteractive envelopes without treating their payload as clicks', async () => {
    const p = a.requestApproval(call, policy, channel); await flush(); fake.sockets[0]!.frame({ type: 'events_api', envelope_id: 'other', payload: {} });
    expect(fake.sockets[0]!.sent).toContain('{"envelope_id":"other"}'); expect(a.getSlackApprovalRouter(channel).pendingCount).toBe(1); await a.closeSlackApprovals(); await p;
  });
  it('settles a hanging Web API call within its HTTP deadline without leaking exceptions', async () => {
    fake.replies.set('auth.test', [() => new Promise(() => {})]); const p = a.requestApproval(call, policy, channel); await flush();
    await vi.advanceTimersByTimeAsync(10_000); expect((await p).reason).toBe('Slack unreachable: auth.test: error');
  });
});

describe('Fable review recovery and feedback regressions', () => {
  it('P2-1 retries auth.test after a transient failure and shares the successful retry', async () => {
    fake.replies.set('auth.test', [() => new Response(null, { status: 503 })]);
    expect((await a.requestApproval(call, policy, channel)).decision).toBe('unavailable');
    const pending = [2, 3].map(n => a.requestApproval({ ...call, callId: `retry-${n}`, args: { ...call.args, n } }, policy, channel)); await flush();
    expect(fake.calls.filter(c => c.method === 'auth.test')).toHaveLength(2);
    expect(fake.sockets).toHaveLength(1); fake.click(0); fake.click(1);
    expect((await Promise.all(pending)).map(r => r.decision)).toEqual(['approved', 'approved']);
  });
  it('P3-1 tells a late allowed click who decided, but never repeats a decision or update', async () => {
    const pending = a.requestApproval(call, policy, channel); await flush(); fake.click(); const winner = await pending;
    await vi.advanceTimersByTimeAsync(1000);
    const next = a.requestApproval(call, policy, channel); await flush();
    fake.click(0); await flush();
    expect(fake.calls.filter(c => c.method === 'chat.postEphemeral').at(-1)?.body.text).toBe(`already decided by ${winner.approver} at ${winner.decidedAt}`);
    expect(a.getSlackApprovalRouter(channel).pendingCount).toBe(1);
    expect(fake.calls.filter(c => c.method === 'chat.update')).toHaveLength(1);
    fake.click(1); expect((await next).decision).toBe('approved');
  });
  it('P3-1 expires late-click feedback after 30 seconds without revising the decision', async () => {
    const pending = a.requestApproval(call, policy, channel); await flush(); fake.click(); await pending;
    await vi.advanceTimersByTimeAsync(30_000);
    const next = a.requestApproval({ ...call, callId: 'next' }, policy, channel); await flush(); fake.click(0); await flush();
    expect(fake.calls.filter(c => c.method === 'chat.postEphemeral')).toHaveLength(0);
    fake.click(1); await next;
  });
  it('P3-1 bounds retained feedback to the latest 1024 settlements', async () => {
    const keeper = a.requestApproval({ ...call, callId: 'keeper' }, policy, channel); await flush();
    for (let n = 1; n <= 1025; n++) {
      const pending = a.requestApproval({ ...call, callId: `settled-${n}`, args: { ...call.args, n } }, policy, channel); await flush();
      fake.click(n); expect((await pending).decision).toBe('approved');
    }
    fake.click(1); await flush(); expect(fake.calls.filter(c => c.method === 'chat.postEphemeral')).toHaveLength(0);
    fake.click(2); await flush(); expect(fake.calls.filter(c => c.method === 'chat.postEphemeral')).toHaveLength(1);
    expect(a.getSlackApprovalRouter(channel).pendingCount).toBe(1); fake.click(0); await keeper;
  });
  it.each(['wss://evil.example/socket', 'wss://slack.com.evil.example/socket', 'wss://notslack.com/socket'])('P3-2 refuses Socket Mode host %s', async url => {
    fake.replies.set('apps.connections.open', [() => Response.json({ ok: true, url })]);
    expect((await a.requestApproval(call, policy, channel)).reason).toBe('Slack unreachable: websocket'); expect(fake.sockets).toHaveLength(0);
  });
});

describe('ADR-015 approver names', () => {
  it.each(['approved', 'denied'] as const)('looks up the winning member at decision time for %s', async decision => {
    const p = a.requestApproval(call, policy, channel); await flush();
    expect(fake.calls.some(c => c.method === 'users.info')).toBe(false);
    const actions = fake.posts()[0]!.body.blocks.find((b: any) => b.type === 'actions');
    fake.click(0, { actions: [{ ...actions.elements[decision === 'approved' ? 0 : 1], block_id: actions.block_id }] });
    expect(a.getSlackApprovalRouter(channel).pendingCount).toBe(0);
    expect(await p).toMatchObject({ decision, approver: 'U0123456789', approverName: 'Ryan Zeleznock' });
    const lookups = fake.calls.filter(c => c.method === 'users.info');
    expect(lookups).toHaveLength(1); expect(lookups[0]!.body).toEqual({ user: 'U0123456789' });
    expect(lookups[0]!.headers.get('authorization')).toBe('Bearer xoxb-test-secret');
    expect(lookups[0]!.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
  });
  it.each(['missing_scope', 'rate_limit', 'network', 'malformed', 'wrong_member', 'empty', 'oversize', 'invalid_unicode', 'reflected_token'])('omits the name on %s and preserves the decision without response values', async failure => {
    fake.replies.set('users.info', [() => {
      if (failure === 'network') throw Error('xoxb-test-secret');
      if (failure === 'rate_limit') return new Response('xoxb-test-secret', { status: 429, headers: { 'retry-after': '30' } });
      if (failure === 'missing_scope') return Response.json({ ok: false, error: 'missing_scope', detail: 'xoxb-test-secret' });
      if (failure === 'malformed') return new Response('xoxb-test-secret');
      return Response.json({ ok: true, user: { id: failure === 'wrong_member' ? 'Uwrong' : 'U0123456789', profile: {
        real_name: failure === 'empty' ? '  ' : failure === 'oversize' ? 'x'.repeat(257) : failure === 'invalid_unicode' ? '\uD800' : 'xoxb-test-secret',
      } } });
    }]);
    const p = a.requestApproval(call, policy, channel); await flush(); fake.click(); const r = await p;
    expect(r).toMatchObject({ decision: 'approved', approver: 'U0123456789' }); expect(r).not.toHaveProperty('approverName');
    expect(JSON.stringify(r)).not.toContain('xoxb-test-secret'); expect(fake.calls.filter(c => c.method === 'users.info')).toHaveLength(1);
  });
  it('bounds a non-cooperating name lookup and locks the winner before competing clicks, timeout or shutdown', async () => {
    fake.replies.set('users.info', [() => new Promise(() => {})]);
    const p = a.requestApproval(call, policy, { ...channel, timeoutMs: 500 }); await flush();
    const decidedAt = new Date().toISOString(); fake.click(); fake.click(0, { user: { id: 'U0987654321', team_id: fake.teamId } });
    await a.closeSlackApprovals(); await vi.advanceTimersByTimeAsync(500);
    expect(await p).toMatchObject({ decision: 'approved', approver: 'U0123456789', decidedAt });
    expect(await p).not.toHaveProperty('approverName'); expect(fake.calls.filter(c => c.method === 'users.info')).toHaveLength(1);
  });
  it('bounds stalled users.info response bodies to one second', async () => {
    fake.replies.set('users.info', [() => new Response(new ReadableStream({ start() {}, cancel() {} }))]);
    const p = a.requestApproval(call, policy, channel); await flush(); fake.click(); await flush();
    await vi.advanceTimersByTimeAsync(1000); expect(await p).toMatchObject({ decision: 'approved' });
    expect(await p).not.toHaveProperty('approverName');
  });
  it('does not query member profiles for unauthorized clicks, timeouts or shutdown', async () => {
    const p = a.requestApproval(call, policy, channel); await flush();
    fake.click(0, { user: { id: 'U1111111111', team_id: fake.teamId } });
    await vi.advanceTimersByTimeAsync(channel.timeoutMs); expect((await p).decision).toBe('timeout');
    expect(fake.calls.filter(c => c.method === 'users.info')).toHaveLength(0);
  });
});

it.each([
  { profile: { real_name: '  Ryan Zeleznock  ', display_name: 'Ryan' }, real_name: 'Other' },
  { profile: {}, real_name: 'Ryan Zeleznock' },
  { profile: { display_name: 'Ryan Zeleznock' } },
])('uses a bounded real/display name snapshot without caching: %j', async fields => {
  fake.replies.set('users.info', [() => Response.json({ ok: true, user: { id: 'U0123456789', ...fields } }),
    () => Response.json({ ok: true, user: { id: 'U0123456789', real_name: 'Updated Name' } })]);
  const first = a.requestApproval(call, policy, channel); await flush(); fake.click();
  expect(await first).toHaveProperty('approverName', 'Ryan Zeleznock');
  const second = a.requestApproval({ ...call, callId: 'second' }, policy, channel); await flush(); fake.click(1);
  expect(await second).toHaveProperty('approverName', 'Updated Name');
});
it.each([true, false])('omits names from a profile response exceeding 64 KiB, declared=%s', async declared => {
  fake.replies.set('users.info', [() => Response.json({ ok: true, user: { id: 'U0123456789', real_name: 'Ryan Zeleznock' }, padding: 'x'.repeat(65536) },
    declared ? { headers: { 'content-length': '70000' } } : {})]);
  const p = a.requestApproval(call, policy, channel); await flush(); fake.click();
  expect(await p).toMatchObject({ decision: 'approved' }); expect(await p).not.toHaveProperty('approverName');
});
it('discards late lookup completion after its deadline instead of mutating the returned approval', async () => {
  let finish!: (r: Response) => void;
  fake.replies.set('users.info', [() => new Promise(resolve => { finish = resolve; })]);
  const p = a.requestApproval(call, policy, channel); await flush(); fake.click(); await flush();
  await vi.advanceTimersByTimeAsync(1000); const settled = await p; expect(settled).not.toHaveProperty('approverName');
  finish(Response.json({ ok: true, user: { id: 'U0123456789', real_name: 'Late Name' } })); await flush();
  expect(settled).not.toHaveProperty('approverName'); expect(settled.decision).toBe('approved');
});


describe('Fable fixes-2b review name controls', () => {
  const controls = [0x00, 0x09, 0x1f, 0x7f, 0x80, 0x9f, 0xad, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
  it.each(controls)('omits names containing control/format character U+%s without revising the decision', async cp => {
    fake.replies.set('users.info', [() => Response.json({ ok: true, user: { id: 'U0123456789',
      profile: { real_name: `Ryan${String.fromCodePoint(cp)}`, display_name: 'Fallback Name' } } })]);
    const p = a.requestApproval(call, policy, channel); await flush(); fake.click();
    const decision = await p;
    expect(decision).toMatchObject({ decision: 'approved', approver: 'U0123456789' });
    expect(decision).not.toHaveProperty('approverName');
  });
  it.each(['real_name', 'display_name'])('checks fallback %s for Unicode controls too', async field => {
    fake.replies.set('users.info', [() => Response.json({ ok: true, user: { id: 'U0123456789',
      ...(field === 'real_name' ? { real_name: 'Ryan\u202e' } : { profile: { display_name: 'Ryan\u2067' } }) } })]);
    const p = a.requestApproval(call, policy, channel); await flush(); fake.click();
    expect(await p).not.toHaveProperty('approverName');
  });
  it('retains ordinary right-to-left names without control characters', async () => {
    fake.replies.set('users.info', [() => Response.json({ ok: true, user: { id: 'U0123456789', real_name: 'ריאן' } })]);
    const p = a.requestApproval(call, policy, channel); await flush(); fake.click();
    expect(await p).toHaveProperty('approverName', 'ריאן');
  });
});
