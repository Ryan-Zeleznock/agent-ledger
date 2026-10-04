import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createLedger } from "../../src/ledger/contract.js";
import { waitFor, exited } from "../helpers/ipc.js";
import { pgSkipReason, startPgCluster, type PgCluster } from "../helpers/pg-cluster.js";

describe.skipIf(!!pgSkipReason)("Postgres real-process serialization", () => {
  let cluster: PgCluster;
  const children: ChildProcess[] = [];
  beforeAll(async () => { cluster = await startPgCluster(); }, 90_000);
  beforeEach(async () => { await cluster.reset(); });
  afterEach(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    await Promise.all(children.splice(0).map(c => c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : exited(c)));
  });
  afterAll(async () => { await cluster?.stop(); }, 30_000);
  const spawn = (prefix: string, count: number) => {
    const child = fork(resolve(".test-build/test/helpers/ledger-child.js"), ["append", cluster.url(), prefix, String(count)],
      { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.push(child); return child;
  };
  it("four processes append 100 records each with unique parents and a valid reopened chain", async () => {
    const writers = Array.from({ length: 4 }, (_, i) => spawn(`pg-${i}`, 100));
    await Promise.all(writers.map(c => waitFor(c, "ready", 15_000)));
    const pending = writers.map(c => waitFor(c, "done", 90_000));
    for (const child of writers) child.send({ type: "go" });
    const all = (await Promise.all(pending)).flatMap(m => m.records!);
    expect(await Promise.all(writers.map(exited))).toEqual([0, 0, 0, 0]);
    expect(all).toHaveLength(400);
    expect(new Set(all.map(r => r.id)).size).toBe(400);
    expect(new Set(all.map(r => r.prevHash)).size).toBe(400);
    expect(new Set(all.map(r => r.parentRecordId)).size).toBe(400);
    const ledger = createLedger("postgres", cluster.url());
    try { expect(await ledger.verify()).toEqual({ ok: true, checked: 400 }); }
    finally { if ("close" in ledger) await (ledger as { close(): Promise<void> }).close(); }
  }, 120_000);

  it("a held advisory transaction lock blocks a real writer until release", async () => {
    const holder = await cluster.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('agent-ledger.records'))");
      const writer = spawn("blocked", 1);
      await waitFor(writer, "ready", 15_000);
      const done = waitFor(writer, "done", 30_000);
      writer.send({ type: "go" });
      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const locks = await cluster.admin.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
        if (locks.rowCount) { waiting = true; break; }
        await new Promise(r => setTimeout(r, 25));
      }
      expect(waiting).toBe(true);
      expect((await cluster.admin.query("SELECT count(*) FROM ledger.records")).rows[0].count).toBe("0");
      await holder.query("COMMIT");
      expect((await done).records).toHaveLength(1);
      expect(await exited(writer)).toBe(0);
    } finally { await holder.query("ROLLBACK"); holder.release(); }
  }, 45_000);
});
