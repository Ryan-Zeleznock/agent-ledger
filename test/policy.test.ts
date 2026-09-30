import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { evaluate, loadRegistry, loadSuggestions, suggestClass, type ToolRegistry } from "../src/policy/contract.js";
import type { ToolCall } from "../src/types/index.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function file(value: unknown, raw = false) {
  const dir = await mkdtemp(join(tmpdir(), "ledger-policy-")); dirs.push(dir);
  const path = join(dir, "config.yaml");
  await writeFile(path, raw ? value as string : stringify(value));
  return path;
}
const row = (extra = {}) => ({ class: "read", reviewedBy: "ryan", reviewedAt: "2026-09-29", ...extra });
const registry = (extra = {}) => ({ version: 1, servers: { github: { trusted: true, tools: { t: row() } } }, ...extra });
const call = (args: Record<string, unknown> = {}): ToolCall => ({ callId: "c", sessionId: "s", agentId: "a", server: "github", tool: "t", args, receivedAt: "2026-09-30T00:00:00Z" });
const withRow = (extra: object) => registry({ servers: { github: { trusted: false, tools: { t: row(extra) } } } });

describe("registry loader", () => {
  it("loads the example using own properties and safe dictionary prototypes", async () => {
    const r = await loadRegistry("policies/tools.example.yaml");
    expect(Object.keys(r.servers)).toHaveLength(3);
    for (const dict of [r.servers, ...Object.values(r.servers).map(s => s.tools)]) {
      expect([null, Object.prototype]).toContain(Object.getPrototypeOf(dict));
      for (const key of Object.keys(dict)) expect(Object.hasOwn(dict, key)).toBe(true);
    }
  });
  it.each([
    null, [], "text", {}, registry({ version: 2 }), registry({ servers: [] }), registry({ extra: true }),
    registry({ servers: { github: { trusted: "yes", tools: {} } } }),
    registry({ servers: { github: { trusted: true, tools: {}, extra: true } } }),
    registry({ servers: { github: { trusted: true, tools: [] } } }),
    withRow({ class: "unreviewed" }), withRow({ reviewedBy: undefined }), withRow({ reviewedAt: undefined }),
    withRow({ reviewedBy: " " }), withRow({ reviewedAt: "yesterday" }), withRow({ reviewedAt: "2026-02-30" }),
    withRow({ reviewedBy: 42 }), withRow({ note: false }), withRow({ unless: "dev" }),
    withRow({ escalateWhen: {} }), withRow({ escalateWhen: [{ to: "risky", argPattern: {}, extra: true }] }),
    withRow({ escalateWhen: [{ to: "risky" }] }),
    withRow({ escalateWhen: [{ to: "risky", argPattern: { env: 3 } }] }),
    withRow({ escalateWhen: [{ to: "risky", argPattern: { env: "[" } }] }),
    registry({ proxy: null }), registry({ proxy: { extra: true } }), registry({ proxy: { codex: {} } }),
    registry({ proxy: { codex: { serverName: "agentledger_proxy_1234", extra: true } } }),
  ])("rejects malformed or unknown configuration %#", async value => {
    await expect(loadRegistry(await file(value))).rejects.toThrow();
  });
  it.each(["__proto__", "constructor", "prototype", ...Object.getOwnPropertyNames(Object.prototype)])("refuses reserved server/tool %s", async key => {
    for (const value of [registry({ servers: { [key]: { trusted: true, tools: {} } } }), registry({ servers: { s: { trusted: true, tools: { [key]: row() } } } })]) {
      await expect(loadRegistry(await file(value))).rejects.toThrow(/reserved/);
    }
  });
  it.each(["claude-code", "Claude_Code", "builtin_claude-code", "builtin-claude-code", "Builtin:claude-code", "codex", "CODEX", "builtin_codex", "Builtin:codex", "builtin:cursor", "a.b", "x/y", "my server", "", "é"])("refuses impersonating/invalid server %s", async key => {
    await expect(loadRegistry(await file(registry({ servers: { [key]: { trusted: false, tools: {} } } })))).rejects.toThrow();
  });
  it.each(["builtin:claude-code", "builtin:codex", "claude-code-helper", "codex-helper", "a_b-c9"])("accepts server %s", async key => {
    const r = await loadRegistry(await file(registry({ servers: { [key]: { trusted: false, tools: {} } } })));
    expect(Object.hasOwn(r.servers, key)).toBe(true);
  });
  it("refuses case twins at either dictionary level", async () => {
    for (const value of [registry({ servers: { github: { trusted: false, tools: {} }, GitHub: { trusted: false, tools: {} } } }), registry({ servers: { s: { trusted: false, tools: { Read: row(), read: row() } } } })]) {
      await expect(loadRegistry(await file(value))).rejects.toThrow(/case/);
    }
  });
  it.each([["write", "write"], ["risky", "write"], ["risky", "risky"], ["read", "read"], ["read", "bogus"]])("refuses escalation %s to %s", async (base, to) => {
    await expect(loadRegistry(await file(withRow({ class: base, escalateWhen: [{ argPattern: { branch: "main" }, to }] })))).rejects.toThrow();
  });
  it.each([["read", "write"], ["read", "risky"], ["write", "risky"]])("accepts escalation %s to %s", async (base, to) => {
    await expect(loadRegistry(await file(withRow({ class: base, escalateWhen: [{ argPattern: { branch: "main" }, to }] })))).resolves.toBeDefined();
  });
  it.each([
    'version: 1\nversion: 1\nservers: {}',
    'version: 1\nservers: {s: {trusted: true, tools: {t: {}, t: {}}}}',
    'version: 1\nservers: {s: {}, s: {}}',
    'version: 1\nservers: {1: {trusted: true, tools: {}}}',
    'version: 1\nservers: {}\n---\nversion: 1',
    'version: 1\nservers: !unknown {}',
  ])("refuses duplicate, non-string keys and ambiguous YAML %#", async raw => {
    await expect(loadRegistry(await file(raw, true))).rejects.toThrow();
  });
  it("pins yaml duplicate-key and nested mapAsMap/__proto__ behavior", () => {
    expect(() => parse('x: 1\nx: 2', { mapAsMap: true })).toThrow(/unique/);
    const m = parse('servers: {__proto__: {polluted: true}}', { mapAsMap: true });
    expect(m).toBeInstanceOf(Map);
    expect(m.get("servers")).toBeInstanceOf(Map);
    expect(m.get("servers").get("__proto__").get("polluted")).toBe(true);
    const plain = parse('__proto__: {polluted: true}');
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(Object.hasOwn(plain, "__proto__")).toBe(true);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
  it.each(["proxy", "123456789012345", "_agentledger_proxy_1234", "agentledger_proxy_1234_", "agentledger-proxy-1234", "agentledger:proxy:1234", "agentledger__proxy_1234", "a__b", "builtin_claude_code", "builtin_codex", "", 123])("refuses proxy name %s", async serverName => {
    await expect(loadRegistry(await file(registry({ proxy: { codex: { serverName } } })))).rejects.toThrow(/serverName/);
  });
  it.each(["1234567890123456", "agentledger_proxy_7f3a9c2e1b"])("accepts proxy name %s", async serverName => {
    await expect(loadRegistry(await file(registry({ proxy: { codex: { serverName } } })))).resolves.toMatchObject({ proxy: { codex: { serverName } } });
  });
  it("refuses case-insensitive proxy/upstream collision", async () => {
    await expect(loadRegistry(await file(registry({ servers: { agentledger_proxy_1234: { trusted: false, tools: {} } }, proxy: { codex: { serverName: "AgentLedger_proxy_1234" } } })))).rejects.toThrow(/upstream/);
  });
});

describe("real evaluation", () => {
  it("requires all own args, matches case insensitively using String, and never lowers", async () => {
    const r = await loadRegistry(await file(withRow({ escalateWhen: [
      { argPattern: { env: "^prod$", count: "^2$" }, to: "write" },
      { argPattern: { env: "^prod$", destructive: "^true$" }, to: "risky" },
      { argPattern: { env: "prod" }, to: "write" },
    ] })));
    for (const args of [{ env: "dev", count: 2 }, {}, Object.create({ env: "prod", count: 2 })]) expect(evaluate(r, call(args)).risk).toBe("read");
    expect(evaluate(r, call({ env: "PROD", count: 2 }))).toMatchObject({ risk: "write", ruleId: "registry:github/t#escalate:0" });
    expect(evaluate(r, call({ env: "PROD", count: 2, destructive: true }))).toMatchObject({ risk: "risky", ruleId: "registry:github/t#escalate:1" });
  });
  it("supports prototype-named arg patterns without inherited matches", async () => {
    const r = await loadRegistry(await file(withRow({ escalateWhen: [{ argPattern: { ["__proto__"]: "^yes$", constructor: "yes" }, to: "risky" }] })));
    expect(evaluate(r, call({})).risk).toBe("read");
    expect(evaluate(r, call(JSON.parse('{"__proto__":"YES","constructor":"yes"}'))).risk).toBe("risky");
  });
  it("ignores inherited server and tool rows on manually constructed registries", () => {
    const s = { trusted: true, tools: { t: row() } };
    for (const r of [registry({ servers: Object.create({ github: s }) }), registry({ servers: { github: { ...s, tools: Object.create(s.tools) } } })]) {
      expect(evaluate(r as ToolRegistry, call())).toMatchObject({ risk: "unreviewed", verdict: "require_approval" });
    }
  });
  it("trusted never grants authority to an unreviewed tool", async () => {
    const r = await loadRegistry("policies/tools.example.yaml");
    for (const trusted of [true, false]) {
      r.servers.github!.trusted = trusted;
      expect(evaluate(r, call())).toMatchObject({ risk: "unreviewed", verdict: "require_approval" });
    }
  });
});

describe("suggestions are advice", () => {
  it.each([
    [false, "list_items", { destructiveHint: true }, "read", ["name-pattern"]],
    [false, "frobnicate", { readOnlyHint: true }, "risky", []],
    [true, "list_items", { destructiveHint: true }, "risky", ["name-pattern", "annotation"]],
    [true, "delete_items", { readOnlyHint: true }, "risky", ["name-pattern", "annotation"]],
    [true, "list_items", { readOnlyHint: true }, "read", ["name-pattern", "annotation"]],
    [true, "frobnicate", { readOnlyHint: true }, "read", ["annotation"]],
    [true, "frobnicate", {}, "risky", ["annotation"]],
    [true, "frobnicate", { destructiveHint: false }, "write", ["annotation"]],
    [true, "frobnicate", { readOnlyHint: false }, "risky", ["annotation"]],
    [true, "frobnicate", undefined, "risky", []],
    [true, "frobnicate", { readOnlyHint: true, destructiveHint: true }, "risky", ["annotation"]],
  ] as const)("combines hints %#", async (serverTrusted, name, annotations, cls, sources) => {
    const rules = await loadSuggestions("policies/suggestions.yaml");
    expect(suggestClass({ server: "s", name, annotations }, { rules, serverTrusted })).toMatchObject({ class: cls, sources: [...sources] });
  });
  it("uses the first case-insensitive pattern and explains both sources", async () => {
    const rules = await loadSuggestions("policies/suggestions.yaml");
    const suggestion = suggestClass({ server: "s", name: "LIST_items", annotations: { destructiveHint: true } }, { rules, serverTrusted: true });
    expect(suggestion.reason).toContain("Read-only prefix");
    expect(suggestion.reason).toMatch(/destructiveHint/);
    rules.rules = [{ id: "first", tool: "items", class: "read", reason: "first" }, { id: "second", tool: ".*", class: "risky", reason: "second" }];
    expect(suggestClass({ server: "s", name: "ITEMS" }, { rules, serverTrusted: false })).toEqual({ class: "read", sources: ["name-pattern"], reason: "first" });
  });
  it("never writes or changes authority, and suggestions lack required human review", async () => {
    const path = await file(registry()); const before = await readFile(path, "utf8");
    const r = await loadRegistry(path); const snapshot = structuredClone(r);
    const rules = await loadSuggestions("policies/suggestions.yaml");
    const advice = suggestClass({ server: "github", name: "list_new" }, { rules, serverTrusted: true });
    expect(advice.class).toBe("read");
    expect(evaluate(r, { ...call(), tool: "list_new" }).risk).toBe("unreviewed");
    expect(r).toEqual(snapshot); expect(await readFile(path, "utf8")).toBe(before);
    await expect(loadRegistry(await file(registry({ servers: { github: { trusted: true, tools: { list_new: { class: advice.class } } } } })))).rejects.toThrow();
  });
  it.each([
    {}, { version: 2, default: { class: "risky", reason: "default" }, rules: [] },
    { version: 1, default: { class: "allow", reason: "x" }, rules: [] },
    { version: 1, default: { class: "risky", reason: "x", extra: true }, rules: [] },
    { version: 1, default: { class: "risky", reason: "x" }, rules: [{ id: "x", tool: "[", class: "read", reason: "x" }] },
    { version: 1, default: { class: "risky", reason: "x" }, rules: [{ id: "x", tool: "x", class: "read", reason: "x", verdict: "allow" }] },
    { version: 1, default: { class: "risky", reason: "x" }, rules: [1] },
    { version: 1, default: { class: "risky", reason: "x" }, rules: [0, 1].map(() => ({ id: "same", tool: "x", class: "read", reason: "x" })) },
  ])("refuses malformed suggestion rules %#", async value => {
    await expect(loadSuggestions(await file(value))).rejects.toThrow();
  });
});
