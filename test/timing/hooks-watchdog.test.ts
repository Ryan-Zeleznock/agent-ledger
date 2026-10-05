import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { stringify } from "yaml";
import {
  DEFAULT_MAX_OUTPUT_BYTES, HOOK_AGENTS, MAX_MAX_OUTPUT_BYTES, MAX_STDIN_BYTES, MIN_MAX_OUTPUT_BYTES, WATCHDOG_DEADLINE_AT_ENV,
  WATCHDOG_DEADLINE_ENV, WATCHDOG_MIN_MARGIN_MS, WATCHDOG_WRITE_BUDGET_MS,
} from "../../src/hooks/contract.js";
import { WATCHDOG_AGENTS } from "../../src/hooks/watchdog.js";
import { createLedger } from "../../src/ledger/contract.js";
import { ARGS_HMAC_PREFIX } from "../../src/pipeline/contract.js";

/**
 * REAL-process watchdog tests (spec §7; Astra P1/P2 reviews 2026-09-29/30). Every case spawns the compiled entry point
 * (.test-build/src/hooks/watchdog-main.js, or the test harness that patches built-ins around it) with a scripted
 * handler (.test-build/test/helpers/hooks-handler.js). Nothing here runs the watchdog in-process.
 */
const WATCHDOG = resolve(".test-build/src/hooks/watchdog-main.js");
const HARNESS = resolve(".test-build/test/helpers/hooks-watchdog-harness.js");
const HANDLER = resolve(".test-build/test/helpers/hooks-handler.js");
const EVENT = readFileSync("test/fixtures/claude-code-pretooluse.json", "utf8");
const DEADLINE = 1_500; const TIMEOUT_S = 4; // fast profile for tests: 1500 + 2000 <= 4000

interface Run { stdout: string; stderr: string; code: number | null; signal: string | null; ms: number; }
interface RunOpts { stdin?: string | Buffer | null; env?: Record<string, string>; harness?: boolean; keepStdinOpen?: boolean; deadline?: number; timeoutS?: number; agent?: string; extra?: string[]; started?: (c: ChildProcess) => void; noRead?: boolean; hardTimeoutMs?: number; }
const live: (() => void)[] = [];
const codes: number[] = [];

function watchdog(handlerArgs: string[], o: RunOpts = {}): Promise<Run> {
  const args = [o.harness ? HARNESS : WATCHDOG];
  if (o.agent !== "") args.push("--agent", o.agent ?? "claude-code");
  args.push("--deadline-ms", String(o.deadline ?? DEADLINE), "--timeout-s", String(o.timeoutS ?? TIMEOUT_S), ...(o.extra ?? []));
  if (handlerArgs.length > 0) args.push("--", process.execPath, HANDLER, ...handlerArgs);
  return raw(args, o);
}
function raw(args: string[], o: RunOpts = {}): Promise<Run> {
  const started = Date.now();
  return new Promise((res, rej) => {
    // Each invocation owns a PID file even if its test does not request one. The watchdog's
    // detached handler survives killing only the watchdog; reap it on timeout/assertion abort.
    const pidFile = o.env?.HOOKS_TEST_PID_FILE ?? join(dir, `owned-${randomBytes(8).toString("hex")}`);
    const c = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...o.env, HOOKS_TEST_PID_FILE: pidFile } });
    let stdout = "", stderr = "", settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      const owned = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").map(Number) : [];
      const named = [...stderr.matchAll(/^(?:pid|escapee):(\d+)$/gm)].map(m => Number(m[1]));
      for (const pid of new Set([...owned, ...named])) {
        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone or not a group leader */ }
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
      if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
      c.stdin.destroy(); c.stdout.destroy(); c.stderr.destroy();
      clearTimeout(timer);
      if (!settled) { settled = true; rej(new Error("test runner cancelled before child pipes closed")); }
    };
    live.push(cleanup);
    timer = setTimeout(() => {
      if (!settled) { settled = true; rej(new Error(`test runner hard deadline (${o.hardTimeoutMs ?? 15_000} ms): ${args[0]}`)); }
      cleanup();
    }, o.hardTimeoutMs ?? 15_000);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== null) codes.push(code);
      res({ stdout, stderr, code, signal, ms: Date.now() - started });
    };
    c.once("error", error => { if (!settled) { settled = true; rej(error); } cleanup(); });
    if (!o.noRead) c.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    c.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    c.stdin.on("error", () => { /* EPIPE when the watchdog denies before reading */ });
    if (o.noRead) c.once("exit", (code, signal) => { setTimeout(() => { stdout = c.stdout.read()?.toString("utf8") ?? ""; finish(code, signal); }, 50); });
    else c.once("close", finish);
    o.started?.(c);
    if (!o.keepStdinOpen) c.stdin.end(o.stdin === null ? "" : o.stdin ?? EVENT);
  });
}
const out = (r: Run) => JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
const reasonOf = (r: Run) => out(r).hookSpecificOutput.permissionDecisionReason;
/** A deny: exit 2, ONE stdout line of deny JSON with `reason`, and the reason line on stderr (a handler's own deny says handler-deny there). */
const expectDeny = (r: Run, reason: RegExp | string, stderrLine: RegExp | string = reason) => {
  expect(r.code).toBe(2);
  expect(r.stdout.trimEnd().split("\n").length).toBe(1);
  expect(out(r).hookSpecificOutput.permissionDecision).toBe("deny");
  expect(reasonOf(r)).toMatch(reason);
  expect(r.stderr.split("\n")[0]).toMatch(stderrLine);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code !== "ESRCH"; } };
