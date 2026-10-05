import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadRegistry, type ToolRegistry } from "../src/policy/contract.js";
import { createIdentity } from "../src/identity/contract.js";
import { validate } from "./helpers/registry-eval.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true })); });
const row = (extra = {}) => ({ class: "read", reviewedBy: "ryan", reviewedAt: "2026-09-30", ...extra });
const registry = (tools: object = { t: row() }) => ({ version: 1, servers: { s: { trusted: true, tools } } });
const agent = (id: string, hash = "a") => ({ id, credential: { kind: "local", sha256: hash.repeat(64) } });
const agents = { version: 1, agents: [agent("astra")] };
function file(value: unknown, raw = false) {
  const dir = fs.mkdtempSync(join(tmpdir(), "config-hardening-")); dirs.push(dir);
  const path = join(dir, "config.yaml"); fs.writeFileSync(path, raw ? value as string : stringify(value)); return path;
}

it.each(["Rеad", "Read ", " Read", "Re\u200bad", "a\0b", "a/b", "a#b", "café", "x".repeat(129)])("refuses non-ASCII/ambiguous tool key %s", async key => {
  await expect(loadRegistry(file(registry({ [key]: row() })))).rejects.toThrow();
  expect(validate(registry({ [key]: row() }) as ToolRegistry).length).toBeGreaterThan(0);
});
it.each([["café", "cafe\u0301"], ["Read", "Ｒｅａｄ"]])("detects NFKC twins %s %s", async (a, b) => {
  await expect(loadRegistry(file(registry({ [a]: row(), [b]: row() })))).rejects.toThrow(/twin|case/);
});
it.each(["a.b-c_d", "a".repeat(128)])("accepts ASCII tool key %s", async key => {
  await expect(loadRegistry(file(registry({ [key]: row() })))).resolves.toBeDefined();
});
it.each([
  "agentledger-proxy-7f3a9c2e1b04", "agentledger_proxy_7f3a9c2e1b04_", "AgentLedger_Proxy_7f3a9c2e1b04--",
  "agentledger_proxy_7f3a9c2e1b04--foo", "agentledger_proxy_7f3a9c2e1b04-_foo", "agentledger_proxy_7f3a9c2e1b04_-foo",
  "AgentLedger-Proxy-7f3a9c2e1b04--foo",
])("refuses sanitized proxy/upstream twin %s", async upstream => {
  const value = { version: 1, servers: { [upstream]: { trusted: true, tools: {} } }, proxy: { codex: { serverName: "agentledger_proxy_7f3a9c2e1b04" } } };
  await expect(loadRegistry(file(value))).rejects.toThrow(/upstream/);
  expect(validate(value as ToolRegistry)).toEqual(expect.arrayContaining([expect.stringMatching(/upstream/)]));
});
it.each(["agentledger_proxy_7f3a9c2e1b04-foo", "other--agentledger_proxy_7f3a9c2e1b04"])("accepts a distinct hook-visible upstream %s", async upstream => {
  const value = { version: 1, servers: { [upstream]: { trusted: true, tools: {} } }, proxy: { codex: { serverName: "agentledger_proxy_7f3a9c2e1b04" } } };
  await expect(loadRegistry(file(value))).resolves.toBeDefined();
  expect(validate(value as ToolRegistry)).toEqual([]);
});
it.each(["0x1", "1.0", "+1", "01", "1e0", '"1"', "true"])("requires literal version 1 in both files: %s", async version => {
  await expect(loadRegistry(file(`version: ${version}\nservers: {}`, true))).rejects.toThrow(/version/);
  expect(() => createIdentity("file", file(`version: ${version}\nagents: []`, true))).toThrow();
});
it.skipIf(process.platform === "win32").each([0o666, 0o664, 0o646])("refuses writable mode %s for both loaders", async mode => {
  const policy = file(registry()), identity = file(agents);
  fs.chmodSync(policy, mode); fs.chmodSync(identity, mode);
  await expect(loadRegistry(policy)).rejects.toThrow(/permissions/);
  expect(() => createIdentity("file", identity)).toThrow(/permissions/);
});
it.skipIf(process.platform === "win32")("refuses a different owner for both loaders (mocked stat uid)", async () => {
  const policy = file(registry()), identity = file(agents);
  const stat = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof stat>) => Object.assign(stat(...args), { uid: process.getuid!() + 1 })) as typeof stat);
  await expect(loadRegistry(policy)).rejects.toThrow(/permissions/);
  expect(() => createIdentity("file", identity)).toThrow(/permissions/);
});
it.each([0o600, 0o644])("accepts owner-writable configuration %s", async mode => {
  const policy = file(registry()), identity = file(agents);
  fs.chmodSync(policy, mode); fs.chmodSync(identity, mode);
  await expect(loadRegistry(policy)).resolves.toBeDefined();
  expect(() => createIdentity("file", identity)).not.toThrow();
});
it("refuses case-twin agent ids", () => {
  expect(() => createIdentity("file", file({ version: 1, agents: [agent("astra"), agent("Astra", "b")] }))).toThrow();
});
it.each(["", "аstra", "astra\u200b", "astra\u200d", "astra\ufeff", "astra ", "astra\n", "as\tra", "ast\0ra", "a/b", "a".repeat(65)])("refuses invalid agent id %j", id => {
  expect(() => createIdentity("file", file({ version: 1, agents: [agent(id)] }))).toThrow(/Invalid identity registry/);
});
it.each(["a", "Astra_9.prod-worker", "a".repeat(64)])("accepts ASCII agent id %s", async id => {
  const identity = createIdentity("file", file({ version: 1, agents: [agent(id)] }));
  await expect(identity.startSession(id)).resolves.toEqual(expect.any(String));
});
it.each([{}, { branch: "" }])("refuses empty escalation patterns %j in loader and oracle", async argPattern => {
  const value = registry({ t: row({ escalateWhen: [{ to: "risky", argPattern }] }) });
  expect.soft(validate(value as ToolRegistry).length).toBeGreaterThan(0);
  await expect(loadRegistry(file(value))).rejects.toThrow(/non-empty/);
});
it("caps attribution at 256 code units", async () => {
  const identity = createIdentity("file", file(agents));
  await expect(identity.startSession("astra", "a".repeat(256))).resolves.toEqual(expect.any(String));
  await expect(identity.startSession("astra", "a".repeat(257))).rejects.toThrow(/onBehalfOf/);
});
it("100k sessions retain less than 5 MB after GC in a supervised child", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--import", "./test/helpers/source-loader.mjs", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { createIdentity } from './src/identity/contract.ts';
    const identity = createIdentity('file', process.argv[1]);
    for (let i = 0; i < 1000; i++) await identity.startSession('astra');
    global.gc(); const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100000; i++) await identity.startSession('astra', 'ryan');
    global.gc(); const growth = process.memoryUsage().heapUsed - before;
    assert.ok(growth < 5 * 1024 * 1024, 'retained bytes: ' + growth);
    await identity.startSession('astra'); // keep the service live across GC
  `, file(agents)], { timeout: 5000, killSignal: "SIGKILL", encoding: "utf8" });
  expect(child.error, child.stderr).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
});
it("generated malformed schema cases have identical loader/oracle acceptance", async () => {
  const cases: unknown[] = [null, [], {}, registry(), { ...registry(), unknown: true },
    { ...registry(), servers: { s: { trusted: "true", tools: {} } } },
    { ...registry(), servers: { s: { trusted: true, tools: {}, extra: 1 } } },
    { ...registry(), proxy: null }, { ...registry(), proxy: { extra: 1 } },
    { ...registry(), proxy: { codex: { serverName: "agentledger_proxy_1234", extra: 1 } } },
  ];
  for (const [field, values] of Object.entries({
    class: ["allow", null, "write"], reviewedBy: ["", " ", 2, "ryan"],
    reviewedAt: ["yesterday", "2026-02-30", "2026-09-30", 1], note: [false, ""],
    extra: [true], escalateWhen: [null, {}, [null], [{ to: "write", argPattern: {} }], [{ to: "write", argPattern: {}, extra: true }]],
  })) for (const value of values) cases.push(registry({ t: row({ [field]: value }) }));
  for (const pattern of ["[", "(a+)+$", 1, "^main$"]) cases.push(registry({ t: row({ escalateWhen: [{ to: "risky", argPattern: { env: pattern } }] }) }));
  for (const value of cases) {
    const accepted = await loadRegistry(file(value)).then(() => true, () => false);
    expect(validate(value as ToolRegistry).length === 0, JSON.stringify(value)).toBe(accepted);
  }
});
