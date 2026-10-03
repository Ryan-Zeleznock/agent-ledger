import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLedger } from "../src/ledger/contract.js";
import { createAnchor } from "../src/anchor/contract.js";
import { pathToFileURL } from "node:url";
import { MAX_MAX_OUTPUT_BYTES, MAX_STDIN_BYTES, WATCHDOG_DEADLINE_AT_ENV, WATCHDOG_DEADLINE_ENV } from "../src/hooks/contract.js";
import { WATCHDOG_SELF_TEST } from "../src/cli/main.js";
import { unsealed } from "./helpers/ledger-fixtures.js";

const dirs: string[] = [];
const cli = resolve("dist/cli/main.js");
beforeAll(() => { execFileSync("npm", ["run", "build"], { stdio: "pipe" }); });
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function sandbox() { const d = await mkdtemp(join(tmpdir(), "cli-process-")); dirs.push(d); return d; }
function run(cwd: string, args: string[], input = "") { return spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: "utf8", timeout: 10_000 }); }

describe("built CLI in real processes", () => {
  it("runs init, prints settings, verifies and exports a real directly-written ledger", async () => {
    const cwd = await sandbox(); const dir = join(cwd, ".agent-ledger");
    expect(run(cwd, ["init"]).status).toBe(0);
    const bin = spawnSync(cli, ["verify"], { cwd, encoding: "utf8", timeout: 10_000 });
    expect(bin.status, String(bin.error)).toBe(3);
    const snippet = run(cwd, ["install-hooks", "--print"]);
    expect(snippet.status).toBe(0); expect(Object.keys(JSON.parse(snippet.stdout).hooks)).toHaveLength(5);
    const empty = run(cwd, ["verify"]); expect(empty.status).toBe(3); expect(JSON.parse(empty.stdout).chain).toEqual({ ok: true, checked: 0 });
    const ledger = createLedger("jsonl", join(dir, "ledger/records.jsonl"));
    const intent = unsealed(1, { command: `hmac-sha256:${"f".repeat(64)}` });
    intent.call.tool = "Bash"; intent.policy = { verdict: "require_approval", risk: "risky", ruleId: "registry:builtin:claude-code/Bash", reason: "Reviewed risky shell" };
    intent.approval = { callId: intent.call.callId, channel: "hook-ask", decision: "delegated", decidedAt: new Date().toISOString() };
    const first = await ledger.append(intent);
    await createAnchor("file", join(dir, "anchors.jsonl")).write({ hash: first.hash, at: new Date().toISOString() });
    await ledger.append({ ...intent, id: "outcome-1", phase: "outcome", outcome: { status: "ok" } });
    const verified = run(cwd, ["verify"]); expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).chain).toEqual({ ok: true, checked: 2 }); expect(JSON.parse(verified.stdout).anchor.status).toBe("ancestor");
    const report = run(cwd, ["report", "--from", "2020-01-01T00:00:00Z", "--to", "2090-01-01T00:00:00Z", "--out", "pack"]);
    expect(report.status, report.stderr).toBe(0); const files = JSON.parse(report.stdout);
    const html = await readFile(files.htmlPath, "utf8"); expect(html).toContain("2 records"); expect(html).toContain("Chain verification: PASS"); expect(html).toContain("CC8.1");
    const csv = await readFile(files.csvPath, "utf8"); expect(csv.trim().split(/\r?\n/)).toHaveLength(3); expect(csv).not.toContain("hmac-sha256:");
    expect((await readFile(files.pdfPath)).subarray(0, 8).toString()).toBe("%PDF-1.4");
    // A report must not change the evidence ledger or append an anchor while verifying.
    expect(await ledger.verify()).toEqual({ ok: true, checked: 2 });
  });
  it("returns failure for a truncated chain whose remembered anchor is no longer present", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    const path = join(cwd, ".agent-ledger/ledger/records.jsonl"); const ledger = createLedger("jsonl", path);
    await ledger.append(unsealed(1)); const prefix = await readFile(path);
    const last = await ledger.append(unsealed(2));
    await createAnchor("file", join(cwd, ".agent-ledger/anchors.jsonl")).write({ hash: last.hash, at: new Date().toISOString() });
    await writeFile(path, prefix);
    const r = run(cwd, ["verify"]); expect(r.status).toBe(1); expect(JSON.parse(r.stdout).anchor.status).toBe("mismatch");
  });
  it("fails pre on unparseable input and keeps the three direct record-only handlers non-blocking and silent on stdout", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    for (const event of ["pre", "post", "session-start", "denied"]) {
      const r = run(cwd, ["hook", "--agent", "claude-code", "--event", event], "invalid fixture");
      expect(r.status).toBe(event === "pre" ? 1 : 0); expect(r.stdout).toBe(""); expect(r.stderr).not.toBe("");
    }
  });
  it("prints post commands that survive shell quoting of a hostile-looking sandbox path", async () => {
    const cwd = await sandbox(); const dir = join(cwd, "quote' space $HOME `echo nope`");
    expect(run(cwd, ["init", "--dir", dir]).status).toBe(0);
    const snippet = JSON.parse(run(cwd, ["install-hooks", "--print", "--dir", dir]).stdout);
    const command = snippet.hooks.PostToolUse[0].hooks[0].command;
    const r = spawnSync("/bin/sh", ["-c", command], { cwd, input: "{}", encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0); expect(r.stdout).toBe(""); expect(r.stderr).toContain("post outcome was not recorded");
  });
});


