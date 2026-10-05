import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type { DateRange, LedgerRecord, UnsealedRecord, VerifyResult } from "../types/index.js";
import type { LedgerStore } from "./contract.js";
import { MAX_LEDGER_LINE_BYTES, MAX_SCALAR_CHARS, parseInstant } from "./validate.js";
import { GENESIS_HASH, checkStoredLine, parseStored, sealRecord, sealedLine, verifyLines, type Tail } from "./chain.js";

/**
 * Append-only JSONL ledger (local mode, spec §3, §5, §9). One record per line, stored in its RFC 8785 form, so the
 * line is byte-for-byte the hash preimage plus the `hash` member.
 *
 * CONCURRENCY (README "Concurrency design"): every append runs (1) behind an in-process promise queue, (2) under an
 * exclusive lock FILE `<path>.lock` created with the `wx` flag (O_CREAT|O_EXCL, atomic per POSIX open()), and (3) as
 * one write(2) on a descriptor opened with `a` (O_APPEND), followed by fsync. Inside the lock the store ALWAYS
 * re-reads and re-validates the file's last record, so a record written by another process becomes our parent and a
 * same-size replacement of the tail is noticed (Astra #9). A lock is never reclaimed automatically (Astra #7): a lock
 * that outlives its holder makes append() fail closed with instructions, because every unlink-by-pathname
 * reclamation races with a fresh holder and can produce a fork.
 */

/** How long append() waits for another holder before failing closed. Env override exists for tests and operators. */
export const LOCK_TIMEOUT_ENV = "AGENT_LEDGER_LOCK_TIMEOUT_MS";
const LOCK_TIMEOUT_DEFAULT_MS = 5_000;
const LOCK_RETRY_MS = 5;
const TAIL_CHUNK = 64 * 1024;
const LOCK_DESCRIBE_BYTES = 256;


const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isErrno = (e: unknown, code: string) => typeof e === "object" && e !== null && (e as { code?: string }).code === code;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function lockTimeoutMs(): number {
  const raw = process.env[LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return LOCK_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 600_000) throw new Error(`ledger: ${LOCK_TIMEOUT_ENV} must be an integer between 1 and 600000, got ${JSON.stringify(raw)}`);
  return n;
}

// ---------- lock file ----------

/**
 * Best-effort description of who holds the lock, for the error message only. Opens without following symlinks and
 * without blocking (a FIFO planted at the lock path must not hang us), reads at most LOCK_DESCRIBE_BYTES from a
 * regular file, and never decides anything from the content (Astra #8).
 */
function describeLock(lockPath: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return "lock path is not a regular file";
    const buf = Buffer.alloc(LOCK_DESCRIBE_BYTES);
    const n = readSync(fd, buf, 0, LOCK_DESCRIBE_BYTES, 0);
    const text = buf.subarray(0, n).toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim();
    return text.length > 0 ? `"${text}"` : "empty lock file";
  } catch (e) {
    return `unreadable lock file (${isErrno(e, "ELOOP") ? "symlink" : message(e)})`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<() => void> {
  const started = performance.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { closeSync(fd); }
      return () => { try { unlinkSync(lockPath); } catch { /* removed by an operator; nothing safe to do */ } };
    } catch (e) {
      if (!isErrno(e, "EEXIST")) throw e;
    }
    if (performance.now() - started >= timeoutMs) {
      throw new Error(
        `ledger: lock ${lockPath} is held by ${describeLock(lockPath)}; waited ${timeoutMs} ms. ` +
        "If that process is gone this is a stale lock: verify the ledger, then remove the lock file manually. " +
        "Automatic stale-lock reclaim is disabled because it can delete a live holder's lock and fork the chain.",
      );
    }
    await sleep(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS);
  }
}

// ---------- file primitives ----------

