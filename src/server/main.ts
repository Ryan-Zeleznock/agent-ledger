// Slice 2a pin 8 (ADR-013): the server-mode composition root. `node dist/server/main.js` in the home-lab cluster.
// Environment contract: AGENT_LEDGER_CONFIG_DIR, AGENT_LEDGER_LEDGER_URL, AGENT_LEDGER_PORT, AGENT_LEDGER_BIND_HOST,
// AGENT_LEDGER_ALLOWED_ORIGINS, AGENT_LEDGER_APPROVALS (none|slack, Slice 2b pin 6), AGENT_LEDGER_MAX_INFLIGHT (additive,
// fix round F10), AGENT_LEDGER_TLS (on|off, required; ADR-017), AGENT_LEDGER_UPSTREAM_CONNECT_BUDGET_MS (Slice 2b pin 6);
// nothing else is read (NODE_OPTIONS is checked, never read).
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalChannel, IncomingCall, LedgerRecord, ToolResult, UnsealedRecord } from "../types/index.js";
import { createLedger as realCreateLedger, type LedgerStore } from "../ledger/contract.js";
import { createIdentity } from "../identity/contract.js";
import { loadRegistry } from "../policy/contract.js";
import { createSecretsProvider } from "../secrets/contract.js";
import { connectUpstreams, type Upstream } from "../upstream/contract.js";
import { createPipeline } from "../pipeline/contract.js";
import { DEFAULT_MAX_IN_FLIGHT, startFront, type RunningFront } from "../front/contract.js";
import { validateSlackChannel, type SlackChannel } from "../approvals/contract.js";
import { readConfigFile } from "../config-file.js";
import { readApprovalsConfig, readPrivateFile, readUpstreamsConfig, type ApprovalsConfig } from "./files.js";
import { slack, upstreamEras, withTls } from "./seams.js";

export const ENV = {
  configDir: "AGENT_LEDGER_CONFIG_DIR", ledgerUrl: "AGENT_LEDGER_LEDGER_URL", port: "AGENT_LEDGER_PORT",
  bindHost: "AGENT_LEDGER_BIND_HOST", allowedOrigins: "AGENT_LEDGER_ALLOWED_ORIGINS", approvals: "AGENT_LEDGER_APPROVALS",
  maxInFlight: "AGENT_LEDGER_MAX_INFLIGHT", tls: "AGENT_LEDGER_TLS", connectBudget: "AGENT_LEDGER_UPSTREAM_CONNECT_BUDGET_MS",
} as const;
export const CONFIG_FILES = {
  registry: "registry.yaml", agents: "agents.yaml", upstreams: "upstreams.yaml", hmacKey: "hmac.key", ledgerPassword: "ledger.password", secretsDir: "secrets",
  approvals: "approvals.yaml", tlsCert: "tls.crt", tlsKey: "tls.key",
} as const;
/** Slice 2b pin 5: the Slack tokens, staged by `stage-config` into `secrets/` under the file provider's `<name>.<key>` naming. */
export const SLACK_TOKEN_FILES = { botToken: "approvals.botToken", appToken: "approvals.appToken" } as const;
/** Slice 2b pin 6: total time `connectUpstreams` (and, in slack mode, `probeSlack`) is retried at start. */
export const DEFAULT_CONNECT_BUDGET_MS = 60_000;
export const MAX_CONNECT_BUDGET_MS = 600_000;
/** Waits between attempts (pin 6: attempts at 0, 1, 2, 4, 8, 16, 16, … s); the last value repeats. */
export const CONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
/**
 * Fix round F2: the whole start operation (every attempt, sleep and in-flight request) is bounded by
 * max(budget, START_SINGLE_ATTEMPT_MAX_MS) from its first attempt; budget 0 keeps its one attempt, bounded by this
 * (one upstream request timeout). 2 x 60 s + 30 s still fits the 160 s startupProbe.
 */
