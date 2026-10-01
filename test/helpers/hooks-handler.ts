// Scripted PreToolUse handler for the watchdog runtime tests (test/hooks-watchdog.test.ts). Spawned by the REAL watchdog
// (.test-build/src/hooks/watchdog-main.js) from the compiled .test-build/test/helpers/hooks-handler.js.
//   argv[2] = mode, argv[3] = parameter (mode-specific). Every mode is deliberately misbehaved except `allow*`, `ask`,
//   `deny`, `env`, `stdin-len` and `real`.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeSync } from "node:fs";
import process from "node:process";
import type { ToolRegistry } from "../../src/policy/contract.js";
import type { LedgerRecord, UnsealedRecord } from "../../src/types/index.js";

const [mode = "", param = ""] = process.argv.slice(2);
// Liveness marker for the tests: proves (or disproves) that the watchdog spawned us, and names our pid while we run.
if (process.env["HOOKS_TEST_PID_FILE"]) appendFileSync(process.env["HOOKS_TEST_PID_FILE"], `${process.pid}\n`);
const out = (s: string) => { writeSync(1, s); };
const err = (s: string) => { writeSync(2, s); };
const payload = (decision: string, reason = "scripted") => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });
const ALLOW = payload("allow", "reviewed read");
const spin = (): never => { process.on("SIGTERM", () => { /* ignored on purpose */ }); for (;;) { /* synchronous, ignores SIGTERM */ } };
/** A child that inherits our (the handler's) stdio pipes and sleeps: it keeps the watchdog's `close` from firing. */
const sleeper = (ms: number, stdio: "inherit" | "ignore", detached = false) =>
  spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio, detached });

