// ADR-018 §2/§3 (server audit P2-2, P2-3): the Slack card shows the reviewed clear fields of the (already redacted)
// arguments, marks withheld ones, carries a digest of the full arguments, states truncation, and denies when the preview
// cannot fit Slack's limits. Per-agent pending cap; an identical pending request is not posted twice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { FakeSlackTransport } from './helpers/fake-slack-transport.js';
import type { SlackChannel } from '../src/approvals/contract.js';
import type { ToolCall, PolicyDecision } from '../src/types/index.js';
import { PREVIEW_MAX_ARG_BLOCKS, PREVIEW_VALUE_MAX_CHARS, SLACK_MESSAGE_MAX_BLOCKS, SLACK_SECTION_TEXT_MAX, buildArgsPreview } from '../src/approvals/preview.js';

const channel: SlackChannel = { kind: 'slack', channelId: 'C0123456789', timeoutMs: 30_000, transport: 'socket-mode', botToken: { kind: 'env', name: 'BOT' }, appToken: { kind: 'env', name: 'APP' }, approvers: ['U0123456789'] };
const H = (c: string) => `hmac-sha256:${c.repeat(64)}`;
const call: ToolCall = { callId: 'call-1', sessionId: 's', agentId: 'astra', server: 'demo', tool: 'wipe', args: { target: 'prod-db', password: H('a'), note: '[REDACTED:email]' }, receivedAt: new Date(0).toISOString() };
const policy: PolicyDecision = { verdict: 'require_approval', risk: 'risky', ruleId: 'registry:demo/wipe', reason: 'reviewed risky' };
let a: typeof import('../src/approvals/contract.js');
let slack: typeof import('../src/approvals/slack.js');
let fake: FakeSlackTransport;
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
const texts = (post: any): string => post.blocks.map((b: any) => b.text?.text ?? b.elements?.map((e: any) => e.text).join(' ') ?? '').join('\n');
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  a = await import('../src/approvals/contract.js'); slack = await import('../src/approvals/slack.js');
  fake = new FakeSlackTransport();
  a.configureSlackApprovals({ fetch: fake.fetch, WebSocket: fake.WebSocket, readSecret: async r => r.kind === 'env' && r.name === 'BOT' ? 'xoxb-test-secret' : 'xapp-test-secret' });
});
afterEach(async () => { await a.closeSlackApprovals(); vi.useRealTimers(); });

