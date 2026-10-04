import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const bin = process.env.AGENT_LEDGER_PG_BIN ?? "/opt/homebrew/bin";
const externalHost = process.env.AGENT_LEDGER_TEST_PG_HOST;
export const pgSkipReason = externalHost || ["initdb", "pg_ctl", "psql"].every(name => existsSync(join(bin, name)))
  ? undefined : `SKIP real Postgres: initdb/pg_ctl/psql absent in ${bin}; set AGENT_LEDGER_PG_BIN`;
if (pgSkipReason) console.warn(pgSkipReason);

/** A fresh database per suite. External mode never stops/reconfigures the coordinator's server. */
export async function startPgCluster() {
  if (pgSkipReason) throw new Error(pgSkipReason);
  if (externalHost !== undefined && !externalHost.startsWith("/")) throw new Error("AGENT_LEDGER_TEST_PG_HOST must be an absolute Unix socket directory");
  // Keep owned sockets below macOS's short Unix-domain socket path limit, regardless of TMPDIR.
  const dir = externalHost ? undefined : mkdtempSync("/tmp/al-pg-");
  const host = externalHost ?? dir!;
  const data = dir ? join(dir, "data") : undefined;
  const adminUser = externalHost ? "postgres" : "agent_ledger_test";
  const database = `al_test_${randomUUID().replaceAll("-", "")}`;
  let databaseCreated = false;
  let started = false;
  const run = (name: string, args: string[]) => execFileSync(join(bin, name), args,
    { timeout: 60_000, stdio: "pipe", env: { ...process.env, LC_ALL: "C", PGCONNECT_TIMEOUT: "5" } });
  const psql = (db: string, args: string[]) => run("psql", ["-X", "-h", host, "-U", adminUser, "-d", db, "-v", "ON_ERROR_STOP=1", ...args]);
  const stopSync = () => {
    try {
      if (databaseCreated) {
        psql("postgres", ["-c", `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`]);
        databaseCreated = false;
      }
    } finally {
      // data/dir exist only for the self-initdb path. Never pg_ctl the external server.
      if (data && (started || existsSync(join(data, "postmaster.pid")))) {
        run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]); started = false;
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  };
  const exit = () => { try { stopSync(); } catch { /* explicit teardown reports errors; exit is the last-resort path */ } };
  process.once("exit", exit);
  const url = (role = "ledger_app", db = database) =>
    `postgresql://${role === "agent_ledger_test" ? adminUser : role}@localhost/${db}?host=${encodeURIComponent(host)}`;
  let admin: pg.Pool | undefined;
  let maintenance: pg.Pool | undefined;
  try {
    if (data && dir) {
      run("initdb", ["-D", data, "--auth=trust", "-U", adminUser, "--encoding=UTF8", "--no-locale"]);
      run("pg_ctl", ["-D", data, "-l", join(dir, "postgres.log"), "-w", "start", "-o", `-k ${dir} -c listen_addresses=''`]);
      started = true;
    }
    databaseCreated = true; // cleanup also covers a CREATE whose client times out after server-side success
    psql("postgres", ["-c", `CREATE DATABASE "${database}"`]);
    maintenance = new pg.Pool({ connectionString: url("agent_ledger_test", "postgres"), max: 1, connectionTimeoutMillis: 5000 });
    const control = maintenance;
    const migrate = async () => {
      const lock = await control.connect();
      try {
        // Roles are server-global. Every suite locks in the SAME maintenance database before running init SQL.
        await lock.query("BEGIN");
        await lock.query("SELECT pg_advisory_xact_lock(hashtext('agent-ledger.test.roles'))");
        psql(database, ["-v", "app_pw=test-app", "-v", "reader_pw=test-reader", "-f", resolve("deploy/sql/001_init.sql")]);
      } finally { try { await lock.query("ROLLBACK"); } finally { lock.release(); } }
    };
    await migrate();
    admin = new pg.Pool({ connectionString: url("agent_ledger_test"), max: 4, connectionTimeoutMillis: 5000 });
    const pool = admin;
    return { url, database, admin: pool, migrate,
      async reset() {
        await pool.query("ALTER TABLE ledger.records DISABLE TRIGGER USER");
        try { await pool.query("TRUNCATE ledger.records RESTART IDENTITY"); }
        finally { await pool.query("ALTER TABLE ledger.records ENABLE ALWAYS TRIGGER records_append_only; ALTER TABLE ledger.records ENABLE ALWAYS TRIGGER records_no_truncate"); }
      },
      async stop() {
        try { await Promise.all([pool.end(), control.end()]); }
        finally { try { stopSync(); } finally { process.off("exit", exit); } }
      },
    };
  } catch (error) {
    // Preserve the setup error if cleanup also fails (for example a sandbox denies socket connections).
    let cleanupError: unknown;
    try { await Promise.all([admin?.end(), maintenance?.end()]); }
    catch (failure) { cleanupError = failure; }
    try { stopSync(); }
    catch (failure) { cleanupError ??= failure; }
    finally { process.off("exit", exit); }
    if (cleanupError !== undefined) throw new AggregateError([error, cleanupError], "Postgres test setup and cleanup failed");
    throw error;
  }
}
export type PgCluster = Awaited<ReturnType<typeof startPgCluster>>;