it("executes init and verify through an npm-style bin symlink", async () => {
  const cwd = await sandbox(); const link = join(cwd, "agent-ledger"); await symlink(cli, link);
  const init = spawnSync(link, ["init"], { cwd, encoding: "utf8", timeout: 10_000 });
  expect(init.status).toBe(0); expect(init.stdout).toContain("Initialized");
  const verify = spawnSync(process.execPath, [link, "verify"], { cwd, encoding: "utf8", timeout: 10_000 });
  expect(verify.status).toBe(3); expect(JSON.parse(verify.stdout).chain.ok).toBe(true);
});
it.skipIf(process.platform !== "darwin")("executes the same copied CLI through /tmp and /private/tmp aliases", async () => {
  const cwd = await mkdtemp("/tmp/cli-alias-"); dirs.push(cwd);
  const physical = await realpath(cwd); expect(physical).toBe(cwd.replace(/^\/tmp\//, "/private/tmp/"));
  await cp(resolve("dist"), join(cwd, "dist"), { recursive: true });
  await cp(resolve("policies"), join(cwd, "policies"), { recursive: true });
  await cp(resolve("package.json"), join(cwd, "package.json"));
  await symlink(resolve("node_modules"), join(cwd, "node_modules"));
  const init = spawnSync(process.execPath, [join(cwd, "dist/cli/main.js"), "init"], { cwd, encoding: "utf8", timeout: 10_000 });
  expect(init.status).toBe(0); expect(init.stdout).toContain("Initialized");
  for (const base of [cwd, physical]) {
    const r = spawnSync(process.execPath, [join(base, "dist/cli/main.js"), "verify"], { cwd, encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(3); expect(JSON.parse(r.stdout).chain.ok).toBe(true);
  }
});
it.each([MAX_STDIN_BYTES, MAX_STDIN_BYTES + 1])("applies the real stdin byte cap at %s bytes before parsing", async bytes => {
  const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
  // Only parsing is injected: stdin is the production pipe reader. The boundary control
  // proves oversize failure came from the byte cap, rather than the still-stubbed parser.
  const script = `import { main } from ${JSON.stringify(pathToFileURL(cli).href)};
    process.exitCode = await main(["hook", "--agent", "claude-code", "--event", "pre"], {
      hooks: { parseHookInput() { process.stdout.write("PARSED"); throw Error("parser reached"); } }
    });`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, input: " ".repeat(bytes), encoding: "utf8", timeout: 10_000 });
  expect(r.status, String(r.error)).toBe(1);
  expect(r.stdout).toBe(bytes === MAX_STDIN_BYTES ? "PARSED" : ""); expect(r.stderr).not.toBe("");
});
const realHooksAndPipeline = (await Promise.all(["hooks", "pipeline"].map(m => readFile(`src/${m}/README.md`, "utf8"))))
  .every(text => /^Status: implemented$/m.test(text));
it.skipIf(!realHooksAndPipeline)("records a direct post outcome with the real pipeline and no watchdog environment", async () => {
  const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
  const event = JSON.parse(await readFile("test/fixtures/claude-code-posttooluse.json", "utf8"));
  const ledger = createLedger("jsonl", join(cwd, ".agent-ledger/ledger/records.jsonl"));
  const intent = unsealed(1); intent.call.callId = event.tool_use_id; await ledger.append(intent);
  const env = { ...process.env }; delete env[WATCHDOG_DEADLINE_AT_ENV]; delete env[WATCHDOG_DEADLINE_ENV];
  const r = spawnSync(process.execPath, [cli, "hook", "--agent", "claude-code", "--event", "post"], { cwd, env, input: JSON.stringify(event), encoding: "utf8", timeout: 10_000 });
  expect(r.status).toBe(0); expect(r.stdout).toBe(""); expect(r.stderr).toBe("");
  const records = []; for await (const record of ledger.read({ from: "2020-01-01T00:00:00Z", to: "2090-01-01T00:00:00Z" })) records.push(record);
  expect(records).toHaveLength(2); expect(records[1]!.phase).toBe("outcome");
  expect(records[1]!.call.callId).toBe(event.tool_use_id); expect(records[1]!.outcome?.status).toBe("ok");
  expect((await ledger.verify()).ok).toBe(true);
});
it("launches with only the declared production dependencies", async () => {
  const cwd = await sandbox();
  await cp(resolve("dist"), join(cwd, "dist"), { recursive: true });
  await cp(resolve("policies"), join(cwd, "policies"), { recursive: true });
  await cp(resolve("package.json"), join(cwd, "package.json"));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  await mkdir(join(cwd, "node_modules"));
  for (const name of Object.keys(pkg.dependencies)) await cp(resolve("node_modules", name), join(cwd, "node_modules", name), { recursive: true });
  const r = spawnSync(process.execPath, [join(await realpath(cwd), "dist/cli/main.js"), "init"], { cwd, encoding: "utf8", timeout: 10_000 });
  expect(r.status, r.stderr).toBe(0); expect(r.stdout).toContain("Initialized");
});

it("imports without invoking commands when argv[1] cannot be resolved", async () => {
  const cwd = await sandbox();
  const script = `process.argv[1] = ${JSON.stringify(join(cwd, "missing-entry"))};
    await import(${JSON.stringify(pathToFileURL(cli).href)}); process.stdout.write("IMPORTED");`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd, encoding: "utf8", timeout: 10_000 });
  expect(r.status).toBe(0); expect(r.stdout).toBe("IMPORTED"); expect(r.stderr).toBe("");
});
it("exports a diagnostic pack but signals a broken chain in stdout and exit status", async () => {
  const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
  const path = join(cwd, ".agent-ledger/ledger/records.jsonl"); const ledger = createLedger("jsonl", path);
  await ledger.append(unsealed(1)); await ledger.append(unsealed(2));
  // Corrupt an earlier record while leaving the tail readable; a corrupt tail is
  // rejected by head() before the report can export any records.
  await writeFile(path, (await readFile(path, "utf8")).replace("reviewed read tool", "modified read tool"));
  const r = run(cwd, ["report", "--from", "2020-01-01T00:00:00Z", "--to", "2090-01-01T00:00:00Z", "--out", "pack"]);
  expect(r.status, r.stderr).toBe(1); const output = JSON.parse(r.stdout);
  expect(output.chain.ok).toBe(false); expect(output.chain.brokenAt).toBeDefined();
  expect(await readFile(output.htmlPath, "utf8")).toContain("Chain verification: FAIL");
});

