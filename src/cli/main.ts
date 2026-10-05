#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import canonicalize from "canonicalize";
import * as hooks from "../hooks/contract.js";
import { createPipeline, type PipelineDeps } from "../pipeline/contract.js";
import { createLedger, type LedgerStore } from "../ledger/contract.js";
import { createIdentity } from "../identity/contract.js";
import { loadRegistry } from "../policy/contract.js";
import { createAnchor, type Anchor, type AnchorEntry } from "../anchor/contract.js";
import { generateReport, HANDOFF_RECONCILE_GRACE_MS, type AnchorStatus, type ReportContext, type ReportFiles } from "../report/contract.js";
import { checkedRange } from "../report/render.js";
import type { DateRange, HookAgent, SessionHeartbeat, VerifyResult } from "../types/index.js";

// pin 6 (Slice 1c): the report context is defined once, in src/report/contract.ts.
export type { AnchorStatus, ReportContext };

/** The CLI is the process composition root; ordering inside a call belongs to the pipeline. */
export interface CliDeps {
  stdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  createPipeline: typeof createPipeline;
  createLedger: typeof createLedger;
  createIdentity: typeof createIdentity;
  loadRegistry: typeof loadRegistry;
  createAnchor: typeof createAnchor;
  generateReport: (ledger: LedgerStore, range: DateRange, outDir: string, context?: ReportContext) => Promise<ReportFiles>;
  hooks: {
    parseHookInput(raw: string, agent: HookAgent): hooks.AnyHookEvent;
    toIncomingCall: typeof hooks.toIncomingCall;
    toHeartbeat: typeof hooks.toHeartbeat;
    toOutcome: typeof hooks.toOutcome;
    formatPreToolUseOutput: typeof hooks.formatPreToolUseOutput;
  };
  /** What the session-start handler measures about its own process (pin 5); injected so unit tests need no watchdog. */
  heartbeatProbe(agent: HookAgent): Promise<hooks.HeartbeatProbe>;
  registryExamplePath: string;
}
const here = dirname(fileURLToPath(import.meta.url));
async function stdin(): Promise<string> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk); size += b.length;
    if (size > hooks.MAX_STDIN_BYTES) throw new Error("Hook input exceeds limit");
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The watchdog self-test's clocks (pin 5): a 1 s deadline under a 3 s hook timeout, and a 3 s hard cap on the whole probe. */
export const WATCHDOG_SELF_TEST = { deadlineMs: 1_000, timeoutS: 3, capMs: 3_000 } as const;
const isErrno = (e: unknown, code: string) => typeof e === "object" && e !== null && (e as { code?: string }).code === code;
/** After the watchdog EXITS, how long its pipes may stay open (a descendant holding them) before the probe gives up on `close`. */
export const WATCHDOG_SELF_TEST_CLOSE_GRACE_MS = 500;
/**
 * Runs the REAL compiled watchdog once with a trivial handler that prints one valid allow line (pin 5): exit 0 and
 * output that passes the hooks module's STRICT `validateHandlerOutput` with decision `allow` → "ok"; ENOENT on the
 * watchdog file → "missing"; anything else (non-zero exit; output the validator rejects: missing reason, extra or
 * duplicate keys, several values, a deny/ask, oversized, empty; the cap; pipes still held after exit; a spawn failure)
 * → "failed" (Astra 1c P2 #2, 2026-10-03). Its stdout and stderr are captured, never ours: the handler prints nothing.
 *
 * Lifetime (Astra 1c P2 #1): the watchdog is spawned as its own process-group leader; every terminal path kills that
 * group if it is still running, destroys our three pipe handles and unrefs the child, so a descendant that inherited
 * the watchdog's stdio (a preload, a broken entry point) can neither keep this process's event loop alive past the cap
 * nor outlive the probe. Node: `close` fires only once ALL stdio streams close, and other processes may share them
 * (nodejs.org/api/child_process.html#event-close, read 2026-10-03).
 */
