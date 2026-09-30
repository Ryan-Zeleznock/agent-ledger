import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { evaluate, loadRegistry, type ToolRegistry } from "../src/policy/contract.js";
import { decide } from "./helpers/registry-eval.js";
import type { ToolCall } from "../src/types/index.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const config = (pattern: string) => ({ version: 1, servers: { s: { trusted: true, tools: { t: {
  class: "write", reviewedBy: "ryan", reviewedAt: "2026-09-30",
  escalateWhen: [{ to: "risky", argPattern: { env: pattern } }],
} } } } });
function file(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "policy-security-")); dirs.push(dir);
  const path = join(dir, "tools.yaml"); writeFileSync(path, stringify(value)); return path;
}
const call = (args: unknown): ToolCall => ({ server: "s", tool: "t", args: args as ToolCall["args"], callId: "c", agentId: "a", sessionId: "s", receivedAt: "2026-09-30T00:00:00Z" });

it("refuses Fable's ReDoS or escalates within 50ms, under a hard child deadline", () => {
  const path = file(config("^(\\w+\\s?)+$"));
  const child = spawnSync(process.execPath, ["--import", "./test/helpers/source-loader.mjs", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { loadRegistry, evaluate } from './src/policy/contract.ts';
    let registry;
    try { registry = await loadRegistry(process.argv[1]); }
    catch (error) { assert.match(error.message, /unsafe regex/); process.exit(0); }
    const start = performance.now();
    const decision = evaluate(registry, { server: 's', tool: 't', args: { env: 'a'.repeat(40) + '!' } });
    assert.equal(decision.risk, 'risky');
    assert.ok(performance.now() - start < 50);
  `, path], { timeout: 2000, killSignal: "SIGKILL", encoding: "utf8" });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
});

it.each(["(a+)+$", "(a|aa)+$", "a+a+$", "(a?){30}a{30}", "(?=a)a", "(a)\\1", "a{999999999}", "(a|aa)".repeat(30) + "$" ])("refuses unsafe regex %s", async pattern => {
  await expect(loadRegistry(file(config(pattern)))).rejects.toThrow(/unsafe regex/);
});
it.each(["^(main|master|release/.*)$", "^[a-z]{1,32}$", "^\\w+$", "^a\\+b$", "[()?+*]", "(?:main|master)"])("accepts supported regex %s", async pattern => {
  await expect(loadRegistry(file(config(pattern)))).resolves.toBeDefined();
});
it("matches structured values without coercion; treats absent/non-object args as empty", async () => {
  const registry = await loadRegistry(file(config("^main$")));
  for (const env of [{ x: "main" }, ["feature", "main"], { toString: 1 }, Object.create(null)]) {
    expect(evaluate(registry, call({ env })).risk).toBe("risky");
    expect(decide(registry, "s", "t", { env })).toEqual(evaluate(registry, call({ env })));
  }
  for (const args of [null, undefined, 1, "main", false]) {
    expect(evaluate(registry, call(args)).risk).toBe("write");
    expect(decide(registry, "s", "t", args as never)).toEqual(evaluate(registry, call(args)));
  }
});
it("counts over-cap text as matched, retaining AND semantics and the boundary", async () => {
  const registry = await loadRegistry(file(config("^main$")));
  for (const length of [1024, 1025, 1000000]) {
    const args = { env: "x".repeat(length) };
    expect(evaluate(registry, call(args)).risk).toBe(length > 1024 ? "risky" : "write");
    expect(decide(registry, "s", "t", args)).toEqual(evaluate(registry, call(args)));
  }
});
it.each(["allow", "constructor", "__proto__"])("unknown hand-built class %s is a full fail-safe decision", cls => {
  const registry = config("main") as ToolRegistry;
  (registry.servers.s!.tools.t! as unknown as { class: string }).class = cls;
  expect(evaluate(registry, call({}))).toMatchObject({ verdict: "require_approval", risk: "unreviewed", ruleId: "unreviewed:s/t", reason: expect.any(String) });
});
it("generated escalation combinations preserve oracle parity, max rank, AND and first tie", async () => {
  for (const base of ["read", "write"] as const) {
    const value = config("^main$");
    const entry = value.servers.s.tools.t;
    entry.class = base;
    entry.escalateWhen = [
      { to: base === "read" ? "write" : "risky", argPattern: { env: "^main$" } },
      { to: "risky", argPattern: { env: "^main$", gate: "^true$" } } as typeof entry.escalateWhen[number],
      { to: "risky", argPattern: { env: "^main$", gate: "^true$" } } as typeof entry.escalateWhen[number],
    ];
    const registry = await loadRegistry(file(value));
    for (const env of [undefined, "main", "dev", {}, [], { toString: 1 }, "x".repeat(1025)]) {
      for (const gate of [undefined, true, false, {}]) {
        const args = { ...(env === undefined ? {} : { env }), ...(gate === undefined ? {} : { gate }) };
        const hit = env !== undefined && env !== "dev";
        const second = hit && gate !== undefined && gate !== false;
        const risk = hit ? (base === "write" || second ? "risky" : "write") : base;
        const index = hit ? (base === "read" && second ? 1 : 0) : undefined;
        const result = evaluate(registry, call(args));
        expect(result).toMatchObject({ risk, ruleId: `registry:s/t${index === undefined ? "" : `#escalate:${index}`}` });
        expect(decide(registry, "s", "t", args)).toEqual(result);
      }
    }
  }
});