/** Every operation checks and uses one descriptor. O_NONBLOCK prevents FIFO-open hangs. */
function openData(path: string, write = false, create = false): number | null {
  let fd: number;
  try { fd = openSync(path, (write ? constants.O_RDWR | constants.O_APPEND | (create ? constants.O_CREAT | constants.O_EXCL : 0) : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
  catch (e) { if (!create && isErrno(e, "ENOENT")) return null; throw e; }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("ledger: data must be a regular file");
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}

function appendLine(fd: number, line: string): void {
  const buf = Buffer.from(line, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error("ledger: write made no progress");
    off += n;
  }
  fsyncSync(fd);
}

const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
function endsWithNewline(fd: number, size: number): boolean {
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  return readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a;
}
function readLastLine(fd: number, size: number): string {
  if (!endsWithNewline(fd, size)) throw new Error("ledger: incomplete line; recover manually, never auto-truncate");
  const chunks: Buffer[] = [];
  let cursor = size - 1, total = 0;
  while (cursor > 0) {
    const len = Math.min(TAIL_CHUNK, cursor), b = Buffer.alloc(len);
    if (readSync(fd, b, 0, len, cursor - len) !== len) throw new Error("ledger: file changed during read");
    const nl = b.lastIndexOf(0x0a), part = nl === -1 ? b : b.subarray(nl + 1);
    total += part.length;
    if (total > MAX_LEDGER_LINE_BYTES) throw new Error("ledger: line size limit exceeded");
    chunks.unshift(part);
    if (nl !== -1) break;
    cursor -= len;
  }
  return decode(Buffer.concat(chunks));
}
class LineError extends Error {
  constructor(readonly line: number, message: string) { super(message); }
}
/** Strict reads use LF framing and fatal UTF-8. Only ID recovery skips damaged interior lines. */
function* lines(fd: number, size: number, offset = 0, skipDamaged = false): Generator<{ n: number; raw: string }> {
  let n = 0, length = 0, discarding = false;
  let pieces: Buffer[] = [];
  while (offset < size) {
    const buf = Buffer.alloc(Math.min(TAIL_CHUNK, size - offset));
    if (readSync(fd, buf, 0, buf.length, offset) !== buf.length) throw new LineError(n + 1, "ledger: file changed during read");
    offset += buf.length;
    let start = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(0x0a, start), end = nl === -1 ? buf.length : nl;
      if (!discarding) {
        length += end - start;
        if (length > MAX_LEDGER_LINE_BYTES) {
          if (!skipDamaged) throw new LineError(n + 1, "ledger: line size limit exceeded");
          // ID recovery must continue after an oversized interior line without buffering it.
          pieces = []; length = 0; discarding = true;
        } else pieces.push(buf.subarray(start, end));
      }
      if (nl === -1) break;
      let raw = "";
      if (!discarding) {
        try { raw = decode(Buffer.concat(pieces, length)); }
        catch { if (!skipDamaged) throw new LineError(n + 1, "ledger: invalid UTF-8"); }
      }
      yield { n: ++n, raw };
      pieces = []; length = 0; discarding = false;
      start = nl + 1;
    }
  }
  if (length || discarding) throw new LineError(n + 1, "ledger: incomplete line");
}

// ---------- the store ----------

export class JsonlLedger implements LedgerStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** Ids seen in the file up to `idsOffset` bytes (re-review P2 "append permits duplicate IDs"); refreshed under the lock. */
  private ids: Set<string> | null = null;
  private idsOffset = 0;
  private idsFile = "";

  constructor(private readonly path: string) {
    if (typeof path !== "string" || path.length === 0) throw new Error("ledger: jsonl target must be a file path");
  }

  /** In-process mutex: appends (and head reads) run one at a time, in call order. */
  private serialize<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** The chain tail as the FILE has it right now: last line read, framed, validated and self-hash-checked. */
  private readTail(fd: number, size: number): Tail {
    if (size === 0) return { id: null, hash: GENESIS_HASH };
    const rec = checkStoredLine(readLastLine(fd, size));
    return { id: rec.id, hash: rec.hash };
  }

  /** Incremental ID recovery, bounded per line; earlier damage is skipped, never repaired or hidden from verify. */
  private refreshIds(fd: number, size: number): Set<string> {
    const st = fstatSync(fd), file = `${st.dev}:${st.ino}`;
    if (this.ids === null || size < this.idsOffset || file !== this.idsFile) {
      this.ids = new Set(); this.idsOffset = 0; this.idsFile = file;
    }
    for (const { raw } of lines(fd, size, this.idsOffset, true)) {
      const p = parseStored(raw);
      // Earlier damage remains visible to verify/read but does not stop collecting new evidence.
      // Preserve any recoverable bounded ID, including a shape-invalid record's ID.
      const id = p.err === undefined ? p.rec.id : p.id;
      if (typeof id === "string" && id.length <= MAX_SCALAR_CHARS) this.ids.add(id);
    }
    this.idsOffset = size;
    return this.ids;
  }

  append(record: UnsealedRecord): Promise<LedgerRecord> {
    return this.serialize(async () => {
      const timeoutMs = lockTimeoutMs();
      mkdirSync(dirname(this.path), { recursive: true }); // the lock file lives next to the ledger
      const release = await acquireLock(`${this.path}.lock`, timeoutMs);
      let fd: number | null = null;
      try {
        fd = openData(this.path, true);
        const size = fd === null ? 0 : fstatSync(fd).size;
        const tail = fd === null ? { id: null, hash: GENESIS_HASH } : this.readTail(fd, size);
        const ids = fd === null ? new Set<string>() : this.refreshIds(fd, size);
        const sealed = sealRecord(record, tail);
        if (ids.has(sealed.id)) throw new Error(`ledger.append: duplicate id ${JSON.stringify(sealed.id)}; ids must be unique per ledger (replay or caller bug); nothing was written`);
        const line = sealedLine(sealed);
        if (fd === null) {
          fd = openData(this.path, true, true)!;
          const st = fstatSync(fd);
          this.ids = ids; this.idsFile = `${st.dev}:${st.ino}`;
        }
        appendLine(fd, `${line}\n`);
        ids.add(sealed.id);
        this.idsOffset = fstatSync(fd).size;
        return sealed;
      } finally {
        if (fd !== null) closeSync(fd);
        release();
      }
    });
  }

  head(): Promise<string> {
    return this.serialize(() => {
      const fd = openData(this.path);
      if (fd === null) return GENESIS_HASH;
      try { return this.readTail(fd, fstatSync(fd).size).hash; } finally { closeSync(fd); }
    });
  }

  async verify(): Promise<VerifyResult> {
    const fd = openData(this.path);
    if (fd === null) return { ok: true, checked: 0 };
    try {
      const size = fstatSync(fd).size;
      async function* rawLines() { for (const { raw } of lines(fd!, size)) yield raw; }
      return await verifyLines(rawLines());
    } catch (e) {
      if (e instanceof LineError) return { ok: false, checked: e.line, brokenAt: `line:${e.line}` };
      throw e;
    } finally { closeSync(fd); }
  }

  async *read(range: DateRange): AsyncIterable<LedgerRecord> {
    const from = parseInstant(range.from, "range.from"), to = parseInstant(range.to, "range.to");
    if (from > to) throw new Error("ledger.read: from is after to");
    const fd = openData(this.path);
    if (fd === null) return;
    try {
      const size = fstatSync(fd).size;
      if (!endsWithNewline(fd, size)) throw new Error("ledger.read: incomplete line; run verify()");
      for (const { n, raw } of lines(fd, size)) {
        const p = parseStored(raw);
        if (p.err !== undefined) throw new Error(`ledger.read: invalid record at line ${n} (${p.err}); run verify()`);
        const t = parseInstant(p.rec.writtenAt, "writtenAt");
        if (t >= from && t <= to) yield p.rec;
      }
    } finally { closeSync(fd); }
  }
}