export const START_SINGLE_ATTEMPT_MAX_MS = 30_000;
export const TLS_CERT_MAX_BYTES = 64 * 1024;
export const TLS_KEY_MAX_BYTES = 16 * 1024;
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
  /** Additive (Slice 2b pin 6): the connect-retry wait and clock, injectable so the backoff is testable without real time. */
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
  /**
   * Additive (Slice 2b fix round, Astra F2): resolves after `ms` unless `signal` aborts first (then it never resolves).
   * Bounds each WHOLE connect/probe attempt by what is left of the start budget.
   */
  deadline: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Additive (fix round F2): the upstream connector, injectable so a slow or hanging attempt is testable. */
  connectUpstreams: typeof connectUpstreams;
}
export interface RunningServer { readonly port: number; readonly head: string; stop(): Promise<void>; }

const defaults: ServerDeps = {
  createLedger: realCreateLedger, log: (line) => process.stderr.write(`${JSON.stringify(line)}\n`),
  sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }), clock: () => Date.now(),
  deadline: (ms, signal) => new Promise((done) => {
    const t = setTimeout(done, ms); t.unref();
    signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  }),
  connectUpstreams,
};
const now = () => new Date().toISOString();

/**
 * Start order (pin 8): env → registry → identity → hmac key → secrets → ledger + `head()` → upstreams → pipeline
 * (`approvals: { kind: "none" }`) → front. Any failure logs `{ event: "refused", reason }` and throws StartupRefused;
 * the reason never carries the ledger URL, a password, a key or a token.
 */