async function watchdogSelfTest(agent: HookAgent): Promise<SessionHeartbeat["watchdogCheck"]> {
  const watchdog = resolve(here, "../hooks/watchdog-main.js");
  try { if (!(await stat(watchdog)).isFile()) return "failed"; } catch (e) { return isErrno(e, "ENOENT") ? "missing" : "failed"; }
  const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "agent-ledger: watchdog self-test" } });
  const argv = [watchdog, "--agent", agent, "--deadline-ms", String(WATCHDOG_SELF_TEST.deadlineMs), "--timeout-s", String(WATCHDOG_SELF_TEST.timeoutS),
    "--", process.execPath, "-e", `process.stdout.write(${JSON.stringify(allow)})`];
  return new Promise((done) => {
    let settled = false; let out = ""; let overflow = false; let exitCode: number | null | undefined;
    const timers: NodeJS.Timeout[] = [];
    let child: ReturnType<typeof spawn> | undefined;
    const release = () => {
      for (const t of timers) clearTimeout(t);
      if (!child) return;
      // The group outlives its leader while any member runs (POSIX keeps the pgid reserved), so this also reaps a
      // descendant left behind by a watchdog that exited normally; ESRCH means nothing is left.
      if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* nothing left in the group */ } }
      if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
      for (const s of [child.stdin, child.stdout, child.stderr]) { try { s?.destroy(); } catch { /* already closed */ } }
      try { child.unref(); } catch { /* not a handle any more */ }
    };
    const finish = (result: SessionHeartbeat["watchdogCheck"]) => { if (settled) return; settled = true; release(); done(result); };
    const verdict = (): SessionHeartbeat["watchdogCheck"] => {
      if (exitCode !== 0 || overflow) return "failed";
      const v = hooks.validateHandlerOutput(out, agent);
      return v.ok && v.payload.hookSpecificOutput.permissionDecision === "allow" ? "ok" : "failed";
    };
    try { child = spawn(process.execPath, argv, { stdio: ["pipe", "pipe", "pipe"], detached: true }); } catch { finish("failed"); return; }
    timers.push(setTimeout(() => finish("failed"), WATCHDOG_SELF_TEST.capMs));
    child.stdout?.on("data", (d: Buffer) => { if (overflow) return; out += d.toString("utf8"); if (Buffer.byteLength(out, "utf8") > hooks.MAX_MAX_OUTPUT_BYTES) overflow = true; });
    child.stderr?.resume();
    child.stdin?.on("error", () => { /* the watchdog may exit before reading */ });
    child.stdin?.end("{}");
    child.on("error", () => finish("failed"));
    // `exit` says the watchdog is gone; `close` additionally needs every pipe closed. A descendant can hold the pipes open
    // indefinitely, so after `exit` the probe waits a short grace for `close` and then calls the probe failed.
    child.on("exit", (code) => { exitCode = code; timers.push(setTimeout(() => finish("failed"), WATCHDOG_SELF_TEST_CLOSE_GRACE_MS)); });
    child.on("close", (code) => { if (exitCode === undefined) exitCode = code; finish(verdict()); });
  });
}
async function heartbeatProbe(agent: HookAgent): Promise<hooks.HeartbeatProbe> {
  // The NODE_OPTIONS VALUE is never read into the record: only whether it is set (pin 1).
  return { interpreter: realpathSync(process.execPath), nodeOptionsSet: (process.env["NODE_OPTIONS"] ?? "") !== "", watchdogCheck: await watchdogSelfTest(agent) };
}

