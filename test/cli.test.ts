import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, type CliDeps } from "../src/cli/main.js";
import { createIdentity } from "../src/identity/contract.js";
import { loadRegistry } from "../src/policy/contract.js";
import type { PipelineDeps } from "../src/pipeline/contract.js";
import type { LedgerStore } from "../src/ledger/contract.js";
import { DEFAULT_DEADLINE_MS, HOOK_TIMEOUT_S } from "../src/hooks/contract.js";
import type { IncomingCall } from "../src/types/index.js";

const dirs: string[] = [];
async function sandbox() { const d = await mkdtemp(join(tmpdir(), "cli-test-")); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
function run(args: string[], overrides: Partial<CliDeps> = {}) {
  let out = "", err = "";
  const result = main(args, { stdout: s => { out += s; }, stderr: s => { err += s; }, ...overrides });
  return { result, output: () => out, error: () => err };
}
async function initialized() { const dir = join(await sandbox(), "local"); expect(await run(["init", "--dir", dir]).result).toBe(0); return dir; }

it("init creates a usable reviewed registry, identity and owner-only random secrets; refuses overwrite", async () => {
  const dir = await initialized(); const key = await readFile(join(dir, "hmac.key")); const cred = await readFile(join(dir, "credential"), "utf8");
  expect(key).toHaveLength(32); expect(cred.trim()).toHaveLength(64);
  for (const name of ["hmac.key", "credential"]) expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "ledger"))).isDirectory()).toBe(true);
  expect(await createIdentity("file", join(dir, "agents.yaml")).resolveAgent({ kind: "local", value: cred.trim() })).toBe("local-agent");
  expect((await loadRegistry(join(dir, "registry.yaml"))).servers["builtin:claude-code"]!.tools.Bash!.class).toBe("risky");
  expect(await run(["init", "--dir", dir]).result).toBe(1); expect(await readFile(join(dir, "hmac.key"))).toEqual(key);
  const other = await initialized(); expect(await readFile(join(other, "hmac.key"))).not.toEqual(key);
});
it("prints only a Claude settings snippet with quoted absolute paths and all three events", async () => {
  const dir = join(await sandbox(), "space ' dollar$ back`tick");
  const r = run(["install-hooks", "--print", "--dir", dir]); expect(await r.result).toBe(0);
  const hooks = JSON.parse(r.output()).hooks;
  const pre = hooks.PreToolUse[0].hooks[0];
  expect(pre.timeout).toBe(HOOK_TIMEOUT_S); expect(pre.command).toContain(`--deadline-ms ${DEFAULT_DEADLINE_MS}`);
  expect(pre.command).toContain("watchdog-main.js"); expect(pre.command).toContain(process.execPath);
  for (const name of ["PostToolUse", "PostToolUseFailure"]) { expect(hooks[name][0].hooks[0].command).not.toContain("watchdog-main"); expect(hooks[name][0].hooks[0].command).toContain("--event post"); }
  expect(r.error()).toBe(""); await expect(stat(dir)).rejects.toThrow();
});
it.each([[], ["wat"], ["install-hooks"], ["init", "--wat"], ["init", "--dir"], ["init", "--dir", "a", "--dir", "b"], ["report", "--from", "bad", "--to", "bad", "--out", "out"]])("rejects invalid arguments %j", async (...values) => {
  const args = values.flat() as string[]; expect(await run(args).result).toBe(2);
});

