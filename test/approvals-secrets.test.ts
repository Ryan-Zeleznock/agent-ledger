import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SlackChannel } from '../src/approvals/contract.js';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllEnvs(); });
it('reads trimmed private token files and rejects symlinks, public modes, oversize and empty values', async () => {
  vi.resetModules(); const a = await import('../src/approvals/contract.js');
  const dir = mkdtempSync(join(tmpdir(), 'slack-secrets-')); dirs.push(dir);
  const bot = join(dir, 'bot'), app = join(dir, 'app'); writeFileSync(bot, ' xoxb-private\n', { mode: 0o600 }); writeFileSync(app, 'xapp-private', { mode: 0o600 });
  const c: SlackChannel = { kind: 'slack', channelId: 'C0123456789', transport: 'socket-mode', timeoutMs: 1000, approvers: ['U0123456789'], botToken: { kind: 'file', path: bot }, appToken: { kind: 'file', path: app } };
  expect(await a.validateSlackChannel(c)).toEqual([]);
  for (const [name, content, mode] of [['public', 'xoxb-private', 0o644], ['big', 'xoxb-' + 'a'.repeat(4096), 0o600], ['empty', ' ', 0o600], ['wrong', 'xapp-private', 0o600]] as const) {
    const path = join(dir, name); writeFileSync(path, content, { mode }); expect(await a.validateSlackChannel({ ...c, botToken: { kind: 'file', path } })).toEqual(['botToken']);
  }
  symlinkSync(bot, join(dir, 'link')); expect(await a.validateSlackChannel({ ...c, botToken: { kind: 'file', path: join(dir, 'link') } })).toEqual(['botToken']);
  expect(await a.validateSlackChannel({ ...c, botToken: { kind: 'file', path: dir } })).toEqual(['botToken']);
  expect(() => a.configureSlackApprovals({})).toThrow();
});
it('reads environment references and reports only field names for missing secrets', async () => {
  vi.resetModules(); const a = await import('../src/approvals/contract.js'); vi.stubEnv('SLACK_TEST_BOT', 'xoxb-env'); vi.stubEnv('SLACK_TEST_APP', 'xapp-env');
  const c: SlackChannel = { kind: 'slack', channelId: 'C0123456789', transport: 'socket-mode', timeoutMs: 1000, approvers: ['U0123456789'], botToken: { kind: 'env', name: 'SLACK_TEST_BOT' }, appToken: { kind: 'env', name: 'SLACK_TEST_APP' } };
  expect(await a.validateSlackChannel(c)).toEqual([]); vi.stubEnv('SLACK_TEST_BOT', 'reflected-secret'); expect(await a.validateSlackChannel(c)).toEqual(['botToken']);
});
it.each(['https://evil.example/api/', 'http://localhost:1234/api/', 'http://127.0.0.1:1234/other/'])('refuses unsafe API base %s', async apiBaseUrl => {
  vi.resetModules(); const a = await import('../src/approvals/contract.js'); expect(() => a.configureSlackApprovals({ apiBaseUrl })).toThrow();
});