describe('ADR-018 §3: approval preview', () => {
  it('shows clear fields, marks hmac and redacted fields as withheld, and carries the JCS digest of the args it received', async () => {
    const p = a.requestApproval(call, policy, channel); await flush();
    const post = fake.posts()[0]!.body; const t = texts(post);
    expect(t).toContain('• target: "prod-db"');
    expect(t).toContain('• password: [withheld: stored as a keyed digest (hmac-sha256); not reviewed as clear]');
    expect(t).toContain('• note: [withheld: redacted by the ledger (email)]');
    expect(t).not.toContain(H('a'));
    const digest = `sha256:${createHash('sha256').update(canonicalize(call.args)!).digest('hex')}`;
    expect(t).toContain(`Arguments digest ${digest}`); expect(t).toContain('3 fields'); expect(t).toContain('2 withheld'); expect(t).toContain('nothing truncated');
    const argBlock = post.blocks.find((b: any) => b.type === 'section' && b.text.type === 'plain_text');
    expect(argBlock.text).toMatchObject({ type: 'plain_text', emoji: false });
    fake.click(); expect((await p).decision).toBe('approved'); await flush();
    const update = fake.calls.find(c => c.method === 'chat.update')!.body;
    expect(texts(update)).toContain('• target: "prod-db"'); expect(update.blocks.some((b: any) => b.type === 'actions')).toBe(false);
  });
  it('a long value is cut with an explicit truncation statement; newlines and bidi controls cannot fake lines', async () => {
    const long = 'x'.repeat(5000);
    const p = a.requestApproval({ ...call, args: { target: long, spoof: 'ok\n• target: "harmless"‮' } }, policy, channel); await flush();
    const t = texts(fake.posts()[0]!.body);
    expect(t).toContain(`[truncated: ${PREVIEW_VALUE_MAX_CHARS} of ${JSON.stringify(long).length} characters shown]`);
    expect(t).toContain('1 truncated (marked)');
    expect(t).toContain('• spoof: "ok\\n• target: \\"harmless\\"\\u202e"');
    expect(t.split('\n').filter(l => l.startsWith('• target:'))).toHaveLength(1);
    await a.closeSlackApprovals(); expect((await p).decision).toBe('unavailable');
  });
  it('many fields fill several sections within Slack limits; every field is named', async () => {
    const args = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`field${String(i).padStart(3, '0')}`, 'v'.repeat(200)]));
    const p = a.requestApproval({ ...call, args }, policy, channel); await flush();
    const post = fake.posts()[0]!.body;
    expect(post.blocks.length).toBeLessThanOrEqual(SLACK_MESSAGE_MAX_BLOCKS);
    for (const b of post.blocks) if (b.type === 'section') expect(b.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_TEXT_MAX);
    const t = texts(post); for (const k of Object.keys(args)) expect(t).toContain(`• ${k}: `);
    await a.closeSlackApprovals(); await p;
  });
  it('a preview that cannot fit is DENIED without posting anything (recorded by the pipeline), naming the digest', async () => {
    const args = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f${i}`, '&'.repeat(PREVIEW_VALUE_MAX_CHARS)]));
    expect(buildArgsPreview(args).ok).toBe(false);
    const r = await a.requestApproval({ ...call, args }, policy, channel);
    expect(r).toMatchObject({ decision: 'denied', callId: call.callId, channel: 'slack' });
    expect(r.approver).toBeUndefined();
    expect(r.reason).toMatch(/^agent-ledger: approval preview does not fit Slack's limits \(400 fields need \d+ sections; at most 40\); denied without asking \(arguments digest sha256:[0-9a-f]{64}\)$/);
    expect(fake.calls).toHaveLength(0);
    expect(PREVIEW_MAX_ARG_BLOCKS).toBe(40);
  });
  it('no arguments renders an explicit "(no arguments)"', () => {
    const p = buildArgsPreview({}); expect(p.ok && p.blocks[0]).toMatchObject({ text: { text: '(no arguments)' } });
  });
});

describe('ADR-018 §2: per-agent pending approvals', () => {
  it('an identical pending request is denied without a second post; it may be asked again once the first settles', async () => {
    const first = a.requestApproval(call, policy, channel); await flush();
    const dup = await a.requestApproval({ ...call, callId: 'call-2' }, policy, channel);
    expect(dup).toMatchObject({ decision: 'denied', callId: 'call-2' }); expect(dup.reason).toContain('identical approval request (call-1) is already pending');
    expect(fake.posts()).toHaveLength(1);
    fake.click(); expect((await first).decision).toBe('approved');
    const again = a.requestApproval({ ...call, callId: 'call-3' }, policy, channel); await flush();
    expect(fake.posts()).toHaveLength(2);
    await a.closeSlackApprovals(); await again;
  });
  it(`one agent holds at most SLACK_MAX_PENDING_PER_AGENT; another agent is unaffected; settlement frees a slot`, async () => {
    const max = slack.SLACK_MAX_PENDING_PER_AGENT;
    const held = Array.from({ length: max }, (_, i) => a.requestApproval({ ...call, callId: `c${i}`, args: { target: `t${i}` } }, policy, channel));
    await flush();
    const over = await a.requestApproval({ ...call, callId: 'over', args: { target: 'over' } }, policy, channel);
    expect(over).toMatchObject({ decision: 'denied', callId: 'over' }); expect(over.reason).toContain(`${max} approvals already pending for this agent`);
    const other = a.requestApproval({ ...call, agentId: 'fable', callId: 'other' }, policy, channel); await flush();
    expect(fake.posts()).toHaveLength(max + 1);
    await vi.advanceTimersByTimeAsync(channel.timeoutMs);
    expect((await Promise.all(held)).every(r => r.decision === 'timeout')).toBe(true); await other;
    const after = a.requestApproval({ ...call, callId: 'after', args: { target: 'after' } }, policy, channel); await flush();
    expect(fake.posts()).toHaveLength(max + 2);
    await a.closeSlackApprovals(); await after;
  });
});
