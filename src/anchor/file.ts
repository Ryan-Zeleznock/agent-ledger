import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import canonicalize from "canonicalize";
import type { Anchor, AnchorEntry } from "./contract.js";

/**
 * File anchor (local mode, spec §4): one canonical JSON line per chain head, appended with O_APPEND and fsync'd.
 * The API has no update or delete. Writes are serialised in-process; across processes each write is a single
 * write(2) on an O_APPEND descriptor, so lines never overwrite each other (order between processes is not
 * meaningful for an anchor, so no lock file is used). "Hard to edit" is relative here: the file is on the same
 * machine as the ledger (spec §3 local-mode trust boundary); S3 Object Lock is the server-mode backend.
 */

const HASH_RE = /^(?:[0-9a-f]{64}|0)$/; // a ledger head: SHA-256 hex, or "0" when the chain is still empty
const ALLOWED_KEYS = new Set(["hash", "at"]);
const isErrno = (e: unknown, code: string) => typeof e === "object" && e !== null && (e as { code?: string }).code === code;

function validate(entry: unknown): AnchorEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("anchor.write: entry must be an object");
  const extra = Object.keys(entry).filter((k) => !ALLOWED_KEYS.has(k));
  if (extra.length > 0) throw new Error(`anchor.write: unexpected fields: ${extra.join(", ")}`);
  const { hash, at } = entry as Record<string, unknown>;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) throw new Error("anchor.write: hash must be 64 lowercase hex characters (or \"0\")");
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new Error("anchor.write: at must be an ISO 8601 date string");
  return { hash, at };
}

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

export class FileAnchor implements Anchor {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {
    if (typeof path !== "string" || path.length === 0) throw new Error("anchor: file target must be a file path");
  }

  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async write(entry: AnchorEntry): Promise<void> {
    const valid = validate(entry); // validated before queueing, so a bad entry rejects and touches nothing
    await this.serialize(() => appendLine(this.path, `${canonicalize(valid)!}\n`));
  }

  latest(): Promise<AnchorEntry | null> {
    return this.serialize(() => {
      let text: string;
      try { text = readFileSync(this.path, "utf8"); } catch (e) { if (isErrno(e, "ENOENT")) return null; throw e; }
      if (text.length === 0) return null;
      if (!text.endsWith("\n")) throw new Error(`anchor: ${this.path} ends with an incomplete line (interrupted write or tampering)`);
      const last = text.slice(0, -1).split("\n").at(-1)!;
      let parsed: unknown;
      try { parsed = JSON.parse(last); } catch { throw new Error(`anchor: last line of ${this.path} is not JSON`); }
      try { return validate(parsed); } catch (e) { throw new Error(`anchor: last line of ${this.path} is not a valid entry: ${(e as Error).message}`); }
    });
  }
}