const defaults: CliDeps = {
  stdin, stdout: s => { process.stdout.write(s); }, stderr: s => { process.stderr.write(s); },
  createPipeline, createLedger, createIdentity, loadRegistry, createAnchor, generateReport, hooks, heartbeatProbe,
  registryExamplePath: resolve(here, "../../policies/tools.example.yaml"),
};
class UsageError extends Error {}
const usage = "Usage: agent-ledger init [--dir d] | hook --agent claude-code|codex --event pre|post|session-start|denied [--dir d] | anchor [--dir d] [--ledger postgres://user@host:port/db] | verify [--dir d] [--ledger url] | report --from RFC3339 --to RFC3339 --out d [--dir d] [--ledger url] | install-hooks --print [--dir d]";
// POSIX shell quoting is required: hook commands are shell strings, not argv arrays.
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const command = (args: string[]) => args.map((v, i) => i > 0 && /^[a-zA-Z0-9_-]+$/.test(v) ? v : quote(v)).join(" ");

/** The `--event` flags and the hook event names each one accepts (pin 5). `pre` is the only one that decides and runs under the watchdog. */
export const HOOK_EVENT_FLAGS = { pre: ["PreToolUse"], post: ["PostToolUse", "PostToolUseFailure"], "session-start": ["SessionStart"], denied: ["PermissionDenied"] } as const;
type HookEventFlag = keyof typeof HOOK_EVENT_FLAGS;
const isHookEventFlag = (v: string): v is HookEventFlag => Object.hasOwn(HOOK_EVENT_FLAGS, v);
/** Record-only handlers never block the agent: their failures go to stderr (one fixed line, never exception text) and exit 0. */
const RECORD_ONLY_FAILURE: Record<Exclude<HookEventFlag, "pre">, string> = {
  post: "agent-ledger: post outcome was not recorded; check local configuration and ledger\n",
  "session-start": "agent-ledger: session heartbeat was not recorded; check local configuration and ledger\n",
  denied: "agent-ledger: denial outcome was not recorded; check local configuration and ledger\n",
};

export const ANCHOR_NOTE = "This anchor is one line in a local file (anchors.jsonl) that this machine's owner can edit. Copy `line` off-machine now (git, e-mail, S3) for it to mean anything: it detects tail truncation only relative to the copy you keep. It does not establish enforcement.";
const VERIFY_NOTE = "Local file anchors are editable on this machine. An ancestor anchors only a prefix; missing means no truncation check. Verification does not establish enforcement.";
const ALL_TIME: DateRange = { from: "0100-01-01T00:00:00.000Z", to: "9999-12-31T23:59:59.999Z" };

async function privateFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()) || info.size > maxBytes) throw new Error("Invalid private file");
    return await file.readFile();
  } finally { await file.close(); }
}

async function init(dir: string, deps: CliDeps): Promise<void> {
  // Validate the shipped example BEFORE creating files. Preserve its reviewers; do not self-approve new policy.
  const registry = await deps.loadRegistry(deps.registryExamplePath);
  // The example proxy identity is documentation, not a configured local proxy. Leave it disabled at init.
  const localRegistry = { version: registry.version, servers: registry.servers };
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir, { mode: 0o700 }); // EEXIST refuses any existing configuration, even partial init.
  const credential = randomBytes(32).toString("hex");
  const files: [string, string | Buffer][] = [
    ["hmac.key", randomBytes(32)], ["credential", credential + "\n"],
    ["agents.yaml", JSON.stringify({ version: 1, agents: [{ id: "local-agent", credential: { kind: "local", sha256: createHash("sha256").update(credential).digest("hex") } }] }, null, 2) + "\n"],
    ["registry.yaml", JSON.stringify(localRegistry, null, 2) + "\n"], // JSON is a YAML subset.
  ];
  for (const [name, data] of files) await writeFile(join(dir, name), data, { flag: "wx", mode: 0o600 });
  await mkdir(join(dir, "ledger"), { mode: 0o700 });
}

