import { closeSync, constants, createReadStream, fstatSync, fsyncSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import canonicalize from "canonicalize";
import type { DateRange, LedgerRecord, UnsealedRecord, VerifyResult } from "../types/index.js";
import type { LedgerStore } from "./contract.js";
import { sha256Jcs } from "./hash.js";
import { redactArgs } from "./redact.js";
import { assertJsonData, parseInstant, projectStored, projectUnsealed } from "./validate.js";

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

const GENESIS_HASH = "0";
/** How long append() waits for another holder before failing closed. Env override exists for tests and operators. */
export const LOCK_TIMEOUT_ENV = "AGENT_LEDGER_LOCK_TIMEOUT_MS";
const LOCK_TIMEOUT_DEFAULT_MS = 5_000;
const LOCK_RETRY_MS = 5;
const TAIL_CHUNK = 64 * 1024;
const LOCK_DESCRIBE_BYTES = 256;

interface Tail { id: string | null; hash: string }

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

/** One O_APPEND write of the whole line, then fsync. A short write is continued; a zero-progress write is an error. */
function appendLine(path: string, line: string): void {
  const buf = Buffer.from(line, "utf8");
  const fd = openSync(path, "a");
  try {
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (n <= 0) throw new Error(`ledger: write to ${path} made no progress after ${off} of ${buf.length} bytes`);
      off += n;
    }
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

const endsWithNewline = (path: string, size: number) => size === 0 || readLastLine(path, size).complete;

/** Parses and strictly validates one stored line; returns the record or the reason it is not one. */
function parseStored(raw: string): { rec: LedgerRecord; err?: undefined } | { rec?: undefined; err: string; id?: string } {
  if (raw.length === 0) return { err: "blank line" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { err: "not JSON" }; }
  const id = typeof parsed === "object" && parsed !== null && typeof (parsed as { id?: unknown }).id === "string" ? (parsed as { id: string }).id : undefined;
  try { return { rec: projectStored(parsed) }; } catch (e) { return { err: message(e), ...(id !== undefined && { id }) }; }
}

// ---------- sealing ----------

/**
 * Validate + project (nothing unnamed survives), redact args, re-validate the REDACTED args against the storage limits
 * (redaction can expand text: `a@b.co` → `[REDACTED:email]`; a record the store could not read back must never be
 * written; re-review P1 "successful append can disable subsequent appends"), then seal.
 */
function seal(record: UnsealedRecord, tail: Tail): LedgerRecord {
  const u = projectUnsealed(record);
  const args = redactArgs(u.call.args);
  try { assertJsonData(args, "record.call.args"); } catch (e) { throw new Error(`ledger.append: after redaction, ${message(e).replace(/^ledger: /, "")}; nothing was written`); }
  const preimage: Omit<LedgerRecord, "hash"> = {
    ...u,
    call: { ...u.call, args },
    parentRecordId: tail.id,
    prevHash: tail.hash,
    writtenAt: new Date().toISOString(),
  };
  return { ...preimage, hash: sha256Jcs(preimage) };
}

// ---------- the store ----------

export class JsonlLedger implements LedgerStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** Ids seen in the file up to `idsOffset` bytes (re-review P2 "append permits duplicate IDs"); refreshed under the lock. */
  private ids: Set<string> | null = null;
  private idsOffset = 0;

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
  private readTail(): Tail {
    const size = fileSize(this.path);
    if (size === 0) return { id: null, hash: GENESIS_HASH };
    const { line, complete } = readLastLine(this.path, size);
    if (!complete) throw new Error(`ledger: ${this.path} ends with an incomplete line (interrupted write or tampering); refusing to append. Run verify() and recover manually; never auto-truncate.`);
    const p = parseStored(line);
    if (p.err !== undefined) throw new Error(`ledger: last record of ${this.path} is invalid (${p.err}); refusing to append. Run verify().`);
    const { hash, ...preimage } = p.rec;
    if (sha256Jcs(preimage) !== hash) throw new Error(`ledger: last record of ${this.path} fails its own hash; refusing to append. Run verify().`);
    return { id: p.rec.id, hash };
  }

  /**
   * Brings the id index up to `size` by reading only the bytes appended since the last refresh (amortised linear over
   * the ledger's life). Called under the lock, after `readTail()` proved the file ends with "\n", so `size` is a line
   * boundary. A shrunken file (rewritten) triggers a full rescan. Malformed lines are skipped here; verify() reports them.
   */
  private refreshIds(size: number): Set<string> {
    if (this.ids === null || size < this.idsOffset) { this.ids = new Set(); this.idsOffset = 0; }
    if (size > this.idsOffset) {
      const fd = openSync(this.path, "r");
      const buf = Buffer.alloc(size - this.idsOffset);
      try { readSync(fd, buf, 0, buf.length, this.idsOffset); } finally { closeSync(fd); }
      for (const line of buf.toString("utf8").split("\n")) {
        if (line.length === 0) continue;
        try {
          const p: unknown = JSON.parse(line);
          if (typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string") this.ids.add((p as { id: string }).id);
        } catch { /* verify() reports it */ }
      }
      this.idsOffset = size;
    }
    return this.ids;
  }

  append(record: UnsealedRecord): Promise<LedgerRecord> {
    return this.serialize(async () => {
      const timeoutMs = lockTimeoutMs();
      mkdirSync(dirname(this.path), { recursive: true }); // the lock file lives next to the ledger
      const release = await acquireLock(`${this.path}.lock`, timeoutMs);
      try {
        const tail = this.readTail();
        const ids = this.refreshIds(fileSize(this.path));
        const sealed = seal(record, tail);
        if (ids.has(sealed.id)) throw new Error(`ledger.append: duplicate id ${JSON.stringify(sealed.id)}; ids must be unique per ledger (replay or caller bug); nothing was written`);
        appendLine(this.path, `${canonicalize(sealed)!}\n`);
        ids.add(sealed.id);
        this.idsOffset = fileSize(this.path);
        return sealed;
      } finally {
        release();
      }
    });
  }

  head(): Promise<string> {
    return this.serialize(() => this.readTail().hash);
  }

  /** Every physical line with its 1-based number. Blank lines are yielded too (they are evidence of damage). */
  private async *lines(): AsyncGenerator<{ n: number; raw: string }> {
    if (fileSize(this.path) === 0) return;
    const rl = createInterface({ input: createReadStream(this.path, { encoding: "utf8" }), crlfDelay: Infinity });
    let n = 0;
    for await (const raw of rl) yield { n: ++n, raw };
  }

  /**
   * Walks the chain and stops at the first record that fails: not JSON, invalid shape, duplicate id, parent pointer or
   * prevHash mismatch, recomputed hash mismatch, or (last) a file that does not end with "\n". Internal consistency
   * only: a full re-chain by whoever can write the file passes this check (README "What verify() cannot see").
   */
  async verify(): Promise<VerifyResult> {
    let checked = 0;
    let prevId: string | null = null;
    let prevHash = GENESIS_HASH;
    let lastN = 0;
    const ids = new Set<string>();
    const size = fileSize(this.path);
    if (size === 0) return { ok: true, checked: 0 };
    for await (const { n, raw } of this.lines()) {
      checked++; lastN = n;
      const broken = (id?: string): VerifyResult => ({ ok: false, checked, brokenAt: id ?? `line:${n}` });
      const p = parseStored(raw);
      if (p.err !== undefined) return broken(p.id);
      const rec = p.rec;
      if (ids.has(rec.id)) return broken(rec.id);
      if (rec.prevHash !== prevHash || rec.parentRecordId !== prevId) return broken(rec.id);
      const { hash, ...preimage } = rec;
      let computed: string;
      try { computed = sha256Jcs(preimage); } catch { return broken(rec.id); }
      if (computed !== hash) return broken(rec.id);
      ids.add(rec.id); prevId = rec.id; prevHash = hash;
    }
    if (!endsWithNewline(this.path, size)) return { ok: false, checked, brokenAt: `line:${lastN}` };
    return { ok: true, checked };
  }

  /**
   * Records whose `writtenAt` (the ledger's clock) lies in [from, to], both inclusive, compared as instants. Throws on
   * a range without explicit offsets, an unframed file, or any invalid line: a report must fail, not silently skip.
   */
  async *read(range: DateRange): AsyncIterable<LedgerRecord> {
    const from = parseInstant(range.from, "range.from"); const to = parseInstant(range.to, "range.to");
    if (from > to) throw new Error(`ledger.read: invalid range, from is after to: ${JSON.stringify(range)}`);
    const size = fileSize(this.path);
    if (size === 0) return;
    if (!endsWithNewline(this.path, size)) throw new Error(`ledger.read: ${this.path} ends with an incomplete line; run verify()`);
    for await (const { n, raw } of this.lines()) {
      const p = parseStored(raw);
      if (p.err !== undefined) throw new Error(`ledger.read: invalid record at line ${n} of ${this.path} (${p.err}); run verify()`);
      const t = parseInstant(p.rec.writtenAt, "writtenAt");
      if (t >= from && t <= to) yield p.rec;
    }
  }
}
