import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLedger } from "../src/ledger/contract.js";
import { waitFor, exited } from "./helpers/ipc.js";

/**
 * REAL multi-process behaviour (Astra reviews 2026-09-30): separate Node processes, each with its own JsonlLedger,
 * on one file. Only the lock file + O_APPEND + tail re-read stand between them.
 */
const CHILD = resolve(".test-build/test/helpers/ledger-child.js");
const CHILDREN = 4; const PER_CHILD = 100;

let dir: string; let path: string; const live: ChildProcess[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agent-ledger-mp-")); path = join(dir, "ledger.jsonl"); });
afterEach(() => { for (const c of live) { if (c.exitCode === null) c.kill("SIGKILL"); } live.length = 0; rmSync(dir, { recursive: true, force: true }); });

const spawn = (mode: "append" | "hold", prefix: string, count: number, timeoutMs: number) => {
  const c = fork(CHILD, [mode, path, prefix, String(count)], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, AGENT_LEDGER_LOCK_TIMEOUT_MS: String(timeoutMs) } });
  live.push(c);
  return c;
};

describe("createLedger('jsonl') across processes", () => {
  it("compiled child fixture exists (globalSetup built .test-build)", () => {
    expect(existsSync(CHILD)).toBe(true);
  });

  it(`${CHILDREN} processes x ${PER_CHILD} appends released together: ${CHILDREN * PER_CHILD} records, unique ids and parents, chain verifies after reopen`, async () => {
    const children = Array.from({ length: CHILDREN }, (_, i) => spawn("append", `p${i}`, PER_CHILD, 60_000));
    const ready = await Promise.all(children.map((c) => waitFor(c, "ready", 15_000)));
    expect(new Set(ready.map((m) => m.pid)).size).toBe(CHILDREN);
    const donePromises = children.map((c) => waitFor(c, "done", 90_000));
    for (const c of children) c.send({ type: "go" }); // barrier: everyone starts at once
    const done = await Promise.all(donePromises);
    expect(await Promise.all(children.map(exited))).toEqual(Array(CHILDREN).fill(0));

    const all = done.flatMap((m) => m.records!);
    expect(all.length).toBe(CHILDREN * PER_CHILD);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    expect(new Set(all.map((r) => r.prevHash)).size).toBe(all.length);
    expect(new Set(all.map((r) => r.parentRecordId)).size).toBe(all.length);
    expect(all.filter((r) => r.prevHash === "0").length).toBe(1);
    const byHash = new Map(all.map((r) => [r.hash, r]));
    for (const r of all) if (r.prevHash !== "0") expect(byHash.get(r.prevHash)?.id).toBe(r.parentRecordId);

    const reopened = createLedger("jsonl", path);
    expect(await reopened.verify()).toEqual({ ok: true, checked: CHILDREN * PER_CHILD });
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 120_000);

  it("re-review P2: PROVES contention: while writer A holds the lock, B-D are blocked (EEXIST, fail closed, lock untouched); after A releases, all their appends land", async () => {
    const a = spawn("hold", "a", 0, 5_000);
    const others = ["b", "c", "d"].map((p) => spawn("append", p, 20, 400)); // 400 ms lock timeout: they must give up while A holds
    await Promise.all([a, ...others].map((c) => waitFor(c, "ready", 15_000)));

    a.send({ type: "go" });
    const held = await waitFor(a, "held", 10_000);
    expect(existsSync(`${path}.lock`)).toBe(true);

    const blockedPromises = others.map((c) => waitFor(c, "blocked", 15_000));
    for (const c of others) c.send({ type: "go" });
    const blocked = await Promise.all(blockedPromises);
    for (const m of blocked) {
      expect(m.message).toMatch(/lock .*is held by/);
      expect(m.message).toContain(`"${held.pid} `);          // they saw A's lock, not some other error
      expect(m.message).toMatch(/remove the lock file manually/);
      expect(m.appended).toBe(0);
    }
    expect(existsSync(`${path}.lock`)).toBe(true);              // nobody deleted A's lock
    expect(existsSync(path)).toBe(false);                       // and nothing was written

    a.send({ type: "release" });
    await waitFor(a, "released", 10_000);
    expect(await exited(a)).toBe(0);

    const donePromises = others.map((c) => waitFor(c, "done", 60_000));
    for (const c of others) c.send({ type: "go" });
    const done = await Promise.all(donePromises);
    expect(await Promise.all(others.map(exited))).toEqual([0, 0, 0]);
    const all = done.flatMap((m) => m.records!);
    expect(all.length).toBe(60);
    expect(new Set(all.map((r) => r.prevHash)).size).toBe(60);
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: true, checked: 60 });
    expect(existsSync(`${path}.lock`)).toBe(false);
  }, 120_000);
});