const pids = (text: string, tag = "pid") => [...text.matchAll(new RegExp(`^${tag}:(\\d+)$`, "gm"))].map((m) => Number(m[1]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventuallyGone(list: number[]): Promise<void> {
  for (let i = 0; i < 40 && list.some(alive); i++) await sleep(50);
  for (const pid of list) expect(alive(pid), `pid ${pid} still alive`).toBe(false);
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agent-ledger-hooks-")); });
function cleanupRuns(): void { for (const cleanup of live.splice(0)) cleanup(); }
afterEach(() => { cleanupRuns(); rmSync(dir, { recursive: true, force: true }); });

describe("watchdog: built by construction", () => {
  it("compiled entry point, harness and handler exist", () => {
    for (const p of [WATCHDOG, HARNESS, HANDLER]) expect(existsSync(p), p).toBe(true);
  });
  it("static import scan: watchdog.ts and watchdog-main.ts import only node:child_process, node:fs, node:process (types erased)", () => {
    const allowed = new Set(["node:child_process", "node:fs", "node:process", "./watchdog.js"]);
    for (const file of ["src/hooks/watchdog.ts", "src/hooks/watchdog-main.ts", ".test-build/src/hooks/watchdog.js", ".test-build/src/hooks/watchdog-main.js"]) {
      const src = readFileSync(file, "utf8");
      const imports = [...src.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)];
      for (const m of imports) {
        if (m[1]?.trim() === "type") { expect(file.endsWith(".ts")).toBe(true); continue; } // erased at compile time; absent from the .js
        expect(allowed.has(m[2]!), `${file} imports ${m[2]}`).toBe(true);
      }
      expect(src).not.toMatch(/require\(/);
      expect(src).not.toMatch(/readFileSync\(\s*0\s*\)|\/dev\/stdin/); // stdin is consumed asynchronously
      if (file.endsWith(".js")) expect(src).not.toMatch(/from ["']\.\.\/types/);
    }
    // the compiled watchdog has no `import type` residue and no path into the rest of the package
    expect(readFileSync(".test-build/src/hooks/watchdog.js", "utf8")).not.toMatch(/types\/index|policy|pipeline|ledger|yaml/);
  });
  it("the runtime agent list mirrors types' HOOK_AGENTS; setNonBlocking precedes the first write in the emitter", () => {
    expect([...WATCHDOG_AGENTS]).toEqual([...HOOK_AGENTS]);
    const src = readFileSync("src/hooks/watchdog.ts", "utf8");
    const emitter = src.slice(src.indexOf("export function emitAndExit"));
    expect(emitter.indexOf("setNonBlocking(1)")).toBeGreaterThan(-1);
    expect(emitter.indexOf("setNonBlocking(1)")).toBeLessThan(emitter.indexOf("writeAllSync(1"));
    expect(emitter.indexOf("setNonBlocking(2)")).toBeLessThan(emitter.indexOf("writeAllSync(2"));
    expect(src).toMatch(/process\.kill\(-child\.pid, WATCHDOG_KILL_SIGNAL\)/);
    expect(src).not.toMatch(/child\.kill\(/);
  });
});

describe("watchdog: handler misbehaviour (Astra P1 #1, #2, P2 #3)", () => {
  it("infinite loop that ignores SIGTERM → deadline deny, exit 2, before deadline + 500 ms; the handler is gone (SIGKILL)", async () => {
    const pidFile = join(dir, "pids");
    const r = await watchdog(["loop"], { env: { HOOKS_TEST_PID_FILE: pidFile } });
    expectDeny(r, /^watchdog:deadline:handler$/);
    expect(r.ms).toBeLessThan(DEADLINE + 500);
    expect(r.ms).toBeLessThan(TIMEOUT_S * 1000 - WATCHDOG_MIN_MARGIN_MS);
    await eventuallyGone(readFileSync(pidFile, "utf8").trim().split("\n").map(Number));
  }, 10_000);
  it.each([["hello", "not-json"], ["[]", "not-object"], ["\"allow\"", "not-object"], ["{", "not-json"], ["null", "not-object"]])("junk stdout %s → output:%s", async (junk, cls) => {
    expectDeny(await watchdog(["junk", junk]), `watchdog:output:${cls}`);
  });
  it("stdout over maxOutputBytes → output:too-large; the handler's bytes never reach our stdout", async () => {
    const r = await watchdog(["oversize"]);
    expectDeny(r, /^watchdog:output:too-large$/);
    expect(r.stdout).not.toContain("#");
    expect(r.stdout.length).toBeLessThan(400);
  });
  it("exit 1 with a valid allow → handler-exit:1 (a non-zero handler is never trusted)", async () => {
    expectDeny(await watchdog(["exit1-allow"]), /^watchdog:handler-exit:1$/);
  });
  it("exit 1 AFTER a valid deny → handler-exit:1, emitted at exit (no wait for close); exit 3 → handler-exit:3", async () => {
    expectDeny(await watchdog(["exit1-deny"]), /^watchdog:handler-exit:1$/);
    expectDeny(await watchdog(["exit-code", "3"]), /^watchdog:handler-exit:3$/);
  });
  it("non-zero exit with NO stdout (an init/config failure inside the handler) → init:exit-<code>, its stderr appended", async () => {
    const r = await watchdog(["exit1-silent"]);
    expectDeny(r, /^watchdog:init:exit-1$/);
    expect(r.stderr).toContain("registry refused");
  });
  it.each(["SIGTERM", "SIGKILL"])("killed by %s → handler-signal", async (sig) => {
    expectDeny(await watchdog(["signal", sig]), new RegExp(`^watchdog:handler-signal:${sig}$`));
  });
  it("a valid allow followed by a second JSON line → output:multiple", async () => {
    expectDeny(await watchdog(["multiple"]), /^watchdog:output:multiple$/);
  });
  it.each(["updatedInput", "additionalContext", "systemMessage", "continue", "decision"])("extra key %s inside hookSpecificOutput → extra-key", async (k) => {
    expectDeny(await watchdog(["extra-inner", k]), new RegExp(`^watchdog:output:extra-key:${k}$`));
  });
  it("a second top-level key → extra-key; hookEventName PostToolUse → bad-value", async () => {
    expectDeny(await watchdog(["extra-top", "continue"]), /^watchdog:output:extra-key:continue$/);
    expectDeny(await watchdog(["bad-event-name"]), /^watchdog:output:bad-value:hookEventName$/);
  });
  it("Astra P2 #7: a payload with duplicate permissionDecision members (deny then allow) is a deny, exit 2, never an allow", async () => {
    const dup = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecision":"allow","permissionDecisionReason":"r"}}';
    expectDeny(await watchdog(["junk", dup]), /^watchdog:output:extra-key:permissionDecision$/);
    const dupTop = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"r"},"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"r"}}';
    expectDeny(await watchdog(["junk", dupTop]), /^watchdog:output:extra-key:hookSpecificOutput$/);
  });
  it("empty stdout with exit 0 → output:empty", async () => {
    expectDeny(await watchdog(["empty"]), /^watchdog:output:empty$/);
  });
});

describe("watchdog: the only exit 0 is a validated allow or ask", () => {
  it("a valid allow → exit 0, stdout is the RE-SERIALISED payload (not the handler's whitespace/order), stderr empty", async () => {
    const r = await watchdog(["allow-ws"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"reviewed read"}}\n');
    expect(r.stdout).toBe(JSON.stringify(JSON.parse(r.stdout)) + "\n");
  });
  it("a valid ask → exit 0 under claude-code; bad-value:permissionDecision under codex", async () => {
    const cc = await watchdog(["ask"]);
    expect(cc.code).toBe(0);
    expect(out(cc).hookSpecificOutput.permissionDecision).toBe("ask");
    expectDeny(await watchdog(["ask"], { agent: "codex" }), /^watchdog:output:bad-value:permissionDecision$/);
  });
  it("a valid deny → stdout carries the HANDLER's reason, stderr says handler-deny, exit 2", async () => {
    const r = await watchdog(["deny", "policy: risky tool, no approval"]);
    expect(r.code).toBe(2);
    expect(out(r).hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "policy: risky tool, no approval" });
    expect(r.stderr.split("\n")[0]).toBe("watchdog:handler-deny");
  });
  it("the handler receives the event on stdin, unchanged", async () => {
    const r = await watchdog(["stdin-len"]);
    expect(r.code).toBe(0);
    expect(reasonOf(r)).toBe(`stdin ${Buffer.byteLength(EVENT)} ${EVENT.slice(0, 40)}`);
  });
});

describe("watchdog: spawn, stdin and config failures", () => {
  it("handler that does not exist (ENOENT) or is not executable (EACCES) → spawn:<code>", async () => {
    expectDeny(await raw([WATCHDOG, "--agent", "claude-code", "--deadline-ms", String(DEADLINE), "--timeout-s", String(TIMEOUT_S), "--", join(dir, "missing-handler")]), /^watchdog:spawn:ENOENT$/);
    const notExec = join(dir, "not-executable"); writeFileSync(notExec, "#!/bin/sh\necho hi\n"); chmodSync(notExec, 0o644);
    expectDeny(await raw([WATCHDOG, "--agent", "claude-code", "--deadline-ms", String(DEADLINE), "--timeout-s", String(TIMEOUT_S), "--", notExec]), /^watchdog:spawn:EACCES$/);
  });
  it("stdin over MAX_STDIN_BYTES → stdin-too-large, exit 2, handler never spawned", async () => {
    const pidFile = join(dir, "pids");
    const r = await watchdog(["allow"], { stdin: Buffer.alloc(MAX_STDIN_BYTES + 1, 0x20), env: { HOOKS_TEST_PID_FILE: pidFile } });
    expectDeny(r, /^watchdog:stdin-too-large$/);
    expect(existsSync(pidFile)).toBe(false);
  });
  it("never-EOF stdin → deadline:stdin at the deadline; handler never spawned", async () => {
    const pidFile = join(dir, "pids");
    const r = await watchdog(["allow"], { keepStdinOpen: true, env: { HOOKS_TEST_PID_FILE: pidFile } });
    expectDeny(r, /^watchdog:deadline:stdin$/);
    expect(r.ms).toBeGreaterThanOrEqual(DEADLINE - 50);
    expect(r.ms).toBeLessThan(DEADLINE + 500);
    expect(existsSync(pidFile)).toBe(false);
  }, 10_000);
  const cfg = (extra: string[], handler = true) => raw([WATCHDOG, ...extra, ...(handler ? ["--", process.execPath, HANDLER, "allow"] : [])]);
  const base = (deadline: string, timeout = String(TIMEOUT_S)) => ["--agent", "claude-code", "--deadline-ms", deadline, "--timeout-s", timeout];
  it.each([
    ["NaN", "deadlineMs", base("NaN")], ["Infinity", "deadlineMs", base("Infinity")], ["-1", "deadlineMs", base("-1")], ["0", "deadlineMs", base("0")],
    ["1.5", "deadlineMs", base("1.5")], ["a string", "deadlineMs", base("soon")], ["missing", "deadlineMs", ["--agent", "claude-code", "--timeout-s", "4"]],
    [">= timeout", "deadlineMs", base("4000")], ["margin too small", "deadlineMs", base(String(TIMEOUT_S * 1000 - WATCHDOG_MIN_MARGIN_MS + 1))],
    ["timeout 0", "timeoutS", base("1000", "0")],
    ["maxOutputBytes below the minimum", "maxOutputBytes", [...base("1500"), "--max-output-bytes", String(MIN_MAX_OUTPUT_BYTES - 1)]],
    ["maxOutputBytes above the maximum", "maxOutputBytes", [...base("1500"), "--max-output-bytes", String(MAX_MAX_OUTPUT_BYTES + 1)]],
    ["agent cursor", "agent", ["--agent", "cursor", "--deadline-ms", "1500", "--timeout-s", "4"]],
    ["agent missing", "agent", ["--deadline-ms", "1500", "--timeout-s", "4"]],
    ["unknown flag", "verbose", [...base("1500"), "--verbose", "1"]],
    ["duplicate flag", "agent", [...base("1500"), "--agent", "codex"]],
  ])("invalid config (%s) → config:%s, exit 2, never exit 1", async (_what, field, extra) => {
    expectDeny(await cfg(extra), new RegExp(`^watchdog:config:${field}$`));
  });
  it("empty handler command (bare `--`, or no `--`) → config:handlerCommand", async () => {
    expectDeny(await cfg([...base("1500"), "--"], false), /^watchdog:config:handlerCommand$/);
    expectDeny(await cfg(base("1500"), false), /^watchdog:config:handlerCommand$/);
  });
  it("the maximal legal profile is accepted: deadline = timeout*1000 - margin, default and explicit output caps", async () => {
    const r = await raw([WATCHDOG, ...base(String(TIMEOUT_S * 1000 - WATCHDOG_MIN_MARGIN_MS)), "--max-output-bytes", String(DEFAULT_MAX_OUTPUT_BYTES), "--", process.execPath, HANDLER, "allow"]);
    expect(r.code).toBe(0);
  });
});

describe("watchdog: exit vs close, group kill, PGID (Astra re-review 2026-09-29/30)", () => {
  it("valid allow + a grandchild holding the pipes + exit 0 → NO exit 0 at `exit`; at the deadline deny deadline:pipes-open; both pids gone", async () => {
    const r = await watchdog(["grandchild-sleep"]);
    expectDeny(r, /^watchdog:deadline:pipes-open$/);
    expect(r.ms).toBeGreaterThanOrEqual(DEADLINE - 50);
    const list = pids(r.stderr);
    expect(list.length).toBe(2);
    await eventuallyGone(list);
  }, 10_000);
  it("exit 0 while a grandchild appends {\"x\":1} before closing → close fires, validation sees two values → output:multiple", async () => {
    const r = await watchdog(["grandchild-append"]);
    expectDeny(r, /^watchdog:output:multiple$/);
    expect(r.ms).toBeLessThan(DEADLINE);
  });
  it.each([["loop", /^watchdog:deadline:handler$/], ["exit1", /^watchdog:handler-exit:1$/], ["junk", /^watchdog:output:not-json$/]])(
    "group kill leaves no survivors on failure path %s: handler and both children are gone", async (path, reason) => {
      const trace = join(dir, "trace");
      const r = await watchdog(["group", path], { harness: true, env: { HOOKS_TEST_TRACE_FILE: trace } });
      expectDeny(r, reason);
      const list = pids(r.stderr);
      expect(list.length).toBe(3);
      await eventuallyGone(list);
      // P2: exactly ONE negative-pid kill per failure path, with the handler's pid as the group id
      const kills = readFileSync(trace, "utf8").split("\n").filter((l) => / kill -\d+ /.test(l));
      expect(kills.length).toBe(1);
      expect(kills[0]).toContain(` kill -${list[0]} SIGKILL`);
    }, 10_000);
  it("the allow path never signals the group (no negative-pid kill in the trace); the test's own sleepers are cleaned via the pid file (P3)", async () => {
    const trace = join(dir, "trace"); const pidFile = join(dir, "pids");
    try {
      const r = await watchdog(["group", "allow"], { harness: true, env: { HOOKS_TEST_TRACE_FILE: trace, HOOKS_TEST_PID_FILE: pidFile } });
      expect(r.code).toBe(0);
      expect(readFileSync(trace, "utf8")).not.toMatch(/ kill -\d+ /);
      expect(readFileSync(pidFile, "utf8").trim().split("\n").length).toBe(3);
    } finally {
      const owned = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").map(Number) : [];
      for (const pid of owned) { if (alive(pid)) process.kill(pid, "SIGKILL"); }
      await eventuallyGone(owned);
    }
  });
  it("Astra P2 #3: a write failure AFTER a validated allow still group-kills: children gone, exactly one kill, exit 2", async () => {
    const trace = join(dir, "trace"); const pidFile = join(dir, "pids");
    try {
      const r = await watchdog(["group", "allow"], { harness: true, env: { HOOKS_TEST_FAULT: "epipe-stdout", HOOKS_TEST_TRACE_FILE: trace, HOOKS_TEST_PID_FILE: pidFile } });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/^watchdog:write:EPIPE/);
      const owned = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
      expect(owned.length).toBe(3);
      await eventuallyGone(owned);
      const kills = readFileSync(trace, "utf8").split("\n").filter((l) => / kill -\d+ /.test(l));
      expect(kills.length).toBe(1);
      expect(kills[0]).toContain(` kill -${owned[0]} SIGKILL`);
    } finally {
      const owned = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").map(Number) : [];
      for (const pid of owned) { if (alive(pid)) process.kill(pid, "SIGKILL"); }
    }
  }, 10_000);
  it("the detached handler has a process group addressed by its own pid, and the watchdog reaps it", async () => {
    const pidFile = join(dir, "pids");
    const done = watchdog(["pgid"], { env: { HOOKS_TEST_PID_FILE: pidFile } });
    for (let i = 0; i < 60 && !existsSync(pidFile); i++) await sleep(25);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    // POSIX kill(-pid, 0) checks that the handler's group exists without shelling out to ps.
    expect(() => process.kill(-pid, 0)).not.toThrow();
    const r = await done;
    expectDeny(r, /^watchdog:deadline:handler$/);
    await eventuallyGone([pid]);
  }, 10_000);
  it("ESRCH (P2): the group is already gone when the failure-path kill fires → deny stands, no watchdog:internal, one attempt", async () => {
    const trace = join(dir, "trace");
    const r = await watchdog(["empty"], { harness: true, env: { HOOKS_TEST_TRACE_FILE: trace } });
    expectDeny(r, /^watchdog:output:empty$/);
    expect(r.stderr).not.toContain("internal");
    expect(readFileSync(trace, "utf8").split("\n").filter((l) => / kill -\d+ /.test(l)).length).toBe(1);
  });
  it("setsid() escape is the stated residual: a detached descendant survives the group kill, and spec §7 names it", async () => {
    const r = await watchdog(["setsid-escape"]);
    expectDeny(r, /^watchdog:deadline:handler$/);
    const [handlerPid] = pids(r.stderr);
    const [escapee] = pids(r.stderr, "escapee");
    await eventuallyGone([handlerPid!]);
    expect(alive(escapee!)).toBe(true);
    process.kill(escapee!, "SIGKILL");
    const spec = readFileSync("docs/spec.md", "utf8");
    expect(spec).toMatch(/setsid\(\)` escape/);
    expect(readFileSync("src/hooks/README.md", "utf8")).toMatch(/setsid/);
  }, 10_000);
});

describe("watchdog: deadline env, internal errors, write failures (Astra P1/P2 2026-09-30)", () => {
  it("passes the DURATION and the ABSOLUTE deadline taken before stdin was read: with stdin held 1 s the handler sees ~deadline - 1 s", async () => {
    const deadline = 3_000;
    const r = await watchdog(["env"], { deadline, timeoutS: 6, started: (c) => { setTimeout(() => c.stdin?.end(EVENT), 1_000); }, keepStdinOpen: true });
    expect(r.code).toBe(0);
    const [, ms, at, handlerNow] = reasonOf(r).split(" ");
    expect(Number(ms)).toBe(deadline);
    const remaining = Number(at) - Number(handlerNow);
    expect(remaining).toBeLessThan(deadline - 700);
    expect(remaining).toBeGreaterThan(deadline - 1_800);
    expect(WATCHDOG_DEADLINE_ENV).not.toBe(WATCHDOG_DEADLINE_AT_ENV);
  }, 10_000);
  it("a forced uncaughtException inside the watchdog → watchdog:internal, exit 2, group killed", async () => {
    const pidFile = join(dir, "pids");
    const r = await watchdog(["loop"], { harness: true, env: { HOOKS_TEST_FAULT: "throw-async", HOOKS_TEST_PID_FILE: pidFile } });
    expectDeny(r, /^watchdog:internal:forced test fault/);
    expect(r.ms).toBeLessThan(DEADLINE);
    await eventuallyGone(readFileSync(pidFile, "utf8").trim().split("\n").map(Number));
  });
  it("short writes (1 byte per writeSync) still deliver the one-line payload byte-for-byte, exit 0", async () => {
    const r = await watchdog(["allow"], { harness: true, env: { HOOKS_TEST_FAULT: "short-write" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"reviewed read"}}\n');
  });
  it("EPIPE on stdout → exit 2 with watchdog:write on stderr, even for an allow", async () => {
    const r = await watchdog(["allow"], { harness: true, env: { HOOKS_TEST_FAULT: "epipe-stdout" } });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^watchdog:write:EPIPE/);
  });
  it("both fds failing (the reporter itself fails) → exit 2, nothing on stdout", async () => {
    const r = await watchdog(["allow"], { harness: true, env: { HOOKS_TEST_FAULT: "fail-both" } });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });
  it.each(["eagain-always", "zero-progress"])("%s on every write → exit 2 within one write budget (time-bounded, not count-bounded)", async (fault) => {
    const r = await watchdog(["allow"], { harness: true, env: { HOOKS_TEST_FAULT: fault } });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.ms).toBeLessThan(WATCHDOG_WRITE_BUDGET_MS + 1_500); // handler start (~100 ms) + one budget window
  }, 10_000);
  it("Astra P2 #4: writes that make progress but too slowly (1 byte / 300 ms) are cut off by the budget → exit 2 within about one budget", async () => {
    const r = await watchdog(["allow"], { harness: true, env: { HOOKS_TEST_FAULT: "slow-short-write" } });
    expect(r.code).toBe(2);
    expect(r.ms).toBeLessThan(WATCHDOG_WRITE_BUDGET_MS * 2 + 1_500);
  }, 15_000);
  it("setNonBlocking failure (no handle to switch) → treated as a write failure → exit 2, best-effort deny on whichever fd works", async () => {
    const r = await watchdog(["allow"], { harness: true, env: { HOOKS_TEST_FAULT: "no-setblocking" } });
    expectDeny(r, /^watchdog:write:setNonBlocking/);
  });
  it("full stdout pipe the reader never drains → still exits 2 within the write budget, long before the deadline; setBlocking(false) ran before the first write", async () => {
    const trace = join(dir, "trace");
    const deadline = 6_000;
    const r = await watchdog(["allow"], { harness: true, noRead: true, deadline, timeoutS: 10, env: { HOOKS_TEST_FAULT: "fill-stdout", HOOKS_TEST_TRACE_FILE: trace } });
    expect(r.code).toBe(2);
    expect(r.ms).toBeLessThan(WATCHDOG_WRITE_BUDGET_MS + 2_000);
    expect(r.ms).toBeLessThan(deadline);
    const lines = readFileSync(trace, "utf8").split("\n");
    const firstWrite = lines.findIndex((l) => l.includes("writeSync-first"));
    const setBlocking = lines.findIndex((l) => l.includes("setBlocking 1 false") && lines.indexOf(l) > lines.findIndex((x) => x.includes("stdout-filled")));
    expect(setBlocking).toBeGreaterThan(-1);
    expect(setBlocking).toBeLessThan(firstWrite);
    // whatever reached the pipe is the filler's padding then, at most, a prefix of one line: never interleaved junk
    const tail = r.stdout.replace(/^\.*/, "");
    expect(tail === "" || '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"reviewed read"}}\n'.startsWith(tail)).toBe(true);
  }, 15_000);
});

describe("watchdog + real handler (what Astra's `hook` command does), spec §7 table", () => {
  const registry = resolve("policies/tools.example.yaml");
  const credential = "local-test-credential";
  let agents: string; let ledgerPath: string; let key: string;
  beforeEach(() => {
    agents = join(dir, "agents.yaml");
    writeFileSync(agents, stringify({ version: 1, agents: [{ id: "fable", credential: { kind: "local", sha256: createHash("sha256").update(credential).digest("hex") } }] }));
    ledgerPath = join(dir, "ledger", "ledger.jsonl");
    key = randomBytes(32).toString("hex");
  });
  const env = (over: Record<string, string> = {}) => ({ HOOKS_TEST_REGISTRY: registry, HOOKS_TEST_AGENTS: agents, HOOKS_TEST_LEDGER: ledgerPath, HOOKS_TEST_HMAC_KEY_HEX: key, HOOKS_TEST_CREDENTIAL: credential, ...over });
  const event = (agent: "claude-code" | "codex", tool_name: string, tool_input: Record<string, unknown>) =>
    JSON.stringify({ ...JSON.parse(readFileSync(`test/fixtures/${agent}-pretooluse.json`, "utf8")), tool_name, tool_input, tool_use_id: `call-${tool_name}-${Math.random().toString(16).slice(2)}` });

  it("Claude Code Read (reviewed read) → allow, exit 0; the intent record stores file_path clear and the rest as HMAC", async () => {
    const r = await watchdog(["real", "claude-code"], { env: env(), stdin: event("claude-code", "Read", { file_path: "/tmp/a.txt", offset: 10 }) });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(out(r).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(reasonOf(r)).toMatch(/^agent-ledger: allowed \(read; registry:builtin:claude-code\/Read\)/);
    const records = [];
    for await (const rec of createLedger("jsonl", ledgerPath).read({ from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" })) records.push(rec);
    expect(records.length).toBe(1);
    expect(records[0]!.phase).toBe("intent");
    expect(records[0]!.call.args["file_path"]).toBe("/tmp/a.txt");
    expect(records[0]!.call.args["offset"]).toMatch(new RegExp(`^${ARGS_HMAC_PREFIX}[0-9a-f]{64}$`));
    expect(await createLedger("jsonl", ledgerPath).verify()).toEqual({ ok: true, checked: 1 });
  }, 15_000);
  it("Claude Code Bash (risky, hook-ask) → ask, exit 0, intent record delegated; Codex Bash → recorded deny (no-channel), exit 2", async () => {
    const cc = await watchdog(["real", "claude-code"], { env: env(), stdin: event("claude-code", "Bash", { command: "rm -rf /" }) });
    expect(cc.code).toBe(0);
    expect(out(cc).hookSpecificOutput.permissionDecision).toBe("ask");
    expect(reasonOf(cc)).toMatch(/approval required \(risky; registry:builtin:claude-code\/Bash\)/);
    const cx = await watchdog(["real", "codex"], { env: env(), agent: "codex", stdin: event("codex", "Bash", { command: "rm -rf /" }) });
    expectDeny(cx, /Codex cannot ask and no Slack channel is configured/, /^watchdog:handler-deny$/);
    const records = [];
    for await (const rec of createLedger("jsonl", ledgerPath).read({ from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" })) records.push(rec);
    expect(records.map((x) => [x.phase, x.approval?.decision, x.outcome?.status])).toEqual([["intent", "delegated", undefined], ["intent", "no-channel", undefined], ["outcome", undefined, "blocked"]]);
    expect(JSON.stringify(records.map((x) => x.call.args))).not.toContain("rm -rf"); // Bash has storeArgs: [] → the command is an HMAC
    for (const x of records) expect(x.call.args["command"]).toMatch(new RegExp(`^${ARGS_HMAC_PREFIX}[0-9a-f]{64}$`));
    expect(JSON.stringify(records)).not.toContain(credential);
  }, 15_000);
  it("ledger down: risky (Bash), unreviewed and even read calls are DENIED with exit 2 (fail closed; read buffering is not implemented in this slice)", async () => {
    writeFileSync(join(dir, "ledger"), "a regular file where the ledger directory should be"); // mkdir fails → append throws
    for (const [tool, input] of [["Bash", { command: "ls" }], ["mcp__github__unknown_tool", { a: 1 }], ["Read", { file_path: "/x" }]] as const) {
      const r = await watchdog(["real", "claude-code"], { env: env(), stdin: event("claude-code", tool, input as Record<string, unknown>) });
      expectDeny(r, /ledger unavailable/, /^watchdog:handler-deny$/);
    }
  }, 20_000);
  it("an invalid registry refuses INSIDE the handler → init:exit-1 (never a plain exit 1 seen by the agent)", async () => {
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, stringify({ version: 1, servers: { "claude-code": { trusted: true, tools: { Read: { class: "read", reviewedBy: "r", reviewedAt: "2026-09-30" } } } } }));
    const r = await watchdog(["real", "claude-code"], { env: env({ HOOKS_TEST_REGISTRY: bad }), stdin: event("claude-code", "Read", {}) });
    expectDeny(r, /^watchdog:init:exit-1$/);
    expect(r.stderr).toMatch(/impersonates a builtin namespace/);
  }, 15_000);
  it("createPipeline under the watchdog: a Slack timeoutMs that breaks the clocks constructs and is DENIED by decide() → handler-deny, exit 2 (ADR-011; Astra 1c P2 #3); hook-ask allows (deadline env present)", async () => {
    expectDeny(await watchdog(["pipeline-init", "slack-timeout"], { deadline: 3_000, timeoutS: 6 }), /slack timeoutMs breaks the hook clocks.*approval-not-below-deadline/, /^watchdog:handler-deny$/);
    const ok = await watchdog(["pipeline-init", "hook-ask"], { deadline: 3_000, timeoutS: 6 });
    expect(ok.code).toBe(0);
  }, 15_000);
});

afterAll(() => {
  // the exit-code matrix over every watchdog process this file spawned
  // Filtered runs may exercise only one branch or spawn no watchdog at all.
  for (const code of codes) expect([0, 2]).toContain(code);
});


it("runner cleanup reaps a detached handler after an assertion aborts before the watchdog deadline", async () => {
  const pidFile = join(dir, "abort-pids");
  const done = watchdog(["pgid"], { deadline: 6_000, timeoutS: 10, env: { HOOKS_TEST_PID_FILE: pidFile } }).catch(() => undefined);
  for (let i = 0; i < 80 && !existsSync(pidFile); i++) await sleep(25);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  try {
    cleanupRuns();
    await eventuallyGone([pid]);
  } finally {
    try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    await done;
  }
}, 10_000);

it("runner deadline rejects and reaps a detached child holding pipes after its parent exits", async () => {
  const pidFile = join(dir, "pipe-pids");
  const script = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'}); writeFileSync(process.env.HOOKS_TEST_PID_FILE,String(c.pid)); c.unref(); process.exit(0);`;
  await expect(raw(["-e", script], { hardTimeoutMs: 1_500, env: { HOOKS_TEST_PID_FILE: pidFile } })).rejects.toThrow("test runner hard deadline");
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  await eventuallyGone([pid]);
}, 10_000);
