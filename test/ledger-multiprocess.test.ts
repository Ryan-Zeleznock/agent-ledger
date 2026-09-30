import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLedger } from "../src/ledger/contract.js";

/**
 * REAL multi-process contention (Astra review 2026-09-30): four Node processes, each with its own JsonlLedger,
 * append to one file at the same time. Only the lock file + O_APPEND + tail re-read stand between them.
 */
const CHILD = resolve(".test-build/test/helpers/ledger-child.js");
const CHILDREN = 4; const PER_CHILD = 100;

let dir: string; let path: string; const live: ChildProcess[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agent-ledger-mp-")); path = join(dir, "ledger.jsonl"); });
afterEach(() => { for (const c of live) { if (c.exitCode === null) c.kill("SIGKILL"); } live.length = 0; rmSync(dir, { recursive: true, force: true }); });

interface Msg { type: string; pid: number; records?: { id: string; parentRecordId: string | null; prevHash: string; hash: string }[]; message?: string }
const waitFor = (c: ChildProcess, type: string, ms: number) => new Promise<Msg>((res, rej) => {
  const timer = setTimeout(() => rej(new Error(`child ${c.pid} did not send ${type} within ${ms} ms`)), ms);
  const onMsg = (m: Msg) => { if (m.type === type || m.type === "error") { clearTimeout(timer); c.off("message", onMsg); m.type === "error" ? rej(new Error(m.message)) : res(m); } };
  c.on("message", onMsg);
  c.once("exit", (code) => { clearTimeout(timer); rej(new Error(`child ${c.pid} exited early with ${code}`)); });
});
const exited = (c: ChildProcess) => new Promise<number | null>((res) => (c.exitCode !== null ? res(c.exitCode) : c.once("exit", res)));

describe("createLedger('jsonl') across processes", () => {
  it("compiled child fixture exists (globalSetup built .test-build)", () => {
    expect(existsSync(CHILD)).toBe(true);
  });

  it(`${CHILDREN} processes x ${PER_CHILD} appends released together: ${CHILDREN * PER_CHILD} records, unique ids and parents, chain verifies after reopen`, async () => {
    const children = Array.from({ length: CHILDREN }, (_, i) => {
      const c = fork(CHILD, [path, `p${i}`, String(PER_CHILD)], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, AGENT_LEDGER_LOCK_TIMEOUT_MS: "60000" } });
      live.push(c);
      return c;
    });
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
});