const incoming: IncomingCall = { callId: "t1", credential: { kind: "local", value: "fake" }, server: "builtin:claude-code", tool: "Bash", args: {}, receivedAt: "2026-09-30T12:00:00.000Z" };
function hookFakes() {
  const event = { session_id: "s1", transcript_path: "t", cwd: "/tmp", hook_event_name: "PreToolUse" as const, tool_name: "Bash", tool_input: {}, tool_use_id: "t1" };
  const decide = vi.fn(async () => ({ callId: "t1", decision: "ask" as const, kind: "decided" as const, reason: "risky" }));
  const recordOutcome = vi.fn(async () => {});
  const createPipeline = vi.fn((_deps: PipelineDeps) => ({ decide, recordOutcome, handle: vi.fn() }));
  const hooks = { parseHookInput: vi.fn(() => event), toIncomingCall: vi.fn<CliDeps["hooks"]["toIncomingCall"]>(() => incoming), toOutcome: vi.fn(() => ({ status: "ok" as const })), formatPreToolUseOutput: vi.fn(() => '{"decision":"ask"}') };
  return { createPipeline, hooks, decide, recordOutcome, event };
}
describe("hook wiring", () => {
  it.each(["claude-code", "codex"])("passes %s, credential, key and hook-ask to decide-only pipeline", async agent => {
    const dir = await initialized(); const f = hookFakes();
    const r = run(["hook", "--agent", agent, "--event", "pre", "--dir", dir], { ...f, stdin: async () => "raw" });
    expect(await r.result).toBe(0); expect(r.output()).toBe('{"decision":"ask"}\n');
    expect(f.hooks.parseHookInput).toHaveBeenCalledWith("raw", agent);
    expect(f.hooks.toIncomingCall.mock.calls[0]![1]).toEqual({ kind: "local", value: (await readFile(join(dir, "credential"), "utf8")).trim() });
    const deps = f.createPipeline.mock.calls[0]![0];
    expect(deps).toHaveProperty("argsHmacKey", await readFile(join(dir, "hmac.key"))); expect(deps.hookAgent).toBe(agent); expect(deps.approvals).toEqual({ kind: "hook-ask" });
    await expect(deps.upstream.execute({ ...incoming, sessionId: "s", agentId: "a" })).rejects.toThrow();
    expect(f.decide).toHaveBeenCalledWith(incoming);
  });
  it.each(["PostToolUse", "PostToolUseFailure"])("records %s without emitting stdout", async name => {
    const dir = await initialized(); const f = hookFakes();
    const hooks = { ...f.hooks, parseHookInput: (() => ({ ...f.event, hook_event_name: name, tool_response: {}, error: "failed" })) as CliDeps["hooks"]["parseHookInput"] };
    const r = run(["hook", "--agent", "claude-code", "--event", "post", "--dir", dir], { ...f, hooks, stdin: async () => "raw" });
    expect(await r.result).toBe(0); expect(r.output()).toBe(""); expect(f.recordOutcome).toHaveBeenCalledWith("t1", { status: "ok" });
  });
  it.each(["pre", "post"])("contains errors safely for %s", async event => {
    const dir = await initialized(); const f = hookFakes();
    f.createPipeline.mockImplementation(() => { throw new Error("secret-canary"); });
    const r = run(["hook", "--agent", "claude-code", "--event", event, "--dir", dir], { ...f, stdin: async () => "raw" });
    expect(await r.result).toBe(event === "post" ? 0 : 1); expect(r.output()).toBe(""); expect(r.error()).not.toContain("secret-canary"); expect(r.error()).not.toBe("");
  });
  it("rejects short or exposed keys before deciding", async () => {
    const dir = await initialized(); const f = hookFakes();
    for (const mode of ["short", "exposed"]) {
      await writeFile(join(dir, "hmac.key"), Buffer.alloc(mode === "short" ? 31 : 32));
      await chmod(join(dir, "hmac.key"), mode === "exposed" ? 0o644 : 0o600);
      expect(await run(["hook", "--agent", "claude-code", "--event", "pre", "--dir", dir], { ...f, stdin: async () => "raw" }).result).toBe(1);
    }
    expect(f.decide).not.toHaveBeenCalled();
  });
});

describe("verify", () => {
  it.each(["missing", "head", "ancestor", "mismatch", "broken"])("reports %s anchor/chain status", async scenario => {
    const dir = await initialized();
    const ledger: LedgerStore = { append: vi.fn(), verify: vi.fn(async () => ({ ok: scenario !== "broken", checked: 2 })), head: async () => "b".repeat(64), async *read() { yield { hash: "a".repeat(64) } as never; } };
    const latest = scenario === "missing" ? null : { hash: (scenario === "head" ? "b" : scenario === "ancestor" ? "a" : "c").repeat(64), at: "2026-09-30T12:00:00.000Z" };
    const r = run(["verify", "--dir", dir], { createLedger: () => ledger, createAnchor: () => ({ latest: async () => latest, write: vi.fn() }) });
    expect(await r.result).toBe(["mismatch", "broken"].includes(scenario) ? 1 : scenario === "missing" ? 3 : 0);
    expect(JSON.parse(r.output()).anchor.status).toBe(scenario === "broken" ? "untrusted" : scenario);
    expect(ledger.verify).toHaveBeenCalled();
  });
});

