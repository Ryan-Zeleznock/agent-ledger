import type pg from "pg";
import { createRequire } from "node:module";
import type { DateRange, LedgerRecord, UnsealedRecord, VerifyResult } from "../types/index.js";
import type { LedgerStore } from "./contract.js";
import { checkStoredLine, parseStored, sealRecord, sealedLine, verifyLines } from "./chain.js";
import { parseInstant } from "./validate.js";

interface Row {
  seq: string; id: string; hash: string; prev_hash: string; written_ms: string;
  call_id: string; phase: string; line: string;
}
const columns = "seq, id, hash, prev_hash, extract(epoch from written_at) * 1000 AS written_ms, call_id, phase, line";
const failure = (operation: string) => new Error(`ledger.postgres.${operation}: failed; run verify()`);

/** Indexed values are redundant, never an alternative authority for the canonical record. */
function recordOf(row: Row, checkHash = false): LedgerRecord {
  const parsed = parseStored(row.line);
  if (parsed.err !== undefined) throw failure("record");
  const rec = checkHash ? checkStoredLine(row.line) : parsed.rec;
  if (row.id !== rec.id || row.hash !== rec.hash || row.prev_hash !== rec.prevHash ||
      // NUMERIC arrives as text: do not round away a database microsecond at large epoch values.
      row.written_ms.replace(/\.0+$/, "") !== String(parseInstant(rec.writtenAt, "writtenAt")) ||
      row.call_id !== rec.call.callId || row.phase !== rec.phase) throw failure("record");
  return rec;
}

/** One pool per store. No URL, SQL parameters, underlying error, or credentials escape this boundary. */
export class PostgresLedger implements LedgerStore {
  private readonly pool: pg.Pool;
  private closing?: Promise<void>;
  constructor(url: string) {
    try {
      if (typeof url !== "string" || !/^postgres(?:ql)?:\/\//.test(url)) throw failure("connect");
      // Local JSONL CLI invocations do not load the server-mode driver or its transitive dependencies.
      const { Pool } = createRequire(import.meta.url)("pg") as typeof import("pg");
      this.pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 5000,
        statement_timeout: 30_000, idleTimeoutMillis: 1000, allowExitOnIdle: true });
      // Idle connection errors evict that connection. A future operation reconnects or fails through its wrapper.
      this.pool.on("error", () => {});
    } catch { throw failure("connect"); }
  }

  /** Lifecycle hook on the concrete store; the frozen LedgerStore interface remains unchanged. */
  close(): Promise<void> { return this.closing ??= this.pool.end(); }

  async append(record: UnsealedRecord): Promise<LedgerRecord> {
    let client: pg.PoolClient | undefined;
    let discard = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('agent-ledger.records'))");
      const tail = (await client.query<Row>(`SELECT ${columns} FROM ledger.records ORDER BY seq DESC LIMIT 1`)).rows[0];
      const previous = tail ? recordOf(tail, true) : undefined;
      const sealed = sealRecord(record, { id: previous?.id ?? null, hash: previous?.hash ?? "0" });
      const line = sealedLine(sealed);
      await client.query("INSERT INTO ledger.records (id, hash, prev_hash, written_at, call_id, phase, line) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [sealed.id, sealed.hash, sealed.prevHash, sealed.writtenAt, sealed.call.callId, sealed.phase, line]);
      await client.query("COMMIT");
      return sealed;
    } catch {
      if (client) { try { await client.query("ROLLBACK"); } catch { discard = true; } }
      throw failure("append");
    } finally { client?.release(discard); }
  }

  async head(): Promise<string> {
    try {
      const tail = (await this.pool.query<Row>(`SELECT ${columns} FROM ledger.records ORDER BY seq DESC LIMIT 1`)).rows[0];
      return tail ? recordOf(tail, true).hash : "0";
    } catch { throw failure("head"); }
  }

  /** A stable read snapshot, bounded pages and bigint cursor strings (never lossy JS seq numbers). */
  private async *rows(range?: DateRange): AsyncGenerator<Row> {
    let client: pg.PoolClient | undefined;
    let discard = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      let after = "0";
      for (;;) {
        const values = range ? [after, range.from, range.to] : [after];
        const filter = range ? " AND written_at BETWEEN $2 AND $3" : "";
        const page = (await client.query<Row>(`SELECT ${columns} FROM ledger.records WHERE seq > $1${filter} ORDER BY seq LIMIT 1000`, values)).rows;
        for (const row of page) { after = row.seq; yield row; }
        if (page.length < 1000) break;
      }
    } finally {
      // Also runs when the caller stops consuming early, or verification stops at the first broken row.
      if (client) {
        try { await client.query("ROLLBACK"); } catch { discard = true; }
        client.release(discard);
      }
    }
  }

  async verify(): Promise<VerifyResult> {
    const rows = this.rows();
    async function* lines() {
      for await (const row of rows) {
        try { recordOf(row); }
        catch {
          // Feed the shared verifier a shape-invalid record with the indexed id, preserving count/brokenAt.
          yield JSON.stringify({ id: row.id });
          return;
        }
        yield row.line;
      }
    }
    try { return await verifyLines(lines()); }
    catch { throw failure("verify"); }
  }

  async *read(range: DateRange): AsyncIterable<LedgerRecord> {
    try {
      const from = parseInstant(range.from, "range.from"); const to = parseInstant(range.to, "range.to");
      if (from > to) throw failure("read");
      for await (const row of this.rows(range)) yield recordOf(row);
    } catch { throw failure("read"); }
  }
}
