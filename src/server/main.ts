// Slice 2a pin 8 (ADR-013): the server-mode composition root. `node dist/server/main.js` in the home-lab cluster.
// Environment contract: AGENT_LEDGER_CONFIG_DIR, AGENT_LEDGER_LEDGER_URL, AGENT_LEDGER_PORT, AGENT_LEDGER_BIND_HOST,
// AGENT_LEDGER_ALLOWED_ORIGINS, AGENT_LEDGER_APPROVALS, AGENT_LEDGER_MAX_INFLIGHT (additive, fix round F10); nothing else is
// read (NODE_OPTIONS is checked, never read).
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingCall, LedgerRecord, ToolResult, UnsealedRecord } from "../types/index.js";
import { createLedger as realCreateLedger, type LedgerStore } from "../ledger/contract.js";
import { createIdentity } from "../identity/contract.js";
import { loadRegistry } from "../policy/contract.js";
import { createSecretsProvider } from "../secrets/contract.js";
import { connectUpstreams, type Upstream } from "../upstream/contract.js";
import { createPipeline } from "../pipeline/contract.js";
import { DEFAULT_MAX_IN_FLIGHT, startFront, type RunningFront } from "../front/contract.js";
import { readPrivateFile, readUpstreamsConfig } from "./files.js";

export const ENV = {
  configDir: "AGENT_LEDGER_CONFIG_DIR", ledgerUrl: "AGENT_LEDGER_LEDGER_URL", port: "AGENT_LEDGER_PORT",
  bindHost: "AGENT_LEDGER_BIND_HOST", allowedOrigins: "AGENT_LEDGER_ALLOWED_ORIGINS", approvals: "AGENT_LEDGER_APPROVALS",
  maxInFlight: "AGENT_LEDGER_MAX_INFLIGHT",
} as const;
export const CONFIG_FILES = { registry: "registry.yaml", agents: "agents.yaml", upstreams: "upstreams.yaml", hmacKey: "hmac.key", ledgerPassword: "ledger.password", secretsDir: "secrets" } as const;
export const DEFAULT_SERVER_PORT = 8787;
export const DEFAULT_SERVER_BIND_HOST = "0.0.0.0"; // the ONE place 0.0.0.0 is chosen, on purpose (pin 8)
export const SHUTDOWN_GRACE_MS = 10_000;
/** How long `stop()` lets admitted calls finish against the upstream before aborting them (inside SHUTDOWN_GRACE_MS; F3). */
export const SHUTDOWN_DRAIN_MS = 5_000;
export const HMAC_KEY_BYTES = 32;

/** A refused start: the reason is already logged (one JSON line, no URL, no value); the process exits 1. */
export class StartupRefused extends Error { override name = "StartupRefused"; }

export type LogLine = Record<string, unknown>;
export interface ServerDeps {
  createLedger: typeof realCreateLedger;
  /** One JSON-able object per line; the entrypoint writes it to stderr. */
  log: (line: LogLine) => void;
}
export interface RunningServer { readonly port: number; readonly head: string; stop(): Promise<void>; }

const defaults: ServerDeps = { createLedger: realCreateLedger, log: (line) => process.stderr.write(`${JSON.stringify(line)}\n`) };
const now = () => new Date().toISOString();

/**
 * Start order (pin 8): env → registry → identity → hmac key → secrets → ledger + `head()` → upstreams → pipeline
 * (`approvals: { kind: "none" }`) → front. Any failure logs `{ event: "refused", reason }` and throws StartupRefused;
 * the reason never carries the ledger URL, a password, a key or a token.
 */
