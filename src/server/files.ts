// Private-file and upstreams.yaml readers for the server composition root (Slice 2a pin 8). Errors name the FILE,
// never its contents.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import { parseConfigDocument, readConfigFile } from "../config-file.js";
import { MCP_SERVER_NAME_RE } from "../types/index.js";
import type { UpstreamConfig } from "../upstream/contract.js";

/**
 * A key or password file: regular (checked on the fd of a non-blocking open, so a FIFO or device is refused instead of
 * blocking startup), not a symlink (O_NOFOLLOW), owned by this uid, mode 0600/0400 (no group/other bits), at most `maxBytes`. The CLI's hook private files follow the same rule; the staging initContainer (pin 8) writes 0600.
 */
export function readPrivateFile(path: string, maxBytes: number): Buffer {
  const name = basename(path);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } // O_NONBLOCK: a FIFO with no writer must not block the open before fstat can refuse it (F8)
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
    if (n === RESERVED_APPROVALS_NAME) throw new Error(`${at}: name ${RESERVED_APPROVALS_NAME} is reserved (the Slack tokens live under secrets/${RESERVED_APPROVALS_NAME}.*; Slice 2b pin 5)`);
    if (seen.has(n)) throw new Error(`${at}: duplicate name ${n}`);
    seen.add(n);
    if (transport !== "http") throw new Error(`${at}: transport must be http (stdio is 2c)`);
    if (typeof url !== "string" || url.length === 0) throw new Error(`${at}: url must be a non-empty string`);
    return { name: n, transport, url };
  });
}
/** Slice 2b pin 5: no upstream may be called `approvals`, so `secrets.get(name)` can never hand it the Slack tokens. */
export const RESERVED_APPROVALS_NAME = "approvals" as const;
export const SLACK_CHANNEL_ID_RE = /^[CG][A-Z0-9]{8,}$/;
export const SLACK_APPROVER_ID_RE = /^[UW][A-Z0-9]{8,}$/;
export const APPROVALS_DEFAULT_TIMEOUT_MS = 180_000;
export const APPROVALS_MIN_TIMEOUT_MS = 1_000;
/** The loopback form pin 1 allows for `apiBaseUrl` besides the production URL (tests and e2e only). */
export const LOOPBACK_API_BASE_RE = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/api\/$/;
export interface ApprovalsConfig { channelId: string; approvers: string[]; timeoutMs: number; apiBaseUrl?: string; }

/**
 * `approvals.yaml` (Slice 2b pin 5): `version: 1`, `slack: { channelId, approvers, timeoutMs?, apiBaseUrl? }`, unknown fields
 * refused, read with the shared `readConfigFile`/`parseConfigDocument`. Tokens are never in this file. Errors name fields,
 * never values (a channel or member id is not secret, but the rule is uniform).
 */
export function readApprovalsConfig(path: string, limits: { maxTimeoutMs: number; productionApiBaseUrl: string }): ApprovalsConfig {
  const name = basename(path);
  let source: string;
  try { source = readConfigFile(path); }
  catch (e) { throw new Error(`${name}: ${e instanceof Error && e.message === "Unsafe configuration permissions" ? "unsafe permissions or owner" : "cannot be read"}`); }
  let root: unknown;
  try { root = parseConfigDocument(source).toJS({ mapAsMap: true }); } catch (e) { throw new Error(`${name}: ${e instanceof Error ? e.message : "invalid YAML"}`); }
  const top = mapping(root, name, ["version", "slack"]);
  if (top.get("version") !== 1) throw new Error(`${name}: version must be 1`);
  const s = mapping(top.get("slack"), `${name}: slack`, ["channelId", "approvers", "timeoutMs", "apiBaseUrl"]);
  const channelId = s.get("channelId");
  if (typeof channelId !== "string" || !SLACK_CHANNEL_ID_RE.test(channelId)) throw new Error(`${name}: slack.channelId must match ${SLACK_CHANNEL_ID_RE.source}`);
  const approvers = s.get("approvers");
  if (!Array.isArray(approvers) || approvers.length === 0) throw new Error(`${name}: slack.approvers must be a non-empty sequence`);
  approvers.forEach((u, i) => { if (typeof u !== "string" || !SLACK_APPROVER_ID_RE.test(u)) throw new Error(`${name}: slack.approvers[${i}] must match ${SLACK_APPROVER_ID_RE.source}`); });
  if (new Set(approvers).size !== approvers.length) throw new Error(`${name}: slack.approvers has a duplicate`);
  const t = s.has("timeoutMs") ? s.get("timeoutMs") : APPROVALS_DEFAULT_TIMEOUT_MS;
  if (typeof t !== "number" || !Number.isInteger(t) || t < APPROVALS_MIN_TIMEOUT_MS || t > limits.maxTimeoutMs) throw new Error(`${name}: slack.timeoutMs must be an integer ${APPROVALS_MIN_TIMEOUT_MS}..${limits.maxTimeoutMs}`);
  const out: ApprovalsConfig = { channelId, approvers: approvers as string[], timeoutMs: t };
  if (s.has("apiBaseUrl")) {
    const u = s.get("apiBaseUrl");
    const m = typeof u === "string" ? LOOPBACK_API_BASE_RE.exec(u) : null;
    if (typeof u !== "string" || !(u === limits.productionApiBaseUrl || (m !== null && Number(m[1]) <= 65535))) throw new Error(`${name}: slack.apiBaseUrl must be ${limits.productionApiBaseUrl} or http://127.0.0.1:<port>/api/`);
    out.apiBaseUrl = u;
  }
  return out;
}

function mapping(value: unknown, at: string, allowed: readonly string[]): Map<string, unknown> {
  if (!(value instanceof Map)) throw new Error(`${at}: expected a mapping`);
  for (const k of value.keys()) { if (typeof k !== "string" || !allowed.includes(k)) throw new Error(`${at}: unknown field ${String(k)}`); }
  return value;
}