function printHooks(dir: string): string {
  const main = resolve(here, "main.js"), watchdog = resolve(here, "../hooks/watchdog-main.js");
  const handler = (event: HookEventFlag) => [process.execPath, main, "hook", "--agent", "claude-code", "--event", event, "--dir", dir];
  const pre = [process.execPath, watchdog, "--agent", "claude-code", "--deadline-ms", String(hooks.DEFAULT_DEADLINE_MS), "--timeout-s", String(hooks.HOOK_TIMEOUT_S), "--", ...handler("pre")];
  const entry = (argv: string[]) => [{ matcher: "", hooks: [{ type: "command", command: command(argv), timeout: hooks.HOOK_TIMEOUT_S }] }];
  // Only PreToolUse decides, so only it runs under the watchdog; the four record-only events are direct commands (pin 5).
  return JSON.stringify({ hooks: { PreToolUse: entry(pre), PostToolUse: entry(handler("post")), PostToolUseFailure: entry(handler("post")), SessionStart: entry(handler("session-start")), PermissionDenied: entry(handler("denied")) } }, null, 2) + "\n";
}

/**
 * The one anchor-status computation `verify` and `report` share (pin 5): `untrusted` when the chain failed; otherwise
 * `missing` (no anchor, or the genesis "0"), `head` (latest anchor == observed head), `ancestor` (latest anchor is an
 * earlier record's hash, so only that prefix is anchored) or `mismatch` (latest anchor is nowhere in the chain).
 * `anchor.latest()` throws on a torn anchor file; that is an exit 1, never a status.
 */
export async function anchorState(ledger: LedgerStore, anchor: Anchor, head: string | null, chainOk: boolean): Promise<{ status: AnchorStatus; latest: AnchorEntry | null }> {
  const latest = await anchor.latest();
  let status: AnchorStatus = "missing";
  if (!chainOk) status = "untrusted";
  else if (latest) {
    status = latest.hash === "0" ? "missing" : latest.hash === head ? "head" : "mismatch";
    if (status === "mismatch") for await (const record of ledger.read(ALL_TIME)) if (record.hash === latest.hash) { status = "ancestor"; break; }
  }
  return { status, latest };
}