switch (mode) {
  case "loop": spin();
  // falls through (never)
  case "junk": out(param); process.exit(0);
  // falls through (never)
  case "oversize": out(ALLOW + "\n" + "#".repeat(100 * 1024)); process.exit(0);
  // falls through (never)
  case "exit1-allow": out(ALLOW); process.exit(1);
  // falls through (never)
  case "exit1-deny": out(payload("deny", "handler said no")); process.exit(1);
  // falls through (never)
  case "exit-code": out(ALLOW); process.exit(Number(param));
  // falls through (never)
  case "exit1-silent": err("agent-ledger: init failed: registry refused\n"); process.exit(1);
  // falls through (never)
  case "signal": process.kill(process.pid, param || "SIGTERM"); setTimeout(() => {}, 5000); break;
  case "multiple": out(ALLOW + "\n" + JSON.stringify({ x: 1 }) + "\n"); process.exit(0);
  // falls through (never)
  case "extra-inner": { // param = key name added inside hookSpecificOutput
    const p = JSON.parse(ALLOW) as { hookSpecificOutput: Record<string, unknown> };
    p.hookSpecificOutput[param] = param === "continue" ? false : "junk";
    out(JSON.stringify(p)); process.exit(0);
  }
  // falls through (never)
  case "extra-top": { const p = JSON.parse(ALLOW) as Record<string, unknown>; p[param] = "junk"; out(JSON.stringify(p)); process.exit(0); }
  // falls through (never)
  case "bad-event-name": out(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", permissionDecision: "allow", permissionDecisionReason: "r" } })); process.exit(0);
  // falls through (never)
  case "allow": out(ALLOW); process.exit(0);
  // falls through (never)
  case "allow-ws": out("\n  {  \"hookSpecificOutput\" : { \"permissionDecisionReason\": \"reviewed read\", \"permissionDecision\": \"allow\",\n \"hookEventName\": \"PreToolUse\" }  }\n\n"); process.exit(0);
  // falls through (never)
  case "ask": out(payload("ask", "needs a human")); process.exit(0);
  // falls through (never)
  case "deny": out(payload("deny", param || "policy says no")); process.exit(0);
  // falls through (never)
  case "empty": process.exit(0);
  // falls through (never)
  case "env": {
    const now = Date.now();
    out(payload("allow", `env ${process.env["AGENT_LEDGER_WATCHDOG_DEADLINE_MS"]} ${process.env["AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS"]} ${now}`));
    process.exit(0);
  }
  // falls through (never)
  case "stdin-len": { const data = readFileSync(0); out(payload("allow", `stdin ${data.length} ${data.subarray(0, 40).toString("utf8")}`)); process.exit(0); }
  // falls through (never)
  case "grandchild-sleep": { // valid allow, then exit 0 while a grandchild holds the pipes
    const g = sleeper(60_000, "inherit");
    err(`pid:${process.pid}\npid:${g.pid}\n`);
    out(ALLOW);
    g.unref();
    process.exit(0);
  }
  // falls through (never)
  case "grandchild-append": { // exit 0; the grandchild appends a second JSON value to OUR stdout, then exits
    const g = spawn(process.execPath, ["-e", "setTimeout(() => { process.stdout.write('{\"x\":1}\\n'); }, 300)"], { stdio: "inherit" });
    g.unref();
    out(ALLOW + "\n");
    process.exit(0);
  }
  // falls through (never)
  case "group": { // two children in our group (not detached), then the failure path named by param
    const a = sleeper(60_000, "ignore"); const b = sleeper(60_000, "ignore");
    err(`pid:${process.pid}\npid:${a.pid}\npid:${b.pid}\n`);
    if (process.env["HOOKS_TEST_PID_FILE"]) appendFileSync(process.env["HOOKS_TEST_PID_FILE"], `${a.pid}\n${b.pid}\n`);
    a.unref(); b.unref();
    setTimeout(() => {
      if (param === "loop") spin();
      if (param === "exit1") { out(ALLOW); process.exit(1); }
      if (param === "junk") { out("hello"); process.exit(0); }
      if (param === "allow") { out(ALLOW); process.exit(0); }
      process.exit(3);
    }, 200);
    break;
  }
  case "setsid-escape": { // a detached (setsid) descendant with no pipes survives the group kill: the stated residual
    const g = sleeper(60_000, "ignore", true);
    err(`pid:${process.pid}\nescapee:${g.pid}\n`);
    g.unref();
    spin();
  }
  // falls through (never)
  case "pgid": { err(`pid:${process.pid}\n`); spin(); }
  // falls through (never)
  case "pipeline-init": { // Astra pin 4 shape, updated for ADR-011 (Slice 1c): construct the pipeline, then DECIDE one reviewed read.
    // A construction throw is still a non-zero exit, never a decision (`slack-timeout` with the deadline DURATION present →
    // init:exit-1). With `hook-ask` the printed line is the REAL `decide()` answer, so the watchdog's absolute deadline is
    // exercised: under the watchdog (deadline env present) it is `allow` → exit 0; started without that env the same
    // handler prints a deny carrying WATCHDOG_DEADLINE_DENY_REASON (the integration assertion for the moved watchdog test).
    const { createPipeline } = await import("../../src/pipeline/contract.js");
    const hooks = await import("../../src/hooks/contract.js");
    const registry: ToolRegistry = { version: 1, servers: { "builtin:codex": { trusted: true, tools: { Read: { class: "read", reviewedBy: "hooks-handler", reviewedAt: "2026-10-01" } } } } };
    const identity = { resolveAgent: async () => "a", startSession: async () => "s" };
    const ledger = {
      append: async (r: UnsealedRecord) => ({ ...r, hash: "0".repeat(64), prevHash: "0", parentRecordId: null, writtenAt: new Date().toISOString() }) as unknown as LedgerRecord,
      verify: async () => ({ ok: true, checked: 0 }), head: async () => "0", read: async function* () { /* none */ },
    };
    const upstream = { listTools: async () => [], execute: async () => { throw new Error("decide-only"); }, close: async () => {} };
    const argsHmacKey = new Uint8Array(32);
    const approvals = param === "slack-timeout"
      ? { kind: "slack" as const, channelId: "C012345678", timeoutMs: 300_000, transport: "socket-mode" as const, botToken: { kind: "env" as const, name: "X" }, appToken: { kind: "env" as const, name: "Y" }, approvers: ["U012345678"] }
      : { kind: "hook-ask" as const };
    const pipeline = createPipeline({ identity, registry, ledger, upstream, approvals, hookAgent: "codex", argsHmacKey });
    const decision = await pipeline.decide({ callId: "pipeline-init", credential: { kind: "local", value: "scripted" }, server: "builtin:codex", tool: "Read", args: {}, receivedAt: new Date().toISOString() });
    out(hooks.formatPreToolUseOutput(decision, "codex")); process.exit(0);
  }
  // falls through (never)
  case "real": { // a real decide-only handler: registry + agents + jsonl ledger from env (what Astra's `hook` command does)
    const hooks = await import("../../src/hooks/contract.js");
    const { createPipeline } = await import("../../src/pipeline/contract.js");
    const { loadRegistry } = await import("../../src/policy/contract.js");
    const { createIdentity } = await import("../../src/identity/contract.js");
    const { createLedger } = await import("../../src/ledger/contract.js");
    const agent = (param || "claude-code") as "claude-code" | "codex";
    const env = process.env;
    const registry = await loadRegistry(env["HOOKS_TEST_REGISTRY"]!);
    const identity = createIdentity("file", env["HOOKS_TEST_AGENTS"]!);
    const ledger = createLedger("jsonl", env["HOOKS_TEST_LEDGER"]!);
    const upstream = { listTools: async () => [], execute: async () => { throw new Error("decide-only: never executed"); }, close: async () => {} };
    const pipeline = createPipeline({ identity, registry, ledger, upstream, approvals: { kind: "hook-ask" }, hookAgent: agent, argsHmacKey: Buffer.from(env["HOOKS_TEST_HMAC_KEY_HEX"]!, "hex") });
    const ev = hooks.parseHookInput(readFileSync(0, "utf8"), agent);
    if (ev.hook_event_name !== "PreToolUse") throw new Error("not PreToolUse");
    const incoming = hooks.toIncomingCall(ev, { kind: "local", value: env["HOOKS_TEST_CREDENTIAL"]! }, agent);
    const decision = await pipeline.decide(incoming);
    out(hooks.formatPreToolUseOutput(decision, agent));
    process.exit(0);
  }
  // falls through (never)
  default: err(`hooks-handler: unknown mode ${mode}\n`); process.exit(9);
}
