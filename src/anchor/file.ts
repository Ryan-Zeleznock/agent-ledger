import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import canonicalize from "canonicalize";
import type { Anchor, AnchorEntry } from "./contract.js";

/**
 * File anchor (local mode, spec §4): one canonical JSON line per chain head, appended with O_APPEND and fsync'd.
 * The API has no update or delete. After Astra's review (2026-09-30, #11, #12): writes take the same exclusive lock
 * file as the ledger (`<path>.lock`, `wx`, never reclaimed automatically), check the existing file's framing and last
 * entry BEFORE appending (a torn tail is preserved for recovery, never papered over), refuse zero-progress writes, and
 * accept only RFC 3339 timestamps with an explicit offset and a real calendar date.
 * "Hard to edit" is relative here: the file is on the same machine as the ledger (spec §3 local-mode trust
 * boundary); S3 Object Lock is the server-mode backend. The anchor module may not import the ledger module, so the
 * small lock and timestamp helpers are duplicated on purpose.
 */

const HASH_RE = /^(?:[0-9a-f]{64}|0)$/; // a ledger head: SHA-256 hex, or "0" when the chain is still empty
const ALLOWED_KEYS = new Set(["hash", "at"]);
const LOCK_TIMEOUT_ENV = "AGENT_LEDGER_LOCK_TIMEOUT_MS";
const LOCK_TIMEOUT_DEFAULT_MS = 5_000;
const LOCK_RETRY_MS = 5;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

const isErrno = (e: unknown, code: string) => typeof e === "object" && e !== null && (e as { code?: string }).code === code;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * RFC 3339 with explicit offset, a real calendar day, seconds <= 59 (no leap seconds: ECMAScript time cannot represent
 * them) and at most 3 fractional digits (millisecond precision keeps ordering exact): the SAME rule as the ledger's
 * `parseInstant` (ledger README "Timestamps"; round 3 made the anchor match it).
 */
const MAX_FRACTION_DIGITS = 3;
function isInstant(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = RFC3339.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || h! > 23 || mi! > 59 || s! > 59) return false;
  if (m[7] !== undefined && m[7].length > MAX_FRACTION_DIGITS) return false;
  const check = new Date(Date.UTC(y!, mo! - 1, d!));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo! - 1 || check.getUTCDate() !== d) return false;
  const off = m[8]!;
  return off === "Z" || off === "z" || (Number(off.slice(1, 3)) <= 23 && Number(off.slice(4, 6)) <= 59);
}

function validate(entry: unknown): AnchorEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("anchor.write: entry must be an object");
  const extra = Object.keys(entry).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length > 0) throw new Error(`anchor.write: unexpected fields: ${extra.join(", ")}`);
  const { hash, at } = entry as Record<string, unknown>;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new Error('anchor.write: hash must be 64 lowercase hex characters (or "0")');
  if (!isInstant(at)) throw new Error("anchor.write: at must be an RFC 3339 timestamp with an explicit offset and a real calendar date");
  return { hash, at: at as string };
}

function lockTimeoutMs(): number {
  const raw = process.env[LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return LOCK_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 600_000) throw new Error(`anchor: ${LOCK_TIMEOUT_ENV} must be an integer between 1 and 600000, got ${JSON.stringify(raw)}`);
  return n;
}

function describeLock(lockPath: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) return "lock path is not a regular file";
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    const text = buf.subarray(0, n).toString("utf8").replace(/[^\x20-\x7e]/g, " ").trim();
    return text.length > 0 ? `"${text}"` : "empty lock file";
  } catch (e) {
    return `unreadable lock file (${message(e)})`;
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
      return () => { try { unlinkSync(lockPath); } catch { /* removed by an operator */ } };
    } catch (e) {
      if (!isErrno(e, "EEXIST")) throw e;
    }
    if (performance.now() - started >= timeoutMs) {
      throw new Error(`anchor: lock ${lockPath} is held by ${describeLock(lockPath)}; waited ${timeoutMs} ms. If that process is gone this is a stale lock: verify the anchor file, then remove the lock file manually. Automatic reclaim is disabled.`);
    }
    await sleep(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS);
  }
}

function openData(path: string, write = false): number | null {
  let fd: number;
  try { fd = openSync(path, (write ? constants.O_RDWR | constants.O_APPEND | constants.O_CREAT : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
  catch (e) { if (!write && isErrno(e, "ENOENT")) return null; throw e; }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("anchor: data must be a regular file");
    return fd;
  } catch (e) { closeSync(fd); throw e; }
}
function appendLine(fd: number, line: string): void {
  const buf = Buffer.from(line, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw new Error("anchor: write made no progress");
    off += n;
  }
  fsyncSync(fd);
}

/** Only the last entry is needed; never allocate/read the full anchor history. */
const MAX_ANCHOR_LINE_BYTES = 4096;
function readLatest(fd: number): AnchorEntry | null {
  const size = fstatSync(fd).size;
  if (size === 0) return null;
  const length = Math.min(size, MAX_ANCHOR_LINE_BYTES + 2), buf = Buffer.alloc(length);
  if (readSync(fd, buf, 0, length, size - length) !== length) throw new Error("anchor: file changed during read");
  if (buf[length - 1] !== 0x0a) throw new Error("anchor: incomplete line; recover manually, never truncate");
  const start = buf.lastIndexOf(0x0a, length - 2) + 1;
  if ((start === 0 && size > length) || length - 1 - start > MAX_ANCHOR_LINE_BYTES) throw new Error("anchor: line size limit exceeded");
  const last = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(start, length - 1));
  if (last.includes("\r")) throw new Error("anchor: last line contains a carriage return");
  let parsed: unknown;
  try { parsed = JSON.parse(last); } catch { throw new Error("anchor: last line is not JSON"); }
  try { return validate(parsed); } catch { throw new Error("anchor: last line is not a valid entry"); }
}

export class FileAnchor implements Anchor {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {
    if (typeof path !== "string" || path.length === 0) throw new Error("anchor: file target must be a file path");
  }

  private serialize<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async write(entry: AnchorEntry): Promise<void> {
    const valid = validate(entry); // validated before queueing, so a bad entry rejects and touches nothing
    await this.serialize(async () => {
      const timeoutMs = lockTimeoutMs();
      mkdirSync(dirname(this.path), { recursive: true });
      const release = await acquireLock(`${this.path}.lock`, timeoutMs);
      let fd: number | null = null;
      try {
        fd = openData(this.path, true)!;
        readLatest(fd); // framing + last entry must be sound before anything is appended (Astra #11)
        appendLine(fd, `${canonicalize(valid)!}\n`);
      } finally {
        if (fd !== null) closeSync(fd);
        release();
      }
    });
  }

  latest(): Promise<AnchorEntry | null> {
    return this.serialize(() => {
      const fd = openData(this.path);
      if (fd === null) return null;
      try { return readLatest(fd); } finally { closeSync(fd); }
    });
  }
}

/** For tests: byte size of the anchor file (0 when absent). Not part of the contract. */
export function anchorFileSize(path: string): number {
  const fd = openData(path);
  if (fd === null) return 0;
  try { return fstatSync(fd).size; } finally { closeSync(fd); }
}