/** Returns an exit code; never exits the embedding test process. Only hook JSON goes to hook stdout. */
export async function main(argv: string[] = process.argv.slice(2), overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps = { ...defaults, ...overrides };
  let event: HookEventFlag | undefined;
  try {
    const name = argv[0];
    const options: Record<string, { type: "string" | "boolean" }> = { dir: { type: "string" } };
    if (name === "hook") Object.assign(options, { agent: { type: "string" }, event: { type: "string" } });
    else if (name === "report") Object.assign(options, { from: { type: "string" }, to: { type: "string" }, out: { type: "string" } });
    else if (name === "install-hooks") options.print = { type: "boolean" };
    else if (name !== "init" && name !== "verify" && name !== "anchor") throw new UsageError(usage);
    // Slice 2a pin 7: only anchor | verify | report take --ledger; strict parsing makes it a usage error (exit 2) elsewhere.
    if (name === "anchor" || name === "verify" || name === "report") options.ledger = { type: "string" };
    let values: ReturnType<typeof parseArgs>["values"];
    try {
      const parsed = parseArgs({ args: argv.slice(1), options, strict: true, allowPositionals: false, tokens: true });
      const seen = new Set<string>();
      for (const token of parsed.tokens) if (token.kind === "option") {
        if (seen.has(token.name)) throw new Error("Duplicate option"); seen.add(token.name);
      }
      values = parsed.values;
    } catch { throw new UsageError(usage); }
    const string = (key: string, fallback?: string): string => {
      const value = values[key] ?? fallback;
      if (typeof value !== "string" || !value.length || value.includes("\0")) throw new UsageError(usage);
      return value;
    };
    const dir = resolve(string("dir", ".agent-ledger"));
    if (name === "init") { await init(dir, deps); deps.stdout(`Initialized local ledger at ${dir}\n`); return 0; }
    if (name === "install-hooks") {
      if (values.print !== true) throw new UsageError(usage);
      deps.stdout(printHooks(dir)); return 0;
    }
    let agent: HookAgent = "claude-code";
    if (name === "hook") {
      const a = string("agent"), e = string("event");
      // `denied` is Claude Code's auto-mode PermissionDenied; Codex has no such event (pin 5): a usage error, not a silent exit.
      if ((a !== "claude-code" && a !== "codex") || !isHookEventFlag(e) || (a === "codex" && e === "denied")) throw new UsageError(usage);
      agent = a; event = e;
    }
    // Validate report arguments before touching a ledger or producing output.
    const range = name === "report" ? { from: string("from"), to: string("to") } : undefined;
    const outDir = name === "report" ? resolve(string("out")) : undefined;
    if (range) {
      try { checkedRange(range, HANDOFF_RECONCILE_GRACE_MS); } catch { throw new UsageError(usage); }
    }
    // Slice 2a pin 7: `--ledger postgres://user@host:port/db` reads the server-mode ledger instead of the jsonl file. The
    // password is never on the command line (`pg` reads PGPASSWORD / libpq variables); the URL is never printed. `--dir`
    // still holds anchors.jsonl (the Mac-side, off-machine anchor) and is created when absent; the `<dir>/ledger` check is skipped.
    let ledger: LedgerStore;
    if (values.ledger !== undefined) {
      const url = string("ledger");
      if (!/^postgres(ql)?:\/\//.test(url)) throw new UsageError(usage);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      ledger = deps.createLedger("postgres", url);
    } else {
      if (!(await stat(join(dir, "ledger"))).isDirectory()) throw new Error("Initialize first");
      ledger = deps.createLedger("jsonl", join(dir, "ledger", "records.jsonl"));
    }
    const anchorsPath = join(dir, "anchors.jsonl");
    if (name === "report") {
      // The anchor status is computed exactly as `verify` does (own head + own chain pass) and handed to the report
      // (pin 6). The report then verifies again itself; stdout carries THAT result, so the pack and the exit code agree.
      let before: string | null = null;
      try { before = await ledger.head(); } catch { /* a damaged tail is an untrusted chain below */ }
      const own = await ledger.verify();
      if (own.ok && before === null) throw new Error("Unable to capture ledger head");
      const anchor = await anchorState(ledger, deps.createAnchor("file", anchorsPath), before, own.ok);
      let chain: VerifyResult | undefined;
      const files = await deps.generateReport({
        append: record => ledger.append(record), head: () => ledger.head(), read: range => ledger.read(range),
        verify: async () => { chain = await ledger.verify(); return chain; },
      }, range!, outDir!, { anchor });
      if (!chain) throw new Error("Report did not verify the ledger");
      if (own.ok && await ledger.head() !== before) throw new Error("Ledger changed; retry");
      deps.stdout(JSON.stringify({ ...files, htmlPath: join(outDir!, "report.html"), chain, anchor }) + "\n");
      return chain.ok && anchor.status !== "mismatch" ? 0 : 1;
    }
    if (name === "verify") {
      let before: string | null = null;
      try { before = await ledger.head(); } catch { /* verify still reports a damaged tail */ }
      const chain = await ledger.verify();
      if (chain.ok && before === null) throw new Error("Unable to capture ledger head");
      const anchor = await anchorState(ledger, deps.createAnchor("file", anchorsPath), before, chain.ok);
      if (chain.ok && await ledger.head() !== before) throw new Error("Ledger changed; retry");
      deps.stdout(JSON.stringify({ chain, head: before, anchor, note: VERIFY_NOTE }) + "\n");
      return !chain.ok || anchor.status === "mismatch" ? 1 : anchor.status === "missing" ? 3 : 0;
    }
    if (name === "anchor") {
      // pin 5: anchor the CURRENT head, and only a head the chain vouches for. Never changes the ledger. Re-anchoring the
      // same head appends another line on purpose (a time series of "the chain ended here at this time").
      let before: string | null = null;
      try { before = await ledger.head(); } catch { /* a damaged tail is a chain failure below */ }
      const chain = await ledger.verify();
      const refuse = (reason: "chain-failed" | "empty-ledger" | "ledger-changed" | "anchor-mismatch") => { deps.stdout(JSON.stringify({ anchored: false, reason, chain }) + "\n"); return 1; };
      if (!chain.ok) return refuse("chain-failed");
      if (before === null) throw new Error("Unable to capture ledger head");
      if (before === "0") return refuse("empty-ledger");
      if (await ledger.head() !== before) return refuse("ledger-changed");
      const anchor = deps.createAnchor("file", anchorsPath);
      const state = await anchorState(ledger, anchor, before, chain.ok);
      if (state.status === "mismatch") return refuse("anchor-mismatch");
      if (await ledger.head() !== before) return refuse("ledger-changed");
      const previous = state.latest;
      const entry: AnchorEntry = { hash: before, at: new Date().toISOString() };
      await anchor.write(entry);
      deps.stdout(JSON.stringify({ anchored: true, entry, line: canonicalize(entry), previous, chain, path: anchorsPath, note: ANCHOR_NOTE }) + "\n");
      return 0;
    }
    const raw = await deps.stdin();
    const ev = deps.hooks.parseHookInput(raw, agent);
    if (!(HOOK_EVENT_FLAGS[event!] as readonly string[]).includes(ev.hook_event_name)) throw new Error("Hook event mismatch");
    const key = await privateFile(join(dir, "hmac.key"), 32);
    if (key.length !== 32) throw new Error("Invalid HMAC key");
    const value = (await privateFile(join(dir, "credential"), 256)).toString("utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid local credential");
    const identity = deps.createIdentity("file", join(dir, "agents.yaml"));
    const registry = await deps.loadRegistry(join(dir, "registry.yaml"));
    const pipelineDeps = {
      identity, registry, ledger, argsHmacKey: key, approvals: { kind: "hook-ask" as const }, hookAgent: agent,
      upstream: { async execute() { throw new Error("Decide-only CLI cannot execute tools"); }, async listTools() { throw new Error("Decide-only CLI cannot list tools"); }, async close() {} },
    } satisfies PipelineDeps;
    // ADR-011: construction reads no watchdog clock, so the record-only handlers (post, session-start, denied) need no
    // deadline shim, and `pre` started outside the watchdog can only produce a deny line (decide() checks the deadline).
    const pipeline = deps.createPipeline(pipelineDeps);
    const credential = { kind: "local" as const, value };
    if (event === "pre") {
      const decision = await pipeline.decide(deps.hooks.toIncomingCall(ev as hooks.AnyPreToolUseEvent, credential, agent));
      deps.stdout(deps.hooks.formatPreToolUseOutput(decision, agent).trimEnd() + "\n");
    } else if (event === "session-start") {
      // Configuration is checked above BEFORE the probe spawns anything. Nothing is written to stdout on this path:
      // Claude Code adds SessionStart stdout to Claude's context (hooks reference, read 2026-10-01).
      const probe = await deps.heartbeatProbe(agent);
      await pipeline.recordHeartbeat(deps.hooks.toHeartbeat(ev as hooks.AnySessionStartEvent, agent, probe), credential);
    } else {
      const out = ev as hooks.AnyOutcomeEvent;
      await pipeline.recordOutcome(out.tool_use_id, deps.hooks.toOutcome(out, agent));
    }
    return 0;
  } catch (error) {
    // Do not echo parser/registry exceptions: they may contain raw tool args or credentials.
    const recordOnly = event !== undefined && event !== "pre" ? event : undefined;
    deps.stderr(error instanceof UsageError ? usage + "\n" : recordOnly ? RECORD_ONLY_FAILURE[recordOnly] : "agent-ledger: command failed; check local configuration, permissions, output paths and ledger\n");
    return recordOnly ? 0 : error instanceof UsageError ? 2 : 1;
  }
}

let invokedDirectly = false;
try {
  invokedDirectly = !!process.argv[1] && realpathSync.native(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
} catch { /* An absent/unresolvable argv entry must not run the CLI during an import. */ }
if (invokedDirectly) process.exitCode = await main();
