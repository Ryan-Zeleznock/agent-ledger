import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createLedger, type LedgerStore } from "../src/ledger/contract.js";
import { unsealed } from "./helpers/ledger-fixtures.js";
import { pgSkipReason, startPgCluster, type PgCluster } from "./helpers/pg-cluster.js";

const range = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" };
const drain = async (ledger: LedgerStore, r = range) => { const rows = []; for await (const row of ledger.read(r)) rows.push(row); return rows; };
export const closeLedger = async (ledger: LedgerStore) => { if ("close" in ledger) await (ledger as LedgerStore & { close(): Promise<void> }).close(); };

describe.skipIf(!!pgSkipReason)("real Postgres ledger", () => {
  let cluster: PgCluster;
  const stores: LedgerStore[] = [];
  const store = (role = "ledger_app") => { const ledger = createLedger("postgres", cluster.url(role)); stores.push(ledger); return ledger; };
  beforeAll(async () => { cluster = await startPgCluster(); }, 90_000);
  beforeEach(async () => { await cluster.reset(); });
  afterEach(async () => { await Promise.all(stores.splice(0).map(closeLedger)); });
  afterAll(async () => { await cluster?.stop(); }, 30_000);

  it("appends canonical records, rejects duplicate ids, and verifies after pool restart", async () => {
    const ledger = store();
    expect(await ledger.head()).toBe("0");
    const a = await ledger.append(unsealed(1)); const b = await ledger.append(unsealed(2));
    expect(b.prevHash).toBe(a.hash); expect(b.parentRecordId).toBe(a.id);
    await expect(ledger.append(unsealed(1))).rejects.toThrow("ledger.postgres.append");
    expect(await ledger.verify()).toEqual({ ok: true, checked: 2 });
    await closeLedger(ledger); stores.splice(stores.indexOf(ledger), 1);
    const reopened = store();
    expect(await reopened.head()).toBe(b.hash);
    expect(await drain(reopened)).toEqual([a, b]);
    expect(await reopened.verify()).toEqual({ ok: true, checked: 2 });
  });

  it("init SQL can rerun on both an empty and populated database without replacing records or roles", async () => {
    await cluster.migrate();
    const ledger = store(); const record = await ledger.append(unsealed(1));
    await cluster.migrate();
    expect(await drain(ledger)).toEqual([record]);
    expect(await ledger.verify()).toEqual({ ok: true, checked: 1 });
  });

  it.each(["ledger_app", "agent_ledger_test"])("database rejects UPDATE, DELETE and TRUNCATE by %s", async role => {
    await store().append(unsealed(1));
    const pool = new pg.Pool({ connectionString: cluster.url(role) });
    try {
      for (const sql of ["UPDATE ledger.records SET call_id='changed'", "DELETE FROM ledger.records", "TRUNCATE ledger.records"])
        await expect(pool.query(sql)).rejects.toThrow(role === "ledger_app" ? /permission denied/ : /append-only/);
    } finally { await pool.end(); }
  });

  it("reader can verify/read but cannot insert; app cannot disable protection", async () => {
    await store().append(unsealed(1));
    expect(await store("ledger_reader").verify()).toEqual({ ok: true, checked: 1 });
    await expect(store("ledger_reader").append(unsealed(2))).rejects.toThrow("ledger.postgres.append");
    const app = new pg.Pool({ connectionString: cluster.url() });
    try { await expect(app.query("ALTER TABLE ledger.records DISABLE TRIGGER USER")).rejects.toThrow(/owner/); }
    finally { await app.end(); }
  });

  it.each(["line", "written_at", "id", "hash", "prev_hash", "call_id", "phase"])("reports a superuser alteration of middle-row %s", async column => {
    const ledger = store(); for (let i = 1; i <= 3; i++) await ledger.append(unsealed(i));
    const values: Record<string, string> = { line: '{}', written_at: '2030-01-01T00:00:00Z', id: 'edited', hash: 'a'.repeat(64),
      prev_hash: 'f'.repeat(64), call_id: 'edited-call', phase: 'outcome' };
    await cluster.admin.query("ALTER TABLE ledger.records DISABLE TRIGGER USER");
    try { await cluster.admin.query(`UPDATE ledger.records SET ${column}=$1 WHERE seq=2`, [values[column]]); }
    finally { await cluster.admin.query("ALTER TABLE ledger.records ENABLE TRIGGER USER"); }
    expect(await ledger.verify()).toEqual({ ok: false, checked: 2, brokenAt: column === "id" ? "edited" : "rec-2" });
    await expect(drain(ledger)).rejects.toThrow(/ledger.postgres.read/);
  });

  it("refuses a damaged tail without adding a row and wraps all errors without credentials or SQL values", async () => {
    const ledger = store(); await ledger.append(unsealed(1));
    await cluster.admin.query("ALTER TABLE ledger.records DISABLE TRIGGER USER");
    try { await cluster.admin.query("UPDATE ledger.records SET call_id='canary-secret'"); }
    finally { await cluster.admin.query("ALTER TABLE ledger.records ENABLE TRIGGER USER"); }
    await expect(ledger.head()).rejects.toThrow(/^ledger.postgres.head: failed; run verify\(\)$/);
    await expect(ledger.append(unsealed(2))).rejects.toThrow(/^ledger.postgres.append: failed; run verify\(\)$/);
    expect((await cluster.admin.query("SELECT count(*) FROM ledger.records")).rows[0].count).toBe("1");
  });

  it("does not round away a lying sub-millisecond timestamp column", async () => {
    const ledger = store(); await ledger.append(unsealed(1));
    await cluster.admin.query("ALTER TABLE ledger.records DISABLE TRIGGER USER");
    try { await cluster.admin.query("UPDATE ledger.records SET written_at=written_at + interval '1 microsecond'"); }
    finally { await cluster.admin.query("ALTER TABLE ledger.records ENABLE TRIGGER USER"); }
    expect(await ledger.verify()).toEqual({ ok: false, checked: 1, brokenAt: "rec-1" });
    await expect(drain(ledger)).rejects.toThrow("ledger.postgres.read");
  });

  it("crosses the 1000-row keyset page and reads inclusive timestamp boundaries", async () => {
    const ledger = store();
    for (let i = 0; i < 1003; i++) await ledger.append(unsealed(i));
    expect(await ledger.verify()).toEqual({ ok: true, checked: 1003 });
    const rows = await drain(ledger); expect(rows).toHaveLength(1003);
    const boundary = rows[500]!.writtenAt;
    const selected = await drain(ledger, { from: boundary, to: boundary });
    expect(selected).toEqual(rows.filter(row => row.writtenAt === boundary));
    await expect(drain(ledger, { from: "2026-01-01", to: range.to })).rejects.toThrow();
    await expect(drain(ledger, { from: range.to, to: range.from })).rejects.toThrow();
  }, 60_000);
});
