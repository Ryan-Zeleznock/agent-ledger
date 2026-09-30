import { closeSync, createReadStream, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import canonicalize from "canonicalize";
import type { DateRange, LedgerRecord, UnsealedRecord, VerifyResult } from "../types/index.js";
import type { LedgerStore } from "./contract.js";
import { sha256Jcs } from "./hash.js";
import { redactArgs } from "./redact.js";

/**
 * Append-only JSONL ledger (local mode, spec §3, §5, §9). One record per line, stored in its RFC 8785 form, so the
 * line is byte-for-byte the hash preimage plus the `hash` member.
 *
 * CONCURRENCY (see README "Concurrency"): every append runs (1) behind an in-process promise queue, (2) under an
 * exclusive lock FILE `<path>.lock` created with the `wx` flag (O_CREAT|O_EXCL, atomic per POSIX open()), and (3) as
 * one write(2) on a descriptor opened with `a` (O_APPEND), followed by fsync. Inside the lock the store re-reads the
 * tail of the file whenever its size changed, so a record written by ANOTHER process becomes the parent of ours.
 */

const GENESIS_HASH = "0";
const LOCK_TIMEOUT_MS = 5_000;   // how long append() waits for another holder before failing (fail-closed for the caller)
const LOCK_STALE_MS = 30_000;    // a lock older than this whose pid is gone or unknown is broken
const LOCK_RETRY_MS = 5;
const TAIL_CHUNK = 64 * 1024;
const PHASES = new Set(["intent", "outcome"]);

interface Tail { size: number; id: string | null; hash: string }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isErrno = (e: unknown, code: string) => typeof e === "object" && e !== null && (e as { code?: string }).code === code;

// ---------- lock file ----------

function lockIsStale(lockPath: string): boolean {
  try {
    const st = statSync(lockPath);
    const [pidText] = readFileSync(lockPath, "utf8").split(" ");
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return false; }            // holder is alive (EPERM also means alive)
      catch (e) { if (isErrno(e, "ESRCH")) return true; return false; }
    }
    return Date.now() - st.mtimeMs > LOCK_STALE_MS;
  } catch (e) {
    return isErrno(e, "ENOENT"); // vanished: not stale, just gone; the caller retries
  }
}

async function acquireLock(lockPath: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { closeSync(fd); }
      return () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch (e) {
      if (!isErrno(e, "EEXIST")) throw e;
    }
    if (lockIsStale(lockPath)) { try { unlinkSync(lockPath); } catch { /* raced */ } continue; }
    if (Date.now() >= deadline) throw new Error(`ledger: could not acquire ${lockPath} within ${LOCK_TIMEOUT_MS} ms; another process holds the ledger`);
    await sleep(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS);
  }
}

// ---------- file primitives ----------

/** One O_APPEND write of the whole line, then fsync. A short write is completed in a loop (documented limit). */
function appendLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const buf = Buffer.from(line, "utf8");
  const fd = openSync(path, "a");
  try {
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Reads the last line of `path` backwards in chunks. `complete` is false when the file does not end with "\n". */
function readLastLine(path: string, size: number): { line: string; complete: boolean } {
  const fd = openSync(path, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== 0x0a) return { line: "", complete: false };
    const chunks: Buffer[] = [];
    let cursor = size - 1; // exclusive end of the line's content
    while (cursor > 0) {
      const len = Math.min(TAIL_CHUNK, cursor);
      const b = Buffer.alloc(len);
      readSync(fd, b, 0, len, cursor - len);
      const nl = b.lastIndexOf(0x0a);
      if (nl !== -1) { chunks.unshift(b.subarray(nl + 1)); break; }
      chunks.unshift(b);
      cursor -= len;
    }
    return { line: Buffer.concat(chunks).toString("utf8"), complete: true };
  } finally {
    closeSync(fd);
  }
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch (e) { if (isErrno(e, "ENOENT")) return 0; throw e; }
}

// ---------- sealing ----------

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Explicit field projection (spec §5/§9): nothing that is not a named UnsealedRecord field can reach the file. */
function seal(record: UnsealedRecord, tail: Tail): LedgerRecord {
  if (typeof record.id !== "string" || record.id.length === 0) throw new Error("ledger.append: record.id must be a non-empty string");
  if (!PHASES.has(record.phase)) throw new Error(`ledger.append: unknown phase ${JSON.stringify(record.phase)}`);
  const c = record.call;
  if (!isPlainObject(c) || !isPlainObject(c.args)) throw new Error("ledger.append: record.call.args must be an object");
  if (!isPlainObject(record.policy)) throw new Error("ledger.append: record.policy is required");
  const preimage: Omit<LedgerRecord, "hash"> = {
    id: record.id,
    phase: record.phase,
    call: {
      callId: c.callId, sessionId: c.sessionId, agentId: c.agentId,
      ...(c.onBehalfOf !== undefined && { onBehalfOf: c.onBehalfOf }),
      ...(c.declaredPlan !== undefined && { declaredPlan: c.declaredPlan }),
      server: c.server, tool: c.tool, args: redactArgs(c.args), receivedAt: c.receivedAt,
    },
    policy: record.policy,
    ...(record.approval !== undefined && { approval: record.approval }),
    ...(record.outcome !== undefined && { outcome: record.outcome }),
    ...(record.handoff !== undefined && { handoff: record.handoff }),
    parentRecordId: tail.id,
    prevHash: tail.hash,
    writtenAt: new Date().toISOString(),
  };
  return { ...preimage, hash: sha256Jcs(preimage) };
}

