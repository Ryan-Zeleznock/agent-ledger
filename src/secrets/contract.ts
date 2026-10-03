import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { notImplemented } from "../types/not-implemented.js";

export interface SecretsProvider { get(server: string): Promise<Record<string, string>>; }

/**
 * `<server>.<key>` (Slice 2a pin 4): the server part is an MCP server name (`MCP_SERVER_NAME_RE` shape), the key an
 * identifier. A Kubernetes Secret key becomes a file of that name once the staging initContainer copies it.
 */
export const SECRET_FILE_NAME_RE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)$/;
/** A credential file larger than this is a mistake, not a secret. */
export const MAX_SECRET_FILE_BYTES = 64 * 1024;

/**
 * `file`: `target` is a directory read ONCE at construction. Every entry must be a regular file (no symlink: opened
 * with O_NOFOLLOW, so a Kubernetes Secret volume mounted directly, whose keys are symlinks into `..data`, is refused
 * loudly and must be staged first, pin 8), owned by this process's uid, not group/world-writable (the `readConfigFile`
 * rule), named `<server>.<key>`, at most MAX_SECRET_FILE_BYTES. Contents are trimmed. Anything else throws an error
 * that names the FILE, never a value. `get(server)` resolves to a fresh `{ [key]: value }` (`{}` when the server has
 * none); values live in a closure, never on the returned object. `env` is Slice 2b (notImplemented).
 */
export function createSecretsProvider(kind: "env" | "file", target?: string): SecretsProvider {
  if (kind === "env") throw notImplemented("secrets.createSecretsProvider(env)");
  if (kind !== "file") throw new Error("secrets: unknown provider kind");
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) throw new Error("secrets: file provider needs a directory path");
  let dirStat;
  try { dirStat = statSync(target); } catch { throw new Error("secrets: directory not readable"); }
  if (!dirStat.isDirectory()) throw new Error("secrets: target is not a directory");
  const byServer = new Map<string, Map<string, string>>();
  for (const name of readdirSync(target).sort()) {
    const m = SECRET_FILE_NAME_RE.exec(name);
    if (!m) throw new Error(`secrets: ${JSON.stringify(name)} is not a <server>.<key> file name`);
    const [, server, key] = m as unknown as [string, string, string];
    const value = readSecretFile(join(target, name), name);
    let keys = byServer.get(server);
    if (!keys) { keys = new Map(); byServer.set(server, keys); }
    keys.set(key, value);
  }
  return {
    async get(server) {
      if (typeof server !== "string") throw new Error("secrets: server name must be a string");
      const keys = byServer.get(server);
      const out: Record<string, string> = {};
      if (keys) for (const [k, v] of keys) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
      return out;
    },
  };
}

/** Same fd for the checks and the read (no stat/open race); the error text carries the file NAME only. */
function readSecretFile(path: string, name: string): string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) {
    const code = (e as { code?: string }).code;
    throw new Error(code === "ELOOP" || code === "EMLINK" ? `secrets: ${JSON.stringify(name)} is a symlink; refused` : `secrets: ${JSON.stringify(name)} cannot be opened`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`secrets: ${JSON.stringify(name)} is not a regular file`);
    if (process.platform !== "win32" && ((st.mode & 0o022) !== 0 || st.uid !== process.getuid!())) throw new Error(`secrets: ${JSON.stringify(name)} has unsafe permissions or owner`);
    if (st.size > MAX_SECRET_FILE_BYTES) throw new Error(`secrets: ${JSON.stringify(name)} exceeds ${MAX_SECRET_FILE_BYTES} bytes`);
    const buf = Buffer.alloc(Number(st.size));
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) break; off += n; }
    return buf.subarray(0, off).toString("utf8").trim();
  } finally { closeSync(fd); }
}
