#!/usr/bin/env node
import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as hooks from "../hooks/contract.js";
import { createPipeline, type PipelineDeps } from "../pipeline/contract.js";
import { createLedger } from "../ledger/contract.js";
import { createIdentity } from "../identity/contract.js";
import { loadRegistry } from "../policy/contract.js";
import { createAnchor } from "../anchor/contract.js";
import { generateReport } from "../report/contract.js";
import type { HookAgent } from "../types/index.js";

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
  generateReport: typeof generateReport;
  hooks: {
    parseHookInput(raw: string, agent: HookAgent): hooks.AnyHookEvent;
    toIncomingCall: typeof hooks.toIncomingCall;
    toOutcome: typeof hooks.toOutcome;
    formatPreToolUseOutput: typeof hooks.formatPreToolUseOutput;
  };
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
const defaults: CliDeps = {
  stdin, stdout: s => { process.stdout.write(s); }, stderr: s => { process.stderr.write(s); },
  createPipeline, createLedger, createIdentity, loadRegistry, createAnchor, generateReport, hooks,
  registryExamplePath: resolve(here, "../../policies/tools.example.yaml"),
};
class UsageError extends Error {}
const usage = "Usage: agent-ledger init [--dir d] | hook --agent claude-code|codex --event pre|post [--dir d] | verify [--dir d] | report --from RFC3339 --to RFC3339 --out d [--dir d] | install-hooks --print [--dir d]";
// POSIX shell quoting is required: hook commands are shell strings, not argv arrays.
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const command = (args: string[]) => args.map((v, i) => i > 0 && /^[a-zA-Z0-9_-]+$/.test(v) ? v : quote(v)).join(" ");

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
  const handler = (event: string) => [process.execPath, main, "hook", "--agent", "claude-code", "--event", event, "--dir", dir];
  const pre = [process.execPath, watchdog, "--agent", "claude-code", "--deadline-ms", String(hooks.DEFAULT_DEADLINE_MS), "--timeout-s", String(hooks.HOOK_TIMEOUT_S), "--", ...handler("pre")];
  const entry = (argv: string[]) => [{ matcher: "", hooks: [{ type: "command", command: command(argv), timeout: hooks.HOOK_TIMEOUT_S }] }];
  return JSON.stringify({ hooks: { PreToolUse: entry(pre), PostToolUse: entry(handler("post")), PostToolUseFailure: entry(handler("post")) } }, null, 2) + "\n";
}