// ---------- the store ----------

export class JsonlLedger implements LedgerStore {
  private queue: Promise<unknown> = Promise.resolve();
  private tail: Tail | null = null;

  constructor(private readonly path: string) {
    if (typeof path !== "string" || path.length === 0) throw new Error("ledger: jsonl target must be a file path");
  }

  /** In-process mutex: appends (and head reads) run one at a time, in call order. */
  private serialize<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** The chain tail as the FILE has it, re-read whenever the size changed since we last looked (another process wrote). */
  private refreshTail(): Tail {
    const size = fileSize(this.path);
    if (size === 0) return (this.tail = { size: 0, id: null, hash: GENESIS_HASH });
    if (this.tail && this.tail.size === size) return this.tail;
    const { line, complete } = readLastLine(this.path, size);
    if (!complete) throw new Error(`ledger: ${this.path} ends with an incomplete line (interrupted write or tampering); refusing to append. Run verify().`);
    let last: unknown;
    try { last = JSON.parse(line); } catch { throw new Error(`ledger: last line of ${this.path} is not JSON; refusing to append. Run verify().`); }
    if (!isPlainObject(last) || typeof last.id !== "string" || typeof last.hash !== "string") {
      throw new Error(`ledger: last record of ${this.path} has no id/hash; refusing to append. Run verify().`);
    }
    return (this.tail = { size, id: last.id, hash: last.hash });
  }

  append(record: UnsealedRecord): Promise<LedgerRecord> {
    return this.serialize(async () => {
      mkdirSync(dirname(this.path), { recursive: true }); // the lock file lives next to the ledger
      const release = await acquireLock(`${this.path}.lock`);
      try {
        const sealed = seal(record, this.refreshTail());
        appendLine(this.path, `${canonicalize(sealed)!}\n`);
        this.tail = { size: fileSize(this.path), id: sealed.id, hash: sealed.hash };
        return sealed;
      } finally {
        release();
      }
    });
  }

  head(): Promise<string> {
    return this.serialize(() => this.refreshTail().hash);
  }

  /** Every stored line, parsed, with its 1-based line number. Throws on a malformed line unless `onBad` handles it. */
  private async *records(): AsyncGenerator<{ n: number; rec: LedgerRecord | null; raw: string }> {
    if (fileSize(this.path) === 0) return;
    const rl = createInterface({ input: createReadStream(this.path, { encoding: "utf8" }), crlfDelay: Infinity });
    let n = 0;
    for await (const raw of rl) {
      n++;
      if (raw.length === 0) continue; // only the trailing newline produces this
      try {
        const rec = JSON.parse(raw) as unknown;
        yield { n, rec: isPlainObject(rec) && typeof rec.hash === "string" ? (rec as unknown as LedgerRecord) : null, raw };
      } catch {
        yield { n, rec: null, raw };
      }
    }
  }

  async verify(): Promise<VerifyResult> {
    let checked = 0;
    let prevId: string | null = null;
    let prevHash = GENESIS_HASH;
    let lastN = 0;
    for await (const { n, rec } of this.records()) {
      checked++; lastN = n;
      if (rec === null) return { ok: false, checked, brokenAt: `line:${n}` };
      const at = typeof rec.id === "string" ? rec.id : `line:${n}`;
      const { hash, ...preimage } = rec;
      if (rec.prevHash !== prevHash || rec.parentRecordId !== prevId) return { ok: false, checked, brokenAt: at };
      if (sha256Jcs(preimage) !== hash) return { ok: false, checked, brokenAt: at };
      prevId = rec.id; prevHash = hash;
    }
    const size = fileSize(this.path);
    if (size > 0 && !readLastLine(this.path, size).complete) return { ok: false, checked, brokenAt: `line:${lastN}` };
    return { ok: true, checked };
  }

  /** Records whose `writtenAt` (the ledger's own clock) lies in [from, to], inclusive, in file order. */
  async *read(range: DateRange): AsyncIterable<LedgerRecord> {
    const from = Date.parse(range.from); const to = Date.parse(range.to);
    if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw new Error(`ledger.read: invalid range ${JSON.stringify(range)}`);
    for await (const { n, rec } of this.records()) {
      if (rec === null) throw new Error(`ledger.read: malformed record at line ${n} of ${this.path}; run verify()`);
      const t = Date.parse(rec.writtenAt);
      if (t >= from && t <= to) yield rec;
    }
  }
}
