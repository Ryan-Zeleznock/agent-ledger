// Private-file and upstreams.yaml readers for the server composition root (Slice 2a pin 8). Errors name the FILE,
// never its contents.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { parseConfigDocument, readConfigFile } from "../config-file.js";
import { MCP_SERVER_NAME_RE } from "../types/index.js";
import type { UpstreamConfig } from "../upstream/contract.js";

/**
 * A key or password file: regular, not a symlink (O_NOFOLLOW), owned by this uid, mode 0600/0400 (no group/other bits),
 * at most `maxBytes`. The CLI's hook private files follow the same rule; the staging initContainer (pin 8) writes 0600.
 */
export function readPrivateFile(path: string, maxBytes: number): Buffer {
  const name = basename(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) {
    const code = (e as { code?: string }).code;
    throw new Error(code === "ELOOP" || code === "EMLINK" ? `${name}: is a symlink; refused` : `${name}: cannot be opened (${code ?? "error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${name}: not a regular file`);
    if (process.platform !== "win32" && (st.uid !== process.getuid!() || (st.mode & 0o077) !== 0)) throw new Error(`${name}: must be owned by this user with mode 0600`);
    if (st.size > maxBytes) throw new Error(`${name}: larger than ${maxBytes} bytes`);
    const buf = Buffer.alloc(Number(st.size));
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) break; off += n; }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}

/**
 * `upstreams.yaml`: `version: 1`, `upstreams: [{ name, transport: http, url }]` (pin 8), read with the shared
 * `readConfigFile` (owner + mode rule) and `parseConfigDocument` (literal `version: 1`, unique keys); unknown fields and
 * duplicate names refused. Returns plain `UpstreamConfig[]`; `connectUpstreams` validates names and URLs again.
 */
export function readUpstreamsConfig(path: string): UpstreamConfig[] {
  const name = basename(path);
  let source: string;
  try { source = readConfigFile(path); }
  catch (e) { throw new Error(`${name}: ${e instanceof Error && e.message === "Unsafe configuration permissions" ? "unsafe permissions or owner" : "cannot be read"}`); }
  let root: unknown;
  try { root = parseConfigDocument(source).toJS({ mapAsMap: true }); } catch (e) { throw new Error(`${name}: ${e instanceof Error ? e.message : "invalid YAML"}`); }
  const top = mapping(root, name, ["version", "upstreams"]);
  if (top.get("version") !== 1) throw new Error(`${name}: version must be 1`);
  const list = top.get("upstreams");
  if (!Array.isArray(list)) throw new Error(`${name}: upstreams must be a sequence`);
  const seen = new Set<string>();
  return list.map((entry, i) => {
    const at = `${name}: upstreams[${i}]`;
    const m = mapping(entry, at, ["name", "transport", "url"]);
    const n = m.get("name"), transport = m.get("transport"), url = m.get("url");
    if (typeof n !== "string" || !MCP_SERVER_NAME_RE.test(n)) throw new Error(`${at}: name must match ${MCP_SERVER_NAME_RE.source}`);
    if (seen.has(n)) throw new Error(`${at}: duplicate name ${n}`);
    seen.add(n);
    if (transport !== "http") throw new Error(`${at}: transport must be http (stdio is 2b)`);
    if (typeof url !== "string" || url.length === 0) throw new Error(`${at}: url must be a non-empty string`);
    return { name: n, transport, url };
  });
}
function mapping(value: unknown, at: string, allowed: readonly string[]): Map<string, unknown> {
  if (!(value instanceof Map)) throw new Error(`${at}: expected a mapping`);
  for (const k of value.keys()) { if (typeof k !== "string" || !allowed.includes(k)) throw new Error(`${at}: unknown field ${String(k)}`); }
  return value;
}
