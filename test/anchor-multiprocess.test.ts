import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAnchor } from "../src/anchor/contract.js";
import { waitFor, exited } from "./helpers/ipc.js";

const CHILD = resolve(".test-build/test/helpers/anchor-child.js");
let dir: string; let path: string; const live: ChildProcess[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agent-ledger-anchor-mp-")); path = join(dir, "anchor.jsonl"); });
afterEach(() => { for (const c of live) { if (c.exitCode === null) c.kill("SIGKILL"); } live.length = 0; rmSync(dir, { recursive: true, force: true }); });

const spawn = (mode: "write" | "hold", prefix: string, count: number, timeoutMs: number) => {
  const c = fork(CHILD, [mode, path, prefix, String(count)], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, AGENT_LEDGER_LOCK_TIMEOUT_MS: String(timeoutMs) } });
  live.push(c);
  return c;
};
const lines = () => readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);

describe("createAnchor('file') across processes", () => {
  it("4 writers x 25 entries released together: 100 valid lines, every one a complete entry, latest() is one of them", async () => {
    const children = ["a", "b", "c", "d"].map((p) => spawn("write", p, 25, 60_000));
    await Promise.all(children.map((c) => waitFor(c, "ready", 15_000)));
    const done = children.map((c) => waitFor(c, "done", 60_000));
    for (const c of children) c.send({ type: "go" });
    expect((await Promise.all(done)).reduce((n, m) => n + m.written!, 0)).toBe(100);
    expect(await Promise.all(children.map(exited))).toEqual([0, 0, 0, 0]);
    const all = lines();
    expect(all.length).toBe(100);
    for (const l of all) expect(JSON.parse(l)).toMatchObject({ hash: expect.stringMatching(/^[a-d]{64}$/), at: expect.any(String) });
    expect(all.map((l) => JSON.parse(l) as { hash: string })).toContainEqual(await createAnchor("file", path).latest());
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 120_000);

  it("re-review P2: while A holds the anchor lock, B-D writers are blocked and write nothing; after release every write lands", async () => {
    const a = spawn("hold", "a", 0, 5_000);
    const others = ["b", "c", "d"].map((p) => spawn("write", p, 10, 400));
    await Promise.all([a, ...others].map((c) => waitFor(c, "ready", 15_000)));
    a.send({ type: "go" });
    const held = await waitFor(a, "held", 10_000);

    const blocked = others.map((c) => waitFor(c, "blocked", 15_000));
    for (const c of others) c.send({ type: "go" });
    for (const m of await Promise.all(blocked)) {
      expect(m.message).toMatch(/anchor: lock .*is held by/);
      expect(m.message).toContain(`"${held.pid} `);
      expect(m.written).toBe(0);
    }
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.lock`)).toBe(true);

    a.send({ type: "release" });
    await waitFor(a, "released", 10_000);
    const done = others.map((c) => waitFor(c, "done", 60_000));
    for (const c of others) c.send({ type: "go" });
    expect((await Promise.all(done)).reduce((n, m) => n + m.written!, 0)).toBe(30);
    expect(lines().length).toBe(30);
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 120_000);
});