export async function startServer(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerDeps> = {}): Promise<RunningServer> {
  const deps = { ...defaults, ...overrides };
  const secretsToStrip: string[] = [];
  const refuse = (reason: string): never => {
    let clean = reason;
    // longest first, so the full URL (which contains the password) is redacted before the password alone would break it
    for (const s of [...secretsToStrip].sort((a, b) => b.length - a.length)) if (s.length > 0) clean = clean.split(s).join("[redacted]");
    deps.log({ ts: now(), event: "refused", reason: clean });
    throw new StartupRefused(clean);
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  if (env["NODE_OPTIONS"] !== undefined) refuse("NODE_OPTIONS is set; the server refuses to start (spec §7 launch-environment residual; Kyverno forbids it too)");
  const configDir = env[ENV.configDir];
  if (typeof configDir !== "string" || configDir.length === 0) refuse(`${ENV.configDir} is required`);
  const dir = resolve(configDir!);
  const ledgerUrlRaw = env[ENV.ledgerUrl];
  if (typeof ledgerUrlRaw !== "string" || ledgerUrlRaw.length === 0) refuse(`${ENV.ledgerUrl} is required`);
  secretsToStrip.push(ledgerUrlRaw!);
  const portRaw = env[ENV.port] ?? String(DEFAULT_SERVER_PORT);
  if (!/^\d{1,5}$/.test(portRaw) || Number(portRaw) > 65535) refuse(`${ENV.port} must be an integer 0-65535`);
  const port = Number(portRaw);
  const bindHost = env[ENV.bindHost] ?? DEFAULT_SERVER_BIND_HOST;
  if (bindHost.length === 0) refuse(`${ENV.bindHost} must not be empty`);
  const allowedOrigins = (env[ENV.allowedOrigins] ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const maxInFlightRaw = env[ENV.maxInFlight] ?? String(DEFAULT_MAX_IN_FLIGHT);
  if (!/^\d{1,6}$/.test(maxInFlightRaw) || Number(maxInFlightRaw) < 1 || Number(maxInFlightRaw) > 100_000) refuse(`${ENV.maxInFlight} must be an integer 1-100000`);
  const maxInFlight = Number(maxInFlightRaw);
  if (env[ENV.approvals] !== "none") refuse(`${ENV.approvals} must be "none" in this slice (slack arrives with the approvals module; got ${env[ENV.approvals] === undefined ? "nothing" : JSON.stringify(env[ENV.approvals]).slice(0, 32)})`);

  let ledgerUrl: URL;
  try { ledgerUrl = new URL(ledgerUrlRaw!); } catch { return refuse(`${ENV.ledgerUrl} is not a valid URL`); }
  const backend = ledgerUrl.protocol === "postgres:" || ledgerUrl.protocol === "postgresql:" ? "postgres" : ledgerUrl.protocol === "file:" ? "jsonl" : undefined;
  if (backend === undefined) refuse(`${ENV.ledgerUrl} scheme must be postgres://, postgresql:// or file:// (got ${ledgerUrl.protocol})`);
  if (ledgerUrl.password.length > 0) refuse(`${ENV.ledgerUrl} must not carry a password; it is read from ${CONFIG_FILES.ledgerPassword}`);

  // 1. registry (refuse on any loader error; its messages name keys, never values)
  let registry;
  try { registry = await loadRegistry(join(dir, CONFIG_FILES.registry)); } catch (e) { return refuse(`${CONFIG_FILES.registry}: ${message(e)}`); }
  // 2. identity
  let identity;
  try { identity = createIdentity("file", join(dir, CONFIG_FILES.agents)); } catch (e) { return refuse(`${CONFIG_FILES.agents}: ${message(e)}`); }
  // 3. hmac key
  let argsHmacKey: Buffer;
  try { argsHmacKey = readPrivateFile(join(dir, CONFIG_FILES.hmacKey), 1024); } catch (e) { return refuse(message(e)); }
  if (argsHmacKey.length !== HMAC_KEY_BYTES) refuse(`${CONFIG_FILES.hmacKey}: must be exactly ${HMAC_KEY_BYTES} raw bytes`);
  // 4. secrets
  let secrets;
  try { secrets = createSecretsProvider("file", join(dir, CONFIG_FILES.secretsDir)); } catch (e) { return refuse(message(e)); }
  // 5. ledger + head
  let ledger: LedgerStore;
  try {
    if (backend === "postgres") {
      const password = readPrivateFile(join(dir, CONFIG_FILES.ledgerPassword), 4096).toString("utf8").trim();
      if (password.length === 0) refuse(`${CONFIG_FILES.ledgerPassword}: empty`);
      secretsToStrip.push(password, encodeURIComponent(password));
      ledgerUrl.password = encodeURIComponent(password); // pins "Integration seams": the root encodes; pg decodes (B's README)
      secretsToStrip.push(ledgerUrl.toString());
      ledger = deps.createLedger("postgres", ledgerUrl.toString());
    } else {
      ledger = deps.createLedger("jsonl", fileURLToPath(ledgerUrl));
    }
  } catch (e) { return refuse(`ledger: ${message(e)}`); }
  let head: string;
  try { head = await ledger.head(); } catch (e) { return refuse(`ledger unreachable: head() failed (${e instanceof Error ? e.name : "error"}: ${message(e)})`); }
  deps.log({ ts: now(), event: "ledger", backend, head });
  // 6. upstreams
  let upstream: Upstream;
  try {
    const config = readUpstreamsConfig(join(dir, CONFIG_FILES.upstreams));
    upstream = await connectUpstreams(config, secrets);
  } catch (e) { return refuse(`upstreams: ${message(e)}`); }
  const tools = await upstream.listTools();
  const upstreamsLine: LogLine = { ts: now(), event: "upstreams", servers: [...new Set(tools.map((t) => t.server))], tools: tools.length };
  if (upstream.rejectedTools && upstream.rejectedTools.length > 0) upstreamsLine["rejected"] = upstream.rejectedTools.map((r) => ({ ...r })); // transport: the client SHOULD log a warning naming the tool and the reason (F4)
  deps.log(upstreamsLine);
  // 7. pipeline, with the ledger observed so each call's log line can carry agentId/verdict/ruleId/status
  const seen = new Map<string, { agentId?: string; verdict?: string; ruleId?: string; outcome?: string }>();
  const observed: LedgerStore = {
    async append(record: UnsealedRecord): Promise<LedgerRecord> {
      // Noted BEFORE the append: a refused append still denies with the verdict the pipeline reached (fail closed), and the
      // log line must say which rule it was even when the ledger would not take the record.
      const e = seen.get(record.call.callId) ?? {};
      if (record.phase === "intent") { e.agentId = record.call.agentId; e.verdict = record.policy.verdict; e.ruleId = record.policy.ruleId; }
      seen.set(record.call.callId, e);
      const out = await ledger.append(record);
      if (record.phase === "outcome") e.outcome = record.outcome?.status;
      return out;
    },
    verify: () => ledger.verify(), head: () => ledger.head(), read: (range) => ledger.read(range),
  };
  let pipeline;
  try {
    pipeline = createPipeline({ identity, registry, ledger: observed, upstream, approvals: { kind: "none" }, argsHmacKey });
  } catch (e) { await upstream.close().catch(() => undefined); return refuse(`pipeline: ${message(e)}`); }
  const inflight = new Set<Promise<ToolResult>>(); // admitted calls whose outcome attempt stop() must wait for (F3)
  const handler = async (incoming: IncomingCall): Promise<ToolResult> => {
    const p = handleOne(incoming);
    inflight.add(p);
    try { return await p; } finally { inflight.delete(p); }
  };
  const handleOne = async (incoming: IncomingCall): Promise<ToolResult> => {
    const started = Date.now();
    let status = "exception";
    try {
      const result = await pipeline.handle(incoming);
      status = seen.get(incoming.callId)?.outcome ?? (result.isError ? "denied" : "ok");
      return result;
    } finally {
      const e = seen.get(incoming.callId) ?? {};
      seen.delete(incoming.callId);
      const line: LogLine = { ts: now(), callId: incoming.callId };
      if (e.agentId !== undefined) line["agentId"] = e.agentId;
      Object.assign(line, { server: incoming.server, tool: incoming.tool });
      if (e.verdict !== undefined) line["verdict"] = e.verdict;
      if (e.ruleId !== undefined) line["ruleId"] = e.ruleId;
      Object.assign(line, { status, ms: Date.now() - started });
      deps.log(line);
    }
  };
  // 8. front
  let front: RunningFront;
  try { front = await startFront(handler, { mode: "http", port, bindHost, allowedOrigins, maxInFlight, drainTimeoutMs: SHUTDOWN_DRAIN_MS, tools: () => upstream.listTools() }); }
  catch (e) { await upstream.close().catch(() => undefined); return refuse(`front: ${message(e)}`); }
  deps.log({ ts: now(), event: "listening", port: front.port, bindHost, approvals: "none", allowedOrigins: allowedOrigins.length, maxInFlight });
  let stopped = false;
  return {
    port: front.port, head,
    /**
     * F3 order: stop admitting and let admitted calls finish (front drains up to SHUTDOWN_DRAIN_MS) → abort whatever is
     * still waiting on an upstream (the pipeline then appends its `error` outcome) → wait for every admitted call's
     * outcome attempt, bounded by what is left of SHUTDOWN_GRACE_MS → only then close the ledger. `drained: false` in the
     * `stopped` line means some outcome attempt was still pending when storage closed.
     */
    async stop() {
      if (stopped) return; stopped = true;
      const deadline = Date.now() + SHUTDOWN_GRACE_MS - 1_000;
      await front.stop();
      await upstream.close().catch(() => undefined);
      const drained = await settleWithin([...inflight], Math.max(0, deadline - Date.now()));
      const closable = ledger as LedgerStore & { close?: () => Promise<void> };
      if (typeof closable.close === "function") await closable.close().catch(() => undefined); // pool end (B's Postgres ledger; duck-typed, the contract has no close)
      deps.log({ ts: now(), event: "stopped", drained, inflight: inflight.size });
    },
  };
}

/** True when every promise settled within `ms`. */
async function settleWithin(promises: Promise<unknown>[], ms: number): Promise<boolean> {
  if (promises.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const done = await Promise.race([Promise.allSettled(promises).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  clearTimeout(timer);
  return done;
}

/** Entrypoint: start, then SIGTERM/SIGINT → stop → exit 0 within SHUTDOWN_GRACE_MS (hard exit 0 at the limit, logged). */
export async function serverMain(): Promise<void> {
  let server: RunningServer;
  try { server = await startServer(process.env); }
  catch (e) { if (!(e instanceof StartupRefused)) defaults.log({ ts: now(), event: "refused", reason: e instanceof Error ? e.name : "error" }); process.exitCode = 1; return; }
  const shutdown = (signal: string) => {
    defaults.log({ ts: now(), event: "shutdown", signal });
    const hard = setTimeout(() => { defaults.log({ ts: now(), event: "shutdown-timeout", ms: SHUTDOWN_GRACE_MS }); process.exit(0); }, SHUTDOWN_GRACE_MS);
    hard.unref();
    void server.stop().then(() => process.exit(0), () => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

let invokedDirectly = false;
try { invokedDirectly = !!process.argv[1] && realpathSync.native(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { /* imported */ }
if (invokedDirectly) await serverMain();