export async function startServer(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerDeps> = {}): Promise<RunningServer> {
  const deps = { ...defaults, ...overrides };
  const secretsToStrip: string[] = [];
  const redact = (reason: string): string => {
    let clean = reason;
    // longest first, so the full URL (which contains the password) is redacted before the password alone would break it
    for (const s of [...secretsToStrip].sort((a, b) => b.length - a.length)) if (s.length > 0) clean = clean.split(s).join("[redacted]");
    return clean;
  };
  const refuse = (reason: string): never => {
    const clean = redact(reason);
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
  const approvalsKind = env[ENV.approvals];
  if (approvalsKind !== "none" && approvalsKind !== "slack") refuse(`${ENV.approvals} must be "none" or "slack" (got ${approvalsKind === undefined ? "nothing" : JSON.stringify(approvalsKind).slice(0, 32)})`);
  const tlsMode = env[ENV.tls];
  if (tlsMode !== "on" && tlsMode !== "off") refuse(`${ENV.tls} must be "on" or "off" (got ${tlsMode === undefined ? "nothing: no silent plaintext, ADR-017" : JSON.stringify(tlsMode).slice(0, 32)})`);
  const budgetRaw = env[ENV.connectBudget] ?? String(DEFAULT_CONNECT_BUDGET_MS);
  if (!/^\d{1,6}$/.test(budgetRaw) || Number(budgetRaw) > MAX_CONNECT_BUDGET_MS) refuse(`${ENV.connectBudget} must be an integer 0-${MAX_CONNECT_BUDGET_MS}`);
  const connectBudgetMs = Number(budgetRaw);

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
  // 4b. approvals.yaml (slack only; Slice 2b pin 5) and the TLS pair (ADR-017): read before anything connects, so a config
  // mistake refuses fast. Tokens stay files: the channel names them, the approvals module reads them (pin 1 readSecret).
  let approvalsConfig: ApprovalsConfig | undefined;
  if (approvalsKind === "slack") {
    try { approvalsConfig = readApprovalsConfig(join(dir, CONFIG_FILES.approvals), { maxTimeoutMs: slack.SLACK_PROXY_MAX_TIMEOUT_MS, productionApiBaseUrl: slack.SLACK_API_BASE_URL }); }
    catch (e) { return refuse(message(e)); }
  }
  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (tlsMode === "on") {
    let cert: Buffer;
    try { cert = Buffer.from(readConfigFile(join(dir, CONFIG_FILES.tlsCert)), "utf8"); }
    catch (e) { return refuse(`${CONFIG_FILES.tlsCert}: ${e instanceof Error && e.message === "Unsafe configuration permissions" ? "unsafe permissions or owner" : "cannot be read"}`); }
    if (cert.length === 0 || cert.length > TLS_CERT_MAX_BYTES || !cert.includes("-----BEGIN CERTIFICATE-----")) refuse(`${CONFIG_FILES.tlsCert}: must be a PEM certificate of at most ${TLS_CERT_MAX_BYTES} bytes`);
    let key: Buffer;
    try { key = readPrivateFile(join(dir, CONFIG_FILES.tlsKey), TLS_KEY_MAX_BYTES); } catch (e) { return refuse(message(e)); }
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key.toString("latin1"))) refuse(`${CONFIG_FILES.tlsKey}: must be a PEM private key`);
    tls = { cert, key };
  } else {
    deps.log({ ts: now(), event: "warning", tls: "off" });
  }
  /**
   * Pin 6 backoff: attempt, and on failure wait 1, 2, 4, 8, 16, 16, … s while the budget allows; the last reason is
   * returned. Fix round F2: every attempt races the time left of max(budget, START_SINGLE_ATTEMPT_MAX_MS); an attempt
   * still pending at that deadline is abandoned and, if it ever succeeds, `dispose`d (no late activation), and a
   * success that arrives after the deadline (per the injected clock) is disposed and refused as well.
   */
  const startDeadlineMs = Math.max(connectBudgetMs, START_SINGLE_ATTEMPT_MAX_MS);
  const retrying = async <T>(what: string, attempt: () => Promise<T>, dispose: (v: T) => Promise<unknown> | unknown = () => undefined): Promise<{ ok: true; value: T } | { ok: false; reason: string }> => {
    const started = deps.clock();
    const left = () => startDeadlineMs - (deps.clock() - started);
    const late = (n: number) => `attempt ${n} did not finish within the ${startDeadlineMs} ms start budget`;
    const disposeQuietly = (v: T) => { void Promise.resolve().then(() => dispose(v)).catch(() => undefined); };
    for (let n = 1; ; n++) {
      const ac = new AbortController();
      const p = Promise.resolve().then(attempt);
      type Outcome = { kind: "ok"; value: T } | { kind: "error"; error: unknown } | { kind: "late" };
      const outcome: Outcome = await Promise.race([
        p.then((value): Outcome => ({ kind: "ok", value }), (error: unknown): Outcome => ({ kind: "error", error })),
        deps.deadline(Math.max(0, left()), ac.signal).then((): Outcome => ({ kind: "late" })),
      ]);
      ac.abort();
      if (outcome.kind === "late") { p.then(disposeQuietly, () => undefined); return { ok: false, reason: late(n) }; }
      if (outcome.kind === "ok") {
        if (left() < 0) { disposeQuietly(outcome.value); return { ok: false, reason: late(n) }; }
        return { ok: true, value: outcome.value };
      }
      const reason = message(outcome.error);
      const nextInMs = CONNECT_BACKOFF_MS[Math.min(n - 1, CONNECT_BACKOFF_MS.length - 1)]!;
      if (deps.clock() - started + nextInMs > connectBudgetMs) return { ok: false, reason };
      deps.log({ ts: now(), event: `${what}-retry`, attempt: n, nextInMs, reason: redact(reason) });
      await deps.sleep(nextInMs);
    }
  };
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
  // Config errors refuse at once; connect failures (network, 5xx, an auth or era refusal) are retried under the budget
  // (pin 6: "slower, never wrong"), then refused with the last value-free reason.
  let upstreamConfig;
  try { upstreamConfig = readUpstreamsConfig(join(dir, CONFIG_FILES.upstreams)); } catch (e) { return refuse(`upstreams: ${message(e)}`); }
  const connected = await retrying("upstreams", () => deps.connectUpstreams(upstreamConfig, secrets), (u) => u.close());
  if (!connected.ok) return refuse(`upstreams: ${connected.reason}`);
  const upstream: Upstream = connected.value;
  const tools = await upstream.listTools();
  const upstreamsLine: LogLine = { ts: now(), event: "upstreams", servers: [...new Set(tools.map((t) => t.server))], tools: tools.length, eras: upstreamEras(upstream, upstreamConfig.map((c) => c.name)) };
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
  // 6b. Slack (pin 6): configure (only when the YAML names a base URL) → validate → live probe under the same backoff.
  let approvals: ApprovalChannel = { kind: "none" };
  if (approvalsConfig !== undefined) {
    const channel: SlackChannel = {
      kind: "slack", transport: "socket-mode", channelId: approvalsConfig.channelId, approvers: approvalsConfig.approvers, timeoutMs: approvalsConfig.timeoutMs,
      botToken: { kind: "file", path: join(dir, CONFIG_FILES.secretsDir, SLACK_TOKEN_FILES.botToken) },
      appToken: { kind: "file", path: join(dir, CONFIG_FILES.secretsDir, SLACK_TOKEN_FILES.appToken) },
    };
    const slackRefuse = async (reason: string): Promise<never> => { await slack.closeSlackApprovals().catch(() => undefined); await upstream.close().catch(() => undefined); return refuse(`approvals: ${reason}`); };
    try { if (approvalsConfig.apiBaseUrl !== undefined) slack.configureSlackApprovals({ apiBaseUrl: approvalsConfig.apiBaseUrl }); }
    catch (e) { return slackRefuse(`configureSlackApprovals failed (${message(e)})`); }
    let problems: string[];
    try { problems = await validateSlackChannel(channel); } catch (e) { return slackRefuse(`validateSlackChannel failed (${message(e)})`); }
    if (problems.length > 0) return slackRefuse(problems.join("; "));
    const probed = await retrying("approvals", async () => { const r = await slack.probeSlack(channel); if (!r.ok) throw new Error(r.reason); return r; });
    if (!probed.ok) return slackRefuse(`Slack probe failed (${probed.reason})`);
    deps.log({ ts: now(), event: "approvals", kind: "slack", channelId: channel.channelId, approvers: channel.approvers.length, timeoutMs: channel.timeoutMs, teamId: probed.value.teamId });
    approvals = channel;
  }
  let pipeline;
  try {
    pipeline = createPipeline({ identity, registry, ledger: observed, upstream, approvals, argsHmacKey });
  } catch (e) {
    if (approvals.kind === "slack") await slack.closeSlackApprovals().catch(() => undefined);
    await upstream.close().catch(() => undefined); return refuse(`pipeline: ${message(e)}`);
  }
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
  // 8. front. ADR-018 §1: the front authenticates every request through the same identity hash lookup BEFORE reading a
  // body or answering any method; the pipeline re-resolves per call (defense in depth).
  const authenticateBearer = async (bearer: string): Promise<string | undefined> => {
    try { return await identity.resolveAgent({ kind: "api_key", value: bearer }); } catch { return undefined; }
  };
  let front: RunningFront;
  try { front = await startFront(handler, withTls({ mode: "http", port, bindHost, allowedOrigins, maxInFlight, drainTimeoutMs: SHUTDOWN_DRAIN_MS, tools: () => upstream.listTools(), authenticate: authenticateBearer }, tls)); }
  catch (e) {
    if (approvals.kind === "slack") await slack.closeSlackApprovals().catch(() => undefined);
    await upstream.close().catch(() => undefined); return refuse(`front: ${message(e)}`);
  }
  deps.log({ ts: now(), event: "listening", port: front.port, bindHost, approvals: approvals.kind, tls: tlsMode, allowedOrigins: allowedOrigins.length, maxInFlight });
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
      // Slice 2b pin 6 (amends F3): pending approvals settle `unavailable` FIRST, so no admitted call waits minutes on a
      // human while the front drains; the pipeline records each as a deny.
      if (approvals.kind === "slack") await slack.closeSlackApprovals().catch(() => undefined);
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