/** Returns an exit code; never exits the embedding test process. Only hook JSON goes to hook stdout. */
export async function main(argv: string[] = process.argv.slice(2), overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps = { ...defaults, ...overrides };
  let post = false;
  try {
    const name = argv[0];
    const options: Record<string, { type: "string" | "boolean" }> = { dir: { type: "string" } };
    if (name === "hook") Object.assign(options, { agent: { type: "string" }, event: { type: "string" } });
    else if (name === "report") Object.assign(options, { from: { type: "string" }, to: { type: "string" }, out: { type: "string" } });
    else if (name === "install-hooks") options.print = { type: "boolean" };
    else if (name !== "init" && name !== "verify") throw new UsageError(usage);
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
      const a = string("agent"), event = string("event");
      if ((a !== "claude-code" && a !== "codex") || (event !== "pre" && event !== "post")) throw new UsageError(usage);
      agent = a; post = event === "post";
    }
    // Validate report arguments before touching a ledger or producing output.
    const range = name === "report" ? { from: string("from"), to: string("to") } : undefined;
    const outDir = name === "report" ? resolve(string("out")) : undefined;
    if (range) {
      const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i;
      if (![range.from, range.to].every(s => instant.test(s) && Number.isFinite(Date.parse(s))) || Date.parse(range.from) > Date.parse(range.to)) throw new UsageError(usage);
    }
    if (!(await stat(join(dir, "ledger"))).isDirectory()) throw new Error("Initialize first");
    const ledger = deps.createLedger("jsonl", join(dir, "ledger", "records.jsonl"));
    if (name === "report") {
      const files = await deps.generateReport(ledger, range!, outDir!);
      deps.stdout(JSON.stringify({ ...files, htmlPath: join(outDir!, "report.html") }) + "\n"); return 0;
    }
    if (name === "verify") {
      let before: string | null = null;
      try { before = await ledger.head(); } catch { /* verify still reports a damaged tail */ }
      const chain = await ledger.verify();
      if (chain.ok && before === null) throw new Error("Unable to capture ledger head");
      const latest = await deps.createAnchor("file", join(dir, "anchors.jsonl")).latest();
      let status = "missing";
      if (!chain.ok) status = "untrusted";
      else if (latest) {
        status = latest.hash === before ? "head" : latest.hash === "0" ? "ancestor" : "mismatch";
        if (status === "mismatch") for await (const record of ledger.read({ from: "0100-01-01T00:00:00.000Z", to: "9999-12-31T23:59:59.999Z" })) {
          if (record.hash === latest.hash) { status = "ancestor"; break; }
        }
      }
      if (chain.ok && await ledger.head() !== before) throw new Error("Ledger changed; retry");
      deps.stdout(JSON.stringify({ chain, head: before, anchor: { status, latest }, note: "Local file anchors are editable on this machine. An ancestor anchors only a prefix; missing means no truncation check. Verification does not establish enforcement." }) + "\n");
      return !chain.ok || status === "mismatch" ? 1 : status === "missing" ? 3 : 0;
    }
    const raw = await deps.stdin();
    const ev = deps.hooks.parseHookInput(raw, agent);
    if ((ev.hook_event_name === "PreToolUse") === post) throw new Error("Hook event mismatch");
    const key = await privateFile(join(dir, "hmac.key"), 32);
    if (key.length !== 32) throw new Error("Invalid HMAC key");
    const value = (await privateFile(join(dir, "credential"), 256)).toString("utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid local credential");
    const identity = deps.createIdentity("file", join(dir, "agents.yaml"));
    const registry = await deps.loadRegistry(join(dir, "registry.yaml"));
    const pipelineDeps = {
      identity, registry, ledger, argsHmacKey: key, approvals: { kind: "hook-ask" as const }, hookAgent: agent,
      upstream: { async execute() { throw new Error("Decide-only CLI cannot execute tools"); }, async listTools() { throw new Error("Decide-only CLI cannot list tools"); }, async close() {} },
    } as PipelineDeps & { argsHmacKey: Uint8Array }; // PIN-1: remove cast once Fable's required field lands.
    // Post hooks run directly. Supply construction-only timing for the frozen pipeline init check;
    // no pre decision is made here, and no watchdog enforcement is claimed for a post event.
    const priorDeadline = process.env[hooks.WATCHDOG_DEADLINE_AT_ENV];
    if (post) process.env[hooks.WATCHDOG_DEADLINE_AT_ENV] = String(Date.now() + hooks.DEFAULT_DEADLINE_MS);
    let pipeline: ReturnType<typeof createPipeline>;
    try { pipeline = deps.createPipeline(pipelineDeps); }
    finally {
      if (post) {
        if (priorDeadline === undefined) delete process.env[hooks.WATCHDOG_DEADLINE_AT_ENV];
        else process.env[hooks.WATCHDOG_DEADLINE_AT_ENV] = priorDeadline;
      }
    }
    if (ev.hook_event_name !== "PreToolUse") await pipeline.recordOutcome(ev.tool_use_id, deps.hooks.toOutcome(ev, agent));
    else {
      const decision = await pipeline.decide(deps.hooks.toIncomingCall(ev, { kind: "local", value }, agent));
      deps.stdout(deps.hooks.formatPreToolUseOutput(decision, agent).trimEnd() + "\n");
    }
    return 0;
  } catch (error) {
    // Do not echo parser/registry exceptions: they may contain raw tool args or credentials.
    deps.stderr(error instanceof UsageError ? usage + "\n" : post ? "agent-ledger: post outcome was not recorded; check local configuration and ledger\n" : "agent-ledger: command failed; check local configuration, permissions, output paths and ledger\n");
    return post ? 0 : error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