describe("Slice 1c handlers and anchor in real processes (ADR-010, ADR-011; pin 5)", () => {
  const sessionStart = (session_id = "sess-proc-1") => JSON.stringify({ session_id, transcript_path: "/t/x.jsonl", cwd: "/tmp", hook_event_name: "SessionStart", source: "startup", permission_mode: "default" });
  const quiet = { ...process.env } as Record<string, string | undefined>; delete quiet[WATCHDOG_DEADLINE_AT_ENV]; delete quiet[WATCHDOG_DEADLINE_ENV]; delete quiet["NODE_OPTIONS"];
  const spawnCli = (bin: string, cwd: string, args: string[], input: string, env: NodeJS.ProcessEnv = quiet) =>
    spawnSync(process.execPath, [bin, ...args], { cwd, input, env, encoding: "utf8", timeout: 20_000 });
  const records = async (cwd: string) => { const out = []; for await (const r of createLedger("jsonl", join(cwd, ".agent-ledger/ledger/records.jsonl")).read({ from: "2020-01-01T00:00:00Z", to: "2090-01-01T00:00:00Z" })) out.push(r); return out; };
  /** A private copy of the built artifacts whose watchdog entry point can be removed or broken without touching dist/. */
  async function privateBuild(cwd: string): Promise<string> {
    await cp(resolve("dist"), join(cwd, "dist"), { recursive: true });
    await cp(resolve("policies"), join(cwd, "policies"), { recursive: true });
    await cp(resolve("package.json"), join(cwd, "package.json"));
    await symlink(resolve("node_modules"), join(cwd, "node_modules"));
    return join(cwd, "dist/cli/main.js");
  }

  it("session-start prints NOTHING on stdout, exits 0 and writes a heartbeat with watchdogCheck ok and nodeOptionsSet false", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    const r = spawnCli(cli, cwd, ["hook", "--agent", "claude-code", "--event", "session-start"], sessionStart());
    expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(""); expect(r.stderr).toBe("");
    const all = await records(cwd); expect(all).toHaveLength(1);
    const hb = all[0]!;
    expect(hb.phase).toBe("intent"); expect(hb.call.tool).toBe("SessionStart"); expect(hb.policy.ruleId).toBe("heartbeat:session-start");
    expect(hb.call.agentSessionId).toBe("sess-proc-1");
    expect(hb.call.args).toMatchObject({ agentSessionId: "sess-proc-1", hookAgent: "claude-code", source: "startup", permissionMode: "default", nodeOptionsSet: false, watchdogCheck: "ok" });
    expect(hb.call.args["interpreter"]).toBe(await realpath(process.execPath));
  });
  it("session-start records nodeOptionsSet true when NODE_OPTIONS is set, and the value never reaches the ledger or any output", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    const canary = "--title=cli-proc-nodeopt-canary-5a1e";
    const r = spawnCli(cli, cwd, ["hook", "--agent", "claude-code", "--event", "session-start"], sessionStart(), { ...quiet, NODE_OPTIONS: canary });
    expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(""); expect(r.stderr).toBe("");
    const hb = (await records(cwd))[0]!;
    expect(hb.call.args).toMatchObject({ nodeOptionsSet: true, watchdogCheck: "ok" });
    expect(await readFile(join(cwd, ".agent-ledger/ledger/records.jsonl"), "utf8")).not.toContain("nodeopt-canary");
  });
  it("a missing watchdog entry point → watchdogCheck missing; a broken one → failed; both still silent, exit 0", async () => {
    for (const mode of ["missing", "failed"]) {
      const cwd = await sandbox(); const bin = await privateBuild(cwd); expect(spawnCli(bin, cwd, ["init"], "").status).toBe(0);
      const watchdog = join(cwd, "dist/hooks/watchdog-main.js");
      if (mode === "missing") await rm(watchdog); else await writeFile(watchdog, "process.stdout.write('{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"permissionDecisionReason\":\"x\"}}'); process.exit(1);\n");
      const r = spawnCli(bin, cwd, ["hook", "--agent", "claude-code", "--event", "session-start"], sessionStart());
      expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(""); expect(r.stderr).toBe("");
      expect((await records(cwd))[0]!.call.args["watchdogCheck"]).toBe(mode);
    }
  });
  it("Astra 1c P2 #2: an exit-0 watchdog whose output fails the strict validator (missing reason + extra field, several values, a deny, oversized, empty) → watchdogCheck failed; the same script with one valid allow → ok; all silent, exit 0", async () => {
    const allow = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "x" } };
    const payloads: Record<string, string> = {
      valid: JSON.stringify(allow),
      "missing-reason-extra-field": JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" }, unexpected: "unvalidated" }),
      "multiple-values": JSON.stringify(allow) + "\n" + JSON.stringify(allow),
      deny: JSON.stringify({ hookSpecificOutput: { ...allow.hookSpecificOutput, permissionDecision: "deny" } }),
      oversized: JSON.stringify({ hookSpecificOutput: { ...allow.hookSpecificOutput, permissionDecisionReason: "x".repeat(MAX_MAX_OUTPUT_BYTES + 1) } }),
      empty: "",
    };
    expect(Buffer.byteLength(payloads["oversized"]!)).toBeGreaterThan(MAX_MAX_OUTPUT_BYTES);
    for (const [label, payload] of Object.entries(payloads)) {
      const cwd = await sandbox(); const bin = await privateBuild(cwd); expect(spawnCli(bin, cwd, ["init"], "").status).toBe(0);
      // the replacement watchdog flushes its whole payload before exiting 0, so what the probe reads is exactly the payload
      await writeFile(join(cwd, "dist/hooks/watchdog-main.js"), `process.stdout.write(${JSON.stringify(payload)}, () => process.exit(0));\n`);
      const r = spawnCli(bin, cwd, ["hook", "--agent", "claude-code", "--event", "session-start"], sessionStart());
      expect(r.status, `${label}: ${r.stderr}`).toBe(0); expect(r.stdout, label).toBe(""); expect(r.stderr, label).toBe("");
      expect((await records(cwd))[0]!.call.args["watchdogCheck"], label).toBe(label === "valid" ? "ok" : "failed");
    }
  });
  it("Astra 1c P2 #1: a descendant that inherits the real watchdog's pipes cannot keep session-start alive past the probe cap: exit 0 within the cap, silent, watchdogCheck failed, and the descendant is gone", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    // A preload that fires ONLY inside the real compiled watchdog: it spawns a 15 s sidecar that inherits the watchdog's
    // stdin/stdout/stderr (the probe's pipes) and is unreferenced by its parent, then lets the watchdog run unchanged.
    const pidFile = join(cwd, "sidecar.pid");
    const sidecar = join(cwd, "sidecar-preload.cjs");
    await writeFile(sidecar, [
      "if (typeof process.argv[1] === 'string' && process.argv[1].endsWith('/hooks/watchdog-main.js')) {",
      "  const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });",
      `  require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref();`,
      "}", "",
    ].join("\n"));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code !== "ESRCH"; } };
    let pid = 0;
    try {
      const started = Date.now();
      const r = spawnCli(cli, cwd, ["hook", "--agent", "claude-code", "--event", "session-start"], sessionStart(), { ...quiet, NODE_OPTIONS: `--require=${sidecar}` });
      const elapsed = Date.now() - started;
      pid = Number(await readFile(pidFile, "utf8")); expect(pid).toBeGreaterThan(1); // the sidecar really ran inside the watchdog
      expect(r.error, String(r.error)).toBeUndefined(); expect(r.signal).toBeNull();
      expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(""); expect(r.stderr).toBe("");
      expect(elapsed, `session-start took ${elapsed} ms`).toBeLessThan(WATCHDOG_SELF_TEST.capMs + 2_000);
      const hb = (await records(cwd))[0]!;
      expect(hb.call.args).toMatchObject({ nodeOptionsSet: true, watchdogCheck: "failed" });
      expect(await readFile(join(cwd, ".agent-ledger/ledger/records.jsonl"), "utf8")).not.toContain("sidecar");
      for (let i = 0; i < 20 && alive(pid); i++) await new Promise(res => setTimeout(res, 50)); // SIGKILL is immediate; reaping may lag
      expect(alive(pid), "the probe's process group was killed with it").toBe(false);
    } finally { if (pid > 1) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } }
  }, 30_000);
  it("session-start and denied exit 0 silently on a corrupt registry or a missing key and change no ledger byte; pre fails closed", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    const dir = join(cwd, ".agent-ledger"); const ledgerPath = join(dir, "ledger/records.jsonl");
    expect(spawnCli(cli, cwd, ["hook", "--agent", "claude-code", "--event", "session-start"], sessionStart()).status).toBe(0);
    const before = await readFile(ledgerPath);
    const denied = JSON.stringify({ session_id: "sess-proc-1", transcript_path: "/t/x.jsonl", cwd: "/tmp", hook_event_name: "PermissionDenied", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/data" }, tool_use_id: "toolu_proc_denied", reason: "Destructive command" });
    const registry = await readFile(join(dir, "registry.yaml"));
    const breakages: [string, () => Promise<void>, () => Promise<void>][] = [
      ["corrupt registry", () => writeFile(join(dir, "registry.yaml"), "version: 1\nservers:\n  claude-code:\n    trusted: true\n    tools: {}\n"), () => writeFile(join(dir, "registry.yaml"), registry)],
      ["missing key", () => rm(join(dir, "hmac.key")), async () => { await writeFile(join(dir, "hmac.key"), Buffer.alloc(32, 7), { mode: 0o600 }); }],
    ];
    for (const [label, breakIt, restore] of breakages) {
      await breakIt();
      try {
        for (const [event, input] of [["session-start", sessionStart("sess-proc-2")], ["denied", denied]] as const) {
          const r = spawnCli(cli, cwd, ["hook", "--agent", "claude-code", "--event", event], input);
          expect(r.status, `${label} ${event}`).toBe(0); expect(r.stdout, `${label} ${event}`).toBe(""); expect(r.stderr, `${label} ${event}`).not.toBe("");
        }
        const pre = spawnCli(cli, cwd, ["hook", "--agent", "claude-code", "--event", "pre"], JSON.stringify({ session_id: "s", transcript_path: "/t", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, tool_use_id: "toolu_x" }));
        expect(pre.status, label).toBe(1); expect(pre.stdout, label).toBe("");
      } finally { await restore(); }
    }
    expect((await readFile(ledgerPath)).equals(before)).toBe(true);
  });
  it("denied chains a blocked auto-mode outcome to the intent that a real session-start + pre wrote first (pre given the watchdog's deadline variable, as the watchdog would)", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    const ledger = createLedger("jsonl", join(cwd, ".agent-ledger/ledger/records.jsonl"));
    const hb = spawnCli(cli, cwd, ["hook", "--agent", "claude-code", "--event", "session-start"], sessionStart("sess-proc-3"));
    expect(hb.status, hb.stderr).toBe(0); expect(hb.stdout).toBe("");
    const preEvent = JSON.stringify({ session_id: "sess-proc-3", transcript_path: "/t/x.jsonl", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/a" }, tool_use_id: "toolu_proc_chain" });
    const pre = spawnCli(cli, cwd, ["hook", "--agent", "claude-code", "--event", "pre"], preEvent, { ...quiet, [WATCHDOG_DEADLINE_AT_ENV]: String(Date.now() + 25_000) });
    expect(pre.status, pre.stderr).toBe(0); expect(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision).toBe("allow"); // Read is a reviewed read in the shipped registry
    const denied = JSON.stringify({ session_id: "sess-proc-3", transcript_path: "/t/x.jsonl", cwd: "/tmp", hook_event_name: "PermissionDenied", tool_name: "Read", tool_input: { file_path: "/tmp/a" }, tool_use_id: "toolu_proc_chain", reason: "Destructive command" });
    const r = spawnCli(cli, cwd, ["hook", "--agent", "claude-code", "--event", "denied"], denied);
    expect(r.status, r.stderr).toBe(0); expect(r.stdout).toBe(""); expect(r.stderr).toBe("");
    const all = await records(cwd); expect(all.map(x => [x.phase, x.call.tool])).toEqual([["intent", "SessionStart"], ["intent", "Read"], ["outcome", "Read"]]);
    expect(all[1]!.call.callId).toBe("toolu_proc_chain"); expect(all[1]!.call.agentSessionId).toBe("sess-proc-3"); expect(all[1]!.policy.verdict).toBe("allow");
    expect(all[2]!.outcome).toEqual({ status: "blocked", errorClass: "permission-denied:auto-mode" });
    expect(all[2]!.call).toEqual(all[1]!.call); expect(all[2]!.policy).toEqual(all[1]!.policy); // chained, not an orphan
    expect(all[0]!.call.agentSessionId).toBe("sess-proc-3"); // the heartbeat and the tool session share the agent's session id (what the report joins on)
    expect(await readFile(join(cwd, ".agent-ledger/ledger/records.jsonl"), "utf8")).not.toContain("Destructive command");
    expect(await ledger.verify()).toEqual({ ok: true, checked: 3 });
  });
  it("anchor refuses a broken chain with exit 1 and chain-failed, writing no anchor line; a healthy ledger anchors and verify answers head", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    const path = join(cwd, ".agent-ledger/ledger/records.jsonl"); const ledger = createLedger("jsonl", path);
    await ledger.append(unsealed(1)); await ledger.append(unsealed(2));
    const good = await readFile(path, "utf8");
    await writeFile(path, good.replace("reviewed read tool", "modified read tool"));
    const broken = run(cwd, ["anchor"]);
    expect(broken.status, broken.stderr).toBe(1); expect(JSON.parse(broken.stdout)).toMatchObject({ anchored: false, reason: "chain-failed", chain: { ok: false } });
    await expect(readFile(join(cwd, ".agent-ledger/anchors.jsonl"))).rejects.toThrow();
    await writeFile(path, good);
    const anchored = run(cwd, ["anchor"]);
    expect(anchored.status, anchored.stderr).toBe(0);
    const out = JSON.parse(anchored.stdout); expect(out.anchored).toBe(true); expect(out.entry.hash).toBe(await ledger.head()); expect(out.chain).toEqual({ ok: true, checked: 2 });
    expect(await readFile(out.path, "utf8")).toBe(out.line + "\n");
    const verified = run(cwd, ["verify"]); expect(verified.status).toBe(0); expect(JSON.parse(verified.stdout).anchor.status).toBe("head");
    expect(await readFile(path, "utf8")).toBe(good);
  });
});