it("passes the selected range and output directory to the report contract", async () => {
  const dir = await initialized(); const out = join(await sandbox(), "pack");
  const generateReport = vi.fn<CliDeps["generateReport"]>(async ledger => { await ledger.verify(); return { pdfPath: join(out, "report.pdf"), csvPath: join(out, "records.csv") }; });
  const r = run(["report", "--from", "2026-09-30T00:00:00Z", "--to", "2026-09-30T23:59:59Z", "--out", out, "--dir", dir], { generateReport });
  expect(await r.result).toBe(0); expect(generateReport.mock.calls[0]!.slice(1)).toEqual([{ from: "2026-09-30T00:00:00Z", to: "2026-09-30T23:59:59Z" }, out]);
  expect(JSON.parse(r.output()).htmlPath).toBe(join(out, "report.html"));
});
it("provides post-only construction timing and restores the environment", async () => {
  const dir = await initialized(); const f = hookFakes();
  const envName = "AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS";
  const previous = process.env[envName];
  const hooks = { ...f.hooks, parseHookInput: (() => ({ ...f.event, hook_event_name: "PostToolUse", tool_response: {} })) as CliDeps["hooks"]["parseHookInput"] };
  f.createPipeline.mockImplementation(() => {
    expect(Number(process.env[envName])).toBeGreaterThan(Date.now());
    return { decide: f.decide, recordOutcome: f.recordOutcome, handle: vi.fn() };
  });
  expect(await run(["hook", "--agent", "claude-code", "--event", "post", "--dir", dir], { ...f, hooks, stdin: async () => "raw" }).result).toBe(0);
  expect(f.createPipeline).toHaveBeenCalledOnce(); expect(process.env[envName]).toBe(previous);
});
it("reports a broken chain even when its tail cannot be read", async () => {
  const dir = await initialized();
  const ledger: LedgerStore = { append: vi.fn(), verify: vi.fn(async () => ({ ok: false, checked: 0, brokenAt: "line:1" })), head: async () => { throw new Error("bad tail"); }, async *read() {} };
  const r = run(["verify", "--dir", dir], { createLedger: () => ledger, createAnchor: () => ({ latest: async () => null, write: vi.fn() }) });
  expect(await r.result).toBe(1); expect(ledger.verify).toHaveBeenCalledOnce(); expect(JSON.parse(r.output()).chain.brokenAt).toBe("line:1");
});

it.each(["pre", "post"])("rejects a mismatched event for --event %s before pipeline construction", async event => {
  const dir = await initialized(); const f = hookFakes();
  const hooks = { ...f.hooks, parseHookInput: (() => event === "post" ? f.event : { ...f.event, hook_event_name: "PostToolUse", tool_response: {} }) as CliDeps["hooks"]["parseHookInput"] };
  const r = run(["hook", "--agent", "claude-code", "--event", event, "--dir", dir], { ...f, hooks, stdin: async () => "raw" });
  expect(await r.result).toBe(event === "post" ? 0 : 1);
  expect(r.output()).toBe(""); expect(r.error()).not.toBe("");
  expect(f.createPipeline).not.toHaveBeenCalled(); expect(f.recordOutcome).not.toHaveBeenCalled();
});
it.each(["0", "a".repeat(64)])("treats a genesis anchor as missing with head %s", async head => {
  const dir = await initialized();
  const ledger: LedgerStore = { append: vi.fn(), verify: async () => ({ ok: true, checked: head === "0" ? 0 : 1 }), head: async () => head, async *read() {} };
  const r = run(["verify", "--dir", dir], { createLedger: () => ledger, createAnchor: () => ({ latest: async () => ({ hash: "0", at: "2026-09-30T12:00:00Z" }), write: vi.fn() }) });
  expect(await r.result).toBe(3); expect(JSON.parse(r.output()).anchor.status).toBe("missing");
});
it.each(["2026-09-30T24:00:00Z", "2026-02-30T00:00:00Z"])("returns usage for invalid calendar timestamp %s before ledger access", async from => {
  const createLedger = vi.fn<CliDeps["createLedger"]>();
  const r = run(["report", "--from", from, "--to", "2026-10-01T00:00:00Z", "--out", "unused"], { createLedger });
  expect(await r.result).toBe(2); expect(r.error()).toContain("Usage:"); expect(createLedger).not.toHaveBeenCalled();
});
it.each([true, false])("reports the export's actual chain result (ok=%s)", async ok => {
  const dir = await initialized(); const chain = { ok, checked: 7, ...(ok ? {} : { brokenAt: "rec-2" }) };
  const verify = vi.fn(async () => chain);
  const ledger: LedgerStore = { append: vi.fn(), head: async () => "0", verify, async *read() {} };
  const generateReport = vi.fn<CliDeps["generateReport"]>(async store => {
    await store.verify(); return { pdfPath: "pack/report.pdf", csvPath: "pack/records.csv" };
  });
  const r = run(["report", "--dir", dir, "--from", "2026-09-30T00:00:00Z", "--to", "2026-10-01T00:00:00Z", "--out", "pack"], { createLedger: () => ledger, generateReport });
  expect(await r.result).toBe(ok ? 0 : 1); expect(JSON.parse(r.output()).chain).toEqual(chain);
  expect(verify).toHaveBeenCalledOnce();
});
it("places pinned yaml in runtime dependencies and the production lock graph", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  expect(pkg.dependencies.yaml).toBe("2.9.1"); expect(pkg.devDependencies.yaml).toBeUndefined();
  expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
  expect(lock.packages[""].devDependencies).toEqual(pkg.devDependencies);
  expect(lock.packages["node_modules/yaml"].dev).toBeUndefined();
  expect(lock.packages["node_modules/yaml"].version).toBe("2.9.1");
});
