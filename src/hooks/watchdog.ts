// The two-process fail-closed watchdog (spec §7). This file and watchdog-main.ts are the ONLY code either coding agent
// executes for a PreToolUse hook, so their runtime import graph is node built-ins only: node:child_process, node:fs,
// node:process. `import type` lines are erased at compile time and add nothing to the import graph
// (test/hooks-watchdog.test.ts scans both this source and the compiled output). The shared `HookAgent` shape stays in
// src/types; the runtime list below mirrors it and a test pins the two equal.
import cp from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import type { HookAgent } from "../types/index.js";

/** Runtime mirror of types' HOOK_AGENTS (this module may not import src/types at runtime). Pinned equal by a test. */
export const WATCHDOG_AGENTS = ["claude-code", "codex"] as const satisfies readonly HookAgent[];

/** Exact output shape for a PreToolUse decision, identical for both agents (see contract.ts for sources). */
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

// ---------- clocks and limits (spec §5, §7; ADR-006) ----------

/** What our settings snippet sets as the hook `timeout` (seconds) for both agents. Their own default is 600 s, far too long to matter. */
export const HOOK_TIMEOUT_S = 30;
export const CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_S = 600;
export const CODEX_DEFAULT_HOOK_TIMEOUT_S = 600;
/** The watchdog must have emitted its verdict at least this long before the agent's timeout cancels it. */
export const WATCHDOG_MIN_MARGIN_MS = 2_000;
/** Internal deadline: the hook timeout minus a margin, so the deny is written before the agent cancels us. */
export const DEFAULT_DEADLINE_MS = (HOOK_TIMEOUT_S - 5) * 1000;
/** A Slack answer must be back, recorded and formatted at least this long before the watchdog's deadline kills the handler. */
export const APPROVAL_MIN_MARGIN_MS = 5_000;
export interface HookTiming { approvalTimeoutMs?: number; deadlineMs: number; hookTimeoutS: number; }
/** No Slack channel (Claude Code hook-ask, or Codex with every require_approval a recorded deny): fast. */
export const DEFAULT_HOOK_TIMING: HookTiming = { deadlineMs: DEFAULT_DEADLINE_MS, hookTimeoutS: HOOK_TIMEOUT_S };
/** Slack approvals (required under Codex): a human gets 5 minutes; the watchdog and the agent wait a little longer, in that order. */
export const SLACK_HOOK_TIMING: HookTiming = { approvalTimeoutMs: 300_000, deadlineMs: 310_000, hookTimeoutS: 320 };
export const WATCHDOG_DEADLINE_ENV = "AGENT_LEDGER_WATCHDOG_DEADLINE_MS" as const;
export const WATCHDOG_DEADLINE_AT_ENV = "AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS" as const;
export const WATCHDOG_KILL_SIGNAL = "SIGKILL" as const;
export const WATCHDOG_WRITE_BUDGET_MS = 1_000;
export const WATCHDOG_WRITE_RETRY_SLEEP_MS = 5;
export const DEFAULT_MAX_OUTPUT_BYTES = 8_192;
export const MIN_MAX_OUTPUT_BYTES = 512;
export const MAX_MAX_OUTPUT_BYTES = 65_536;
export const MAX_HANDLER_STDERR_BYTES = 16_384;
export const MAX_STDIN_BYTES = 4 * 1024 * 1024;
export const MAX_REASON_CHARS = 1_000;

export interface WatchdogOptions {
  handlerCommand: string[];
  deadlineMs: number;
  maxOutputBytes: number;
  agent: HookAgent;
  timeoutS?: number;
}
export interface WatchdogResult { stdout: string; stderr: string; exitCode: 0 | 2; }
export const WATCHDOG_REASON_PREFIX = "watchdog:" as const;
export const WATCHDOG_REASONS = [
  "config", "init", "spawn", "stdin-too-large", "deadline", "handler-exit", "handler-signal",
  "output:empty", "output:too-large", "output:not-json", "output:not-object", "output:multiple",
  "output:extra-key", "output:missing-key", "output:bad-value", "handler-deny", "write", "internal",
] as const;
export const WATCHDOG_DEADLINE_DETAILS = ["stdin", "handler", "pipes-open"] as const;
export type ValidatedHandlerOutput =
  | { ok: true; payload: PreToolUseOutput }
  | { ok: false; reason: `${typeof WATCHDOG_REASON_PREFIX}output:${string}` };

// ---------- pure helpers ----------

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Key names are echoed into a reason line: bounded and stripped of control characters, never trusted. */
const safeKey = (k: string) => k.replace(/[^\x20-\x7e]/g, "?").slice(0, 64);
const DECISIONS: Record<HookAgent, readonly string[]> = { "claude-code": ["allow", "deny", "ask"], codex: ["allow", "deny"] };
const OUTPUT_KEYS = ["hookEventName", "permissionDecision", "permissionDecisionReason"] as const;
/** How many `}` positions the multiple-value detector tries before giving up on classification (both outcomes deny). */
const MULTIPLE_SCAN_LIMIT = 64;

export function serialiseOutput(p: PreToolUseOutput): string {
  return JSON.stringify({ hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: p.hookSpecificOutput.permissionDecision,
    permissionDecisionReason: p.hookSpecificOutput.permissionDecisionReason,
  } });
}
export function denyOutput(reason: string): string {
  return serialiseOutput({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason.slice(0, MAX_REASON_CHARS) } });
}

/** Rules in order: size, empty, JSON, object, exact key sets, values (see contract.ts). Own-property only, re-serialised on ok. */
export function validateHandlerOutput(raw: string, agent: HookAgent): ValidatedHandlerOutput {
  const bad = (what: string): ValidatedHandlerOutput => ({ ok: false, reason: `${WATCHDOG_REASON_PREFIX}output:${what}` });
  if (typeof raw !== "string") return bad("not-json");
  const maxBytes = MAX_MAX_OUTPUT_BYTES;
  if (Buffer.byteLength(raw, "utf8") > maxBytes) return bad("too-large");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return bad("empty");
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch {
    // A first complete value followed by more text (a stray console.log) is "multiple"; anything else is "not-json".
    if (trimmed.startsWith("{")) {
      let tries = 0;
      for (let i = trimmed.indexOf("}"); i !== -1 && tries < MULTIPLE_SCAN_LIMIT; i = trimmed.indexOf("}", i + 1), tries++) {
        try { JSON.parse(trimmed.slice(0, i + 1)); return bad("multiple"); } catch { /* keep scanning */ }
      }
    }
    return bad("not-json");
  }
  if (!isPlainObject(parsed)) return bad("not-object");
  const topKeys = Object.keys(parsed);
  const extraTop = topKeys.find((k) => k !== "hookSpecificOutput");
  if (extraTop !== undefined) return bad(`extra-key:${safeKey(extraTop)}`);
  if (!topKeys.includes("hookSpecificOutput")) return bad("missing-key:hookSpecificOutput");
  const inner = parsed["hookSpecificOutput"];
  if (!isPlainObject(inner)) return bad("bad-value:hookSpecificOutput");
  const innerKeys = Object.keys(inner);
  const extraInner = innerKeys.find((k) => !(OUTPUT_KEYS as readonly string[]).includes(k));
  if (extraInner !== undefined) return bad(`extra-key:${safeKey(extraInner)}`);
  for (const k of OUTPUT_KEYS) if (!innerKeys.includes(k)) return bad(`missing-key:${k}`);
  if (inner["hookEventName"] !== "PreToolUse") return bad("bad-value:hookEventName");
  const decision = inner["permissionDecision"];
  if (typeof decision !== "string" || !(DECISIONS[agent] ?? []).includes(decision)) return bad("bad-value:permissionDecision");
  const reason = inner["permissionDecisionReason"];
  if (typeof reason !== "string" || reason.length > MAX_REASON_CHARS) return bad("bad-value:permissionDecisionReason");
  return { ok: true, payload: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision as "allow" | "deny" | "ask", permissionDecisionReason: reason } } };
}

/** The static three-clock check (ADR-006). Returns violations; empty = valid. */
export function validateHookTiming(t: HookTiming): string[] {
  const out: string[] = [];
  const positiveInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  if (!isPlainObject(t)) return ["timing: not an object"];
  if (!positiveInt(t.deadlineMs)) out.push("deadlineMs: must be a finite integer > 0");
  if (!positiveInt(t.hookTimeoutS)) out.push("hookTimeoutS: must be a finite integer > 0");
  if (t.approvalTimeoutMs !== undefined && !positiveInt(t.approvalTimeoutMs)) out.push("approvalTimeoutMs: must be a finite integer > 0");
  if (out.length > 0) return out;
  if (t.approvalTimeoutMs !== undefined && t.approvalTimeoutMs + APPROVAL_MIN_MARGIN_MS > t.deadlineMs) {
    out.push(`approval-not-below-deadline: approvalTimeoutMs ${t.approvalTimeoutMs} + ${APPROVAL_MIN_MARGIN_MS} must be <= deadlineMs ${t.deadlineMs}`);
  }
  if (t.deadlineMs + WATCHDOG_MIN_MARGIN_MS > t.hookTimeoutS * 1000) {
    out.push(`deadline-not-below-hook-timeout: deadlineMs ${t.deadlineMs} + ${WATCHDOG_MIN_MARGIN_MS} must be <= hookTimeoutS ${t.hookTimeoutS} * 1000`);
  }
  return out;
}

// ---------- non-blocking, looped, time-bounded writes (Astra P1, 2026-09-30) ----------

const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const errCode = (e: unknown) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);

export function writeAllSync(fd: 1 | 2, data: Uint8Array, budgetMs: number = WATCHDOG_WRITE_BUDGET_MS, now: () => number = Date.now): void {
  const start = now();
  let off = 0;
  let progressed = false;
  while (off < data.length) {
    let n = 0;
    try {
      n = fs.writeSync(fd, data, off, data.length - off);
    } catch (e) {
      if (errCode(e) !== "EAGAIN" && errCode(e) !== "EWOULDBLOCK") throw e;
    }
    if (n > 0) { off += n; progressed = true; continue; }
    if (now() - start >= budgetMs) {
      throw new Error(progressed ? `write to fd ${fd} incomplete after ${budgetMs} ms (${off}/${data.length} bytes)` : `write to fd ${fd} made no progress within ${budgetMs} ms`);
    }
    sleepSync(WATCHDOG_WRITE_RETRY_SLEEP_MS);
  }
}

/**
 * O_NONBLOCK on fd 1 or 2 via the stdio stream's libuv handle (`setBlocking(false)`; pipes, sockets and TTYs have it).
 * A stream with no handle is a regular file (`fs.SyncWriteStream`): a file write never waits on a reader, so there is
 * nothing to switch. Anything else is a failure, and the caller treats it as a write failure (exit 2).
 */
export function setNonBlocking(fd: 1 | 2): void {
  const stream = (fd === 1 ? process.stdout : fd === 2 ? process.stderr : undefined) as unknown as
    | { _handle?: { setBlocking?: (b: boolean) => number } | null; _type?: string; constructor?: { name?: string } }
    | undefined;
  if (!stream) throw new Error(`setNonBlocking: fd ${fd} is not stdout or stderr`);
  const handle = stream._handle;
  if (handle && typeof handle.setBlocking === "function") {
    const rc = handle.setBlocking(false);
    if (typeof rc === "number" && rc !== 0) throw new Error(`setNonBlocking: setBlocking(false) on fd ${fd} failed with ${rc}`);
    return;
  }
  if (stream._type === "fs" || stream.constructor?.name === "SyncWriteStream") return;
  throw new Error(`setNonBlocking: fd ${fd} has no stream handle to switch`);
}

// ---------- the watchdog ----------

const deny = (reason: string, handlerStderr = ""): WatchdogResult => ({
  stdout: denyOutput(reason),
  stderr: `${reason}\n${handlerStderr}`,
  exitCode: 2,
});

/** First failing option as `config:<field>`, or null. */
export function validateWatchdogOptions(opts: WatchdogOptions): string | null {
  if (!isPlainObject(opts)) return "config:options";
  if (!(WATCHDOG_AGENTS as readonly unknown[]).includes(opts.agent)) return "config:agent";
  if (opts.timeoutS !== undefined && !(Number.isInteger(opts.timeoutS) && opts.timeoutS > 0)) return "config:timeoutS";
  if (validateHookTiming({ deadlineMs: opts.deadlineMs, hookTimeoutS: opts.timeoutS ?? HOOK_TIMEOUT_S }).length > 0) return "config:deadlineMs";
  if (!(Number.isInteger(opts.maxOutputBytes) && opts.maxOutputBytes >= MIN_MAX_OUTPUT_BYTES && opts.maxOutputBytes <= MAX_MAX_OUTPUT_BYTES)) return "config:maxOutputBytes";
  if (!Array.isArray(opts.handlerCommand) || opts.handlerCommand.length === 0 || opts.handlerCommand.some((s) => typeof s !== "string" || s.length === 0)) return "config:handlerCommand";
  return null;
}

/**
 * Runs the watchdog on the current process's stdin and resolves with the verdict. It never rejects: every internal
 * failure resolves as a deny (`watchdog:internal`), through the uncaughtException/unhandledRejection handlers it
 * installs first. The caller (watchdog-main.ts) writes the result with `emitAndExit`, which is where the non-blocking,
 * time-bounded writes and `process.exit` live. Steps 1-8 of the contract comment are marked below.
 */
export function runWatchdog(opts: WatchdogOptions): Promise<WatchdogResult> {
  return new Promise<WatchdogResult>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: cp.ChildProcess | undefined;
    let groupKilled = false;
    let handlerStderr = "";
    let stderrBytes = 0;

    /** One kill attempt per watchdog, by the PGID kept from spawn; ESRCH = already gone; never retried (PGID reuse). */
    const killGroupOnce = () => {
      if (groupKilled || child?.pid === undefined) return;
      groupKilled = true;
      try { process.kill(-child.pid, WATCHDOG_KILL_SIGNAL); }
      catch { /* ESRCH: the group is already gone; any other error leaves nothing more to do */ }
    };
    const finish = (r: WatchdogResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(r);
    };
    const fail = (reason: string) => { killGroupOnce(); finish(deny(reason, handlerStderr)); };

    // 1. Internal failures deny; nothing propagates. After the verdict is settled the only safe answer left is exit 2.
    const internal = (e: unknown) => {
      if (settled) process.exit(2);
      fail(`${WATCHDOG_REASON_PREFIX}internal:${e instanceof Error ? e.message : String(e)}`.slice(0, MAX_REASON_CHARS));
    };
    process.on("uncaughtException", internal);
    process.on("unhandledRejection", internal);

    // 2. Options.
    const configProblem = validateWatchdogOptions(opts);
    if (configProblem !== null) { finish(deny(`${WATCHDOG_REASON_PREFIX}${configProblem}`)); return; }

    // 3. The deadline timer starts before stdin is read or anything is spawned.
    const deadlineAt = Date.now() + opts.deadlineMs;
    let spawned = false;
    let exitedZero = false;
    timer = setTimeout(() => {
      if (!spawned) { fail(`${WATCHDOG_REASON_PREFIX}deadline:stdin`); return; }
      fail(`${WATCHDOG_REASON_PREFIX}deadline:${exitedZero ? "pipes-open" : "handler"}`);
    }, opts.deadlineMs);

    // 4. Own stdin: asynchronous and bounded.
    const stdinChunks: Buffer[] = [];
    let stdinBytes = 0;
    let stdinDone = false;
    const stdin = process.stdin;
    stdin.on("error", (e) => { if (!stdinDone) fail(`${WATCHDOG_REASON_PREFIX}internal:stdin:${errCode(e) ?? "error"}`); });
    stdin.on("data", (chunk: Buffer | string) => {
      if (stdinDone) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      stdinBytes += buf.length;
      if (stdinBytes > MAX_STDIN_BYTES) { stdinDone = true; stdin.destroy(); finish(deny(`${WATCHDOG_REASON_PREFIX}stdin-too-large`)); return; }
      stdinChunks.push(buf);
    });
    stdin.on("end", () => {
      if (stdinDone || settled) return;
      stdinDone = true;
      spawnHandler(Buffer.concat(stdinChunks));
    });
    stdin.resume();

    function spawnHandler(event: Buffer): void {
      const [cmd, ...args] = opts.handlerCommand as [string, ...string[]];
      const env: NodeJS.ProcessEnv = { ...process.env, [WATCHDOG_DEADLINE_ENV]: String(opts.deadlineMs), [WATCHDOG_DEADLINE_AT_ENV]: String(deadlineAt) };
      try {
        child = cp.spawn(cmd, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env, shell: false });
      } catch (e) {
        finish(deny(`${WATCHDOG_REASON_PREFIX}spawn:${errCode(e) ?? "error"}`));
        return;
      }
      spawned = true;
      const c = child;
      let stdoutBytes = 0;
      let overflow = false;
      const stdoutChunks: Buffer[] = [];
      c.on("error", (e) => {
        // ENOENT/EACCES arrive here, asynchronously, with no pid; a later error after exit is irrelevant.
        if (c.pid === undefined) finish(deny(`${WATCHDOG_REASON_PREFIX}spawn:${errCode(e) ?? "error"}`));
        else fail(`${WATCHDOG_REASON_PREFIX}internal:child:${errCode(e) ?? "error"}`);
      });
      c.stdin?.on("error", () => { /* EPIPE: the handler decides on what it read, or fails; we decide either way */ });
      c.stdin?.end(event);
      // 5. Bounded capture; the handler's stdout is never connected to the agent.
      c.stdout?.on("data", (chunk: Buffer) => {
        if (overflow) return;
        const room = opts.maxOutputBytes + 1 - stdoutBytes;
        const take = chunk.subarray(0, Math.max(0, Math.min(room, chunk.length)));
        stdoutChunks.push(take);
        stdoutBytes += take.length;
        if (stdoutBytes > opts.maxOutputBytes) overflow = true;
      });
      c.stderr?.on("data", (chunk: Buffer) => {
        const room = MAX_HANDLER_STDERR_BYTES - stderrBytes;
        if (room <= 0) return;
        const take = chunk.subarray(0, Math.min(room, chunk.length));
        handlerStderr += take.toString("utf8");
        stderrBytes += take.length;
      });
      // 8. exit: non-zero denies at once; zero waits for close (6).
      c.on("exit", (code, signal) => {
        if (settled) return;
        if (signal !== null) { fail(`${WATCHDOG_REASON_PREFIX}handler-signal:${signal}`); return; }
        if (code !== 0) {
          // No decision bytes at all: the handler failed before producing one (its own init/config failure, spec §7).
          fail(stdoutBytes === 0 ? `${WATCHDOG_REASON_PREFIX}init:exit-${code}` : `${WATCHDOG_REASON_PREFIX}handler-exit:${code}`);
          return;
        }
        exitedZero = true;
      });
      c.on("close", (code, signal) => {
        if (settled) return;
        if (!exitedZero || code !== 0 || signal !== null) { fail(`${WATCHDOG_REASON_PREFIX}handler-exit:${code ?? signal ?? "unknown"}`); return; }
        if (overflow) { fail(`${WATCHDOG_REASON_PREFIX}output:too-large`); return; }
        const v = validateHandlerOutput(Buffer.concat(stdoutChunks).toString("utf8"), opts.agent);
        if (!v.ok) { fail(v.reason); return; }
        if (v.payload.hookSpecificOutput.permissionDecision === "deny") {
          killGroupOnce();
          finish({ stdout: serialiseOutput(v.payload), stderr: `${WATCHDOG_REASON_PREFIX}handler-deny\n${handlerStderr}`, exitCode: 2 });
          return;
        }
        finish({ stdout: serialiseOutput(v.payload), stderr: "", exitCode: 0 });
      });
    }
  });
}

/**
 * Writes the verdict (one stdout line; stderr on a deny) with non-blocking, time-bounded writes and exits. Every
 * failure inside here, the mode switch included, still exits 2 with a best-effort `watchdog:write` reason, all within
 * ONE write budget window so a stalled reader cannot hold the process past WATCHDOG_WRITE_BUDGET_MS by much.
 */
export function emitAndExit(result: WatchdogResult): never {
  const start = Date.now();
  const remaining = () => Math.max(1, WATCHDOG_WRITE_BUDGET_MS - (Date.now() - start));
  let code: 0 | 2 = result.exitCode;
  try {
    setNonBlocking(1);
    setNonBlocking(2);
    writeAllSync(1, Buffer.from(`${result.stdout}\n`, "utf8"), remaining());
    if (result.stderr.length > 0) writeAllSync(2, Buffer.from(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`, "utf8"), remaining());
  } catch (e) {
    code = 2;
    const reason = `${WATCHDOG_REASON_PREFIX}write:${e instanceof Error ? e.message : String(e)}`;
    try { writeAllSync(2, Buffer.from(`${reason}\n`, "utf8"), remaining()); } catch { /* stderr is gone too */ }
    if (result.exitCode !== 2) { try { writeAllSync(1, Buffer.from(`${denyOutput(reason)}\n`, "utf8"), remaining()); } catch { /* nothing left to try */ } }
  }
  process.exit(code);
}

// ---------- argv of watchdog-main.ts (pin 3) ----------

export type ParsedWatchdogArgv = { ok: true; opts: WatchdogOptions } | { ok: false; field: string };
/** `--agent <a> --deadline-ms <n> --timeout-s <n> [--max-output-bytes <n>] -- <handler argv...>`; bad values flow into validateWatchdogOptions. */
export function parseWatchdogArgv(argv: readonly string[]): ParsedWatchdogArgv {
  const flags: Record<string, string> = {};
  let handler: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { handler = argv.slice(i + 1); break; }
    if (!a.startsWith("--")) return { ok: false, field: "argv" };
    const name = a.slice(2);
    if (!["agent", "deadline-ms", "timeout-s", "max-output-bytes"].includes(name)) return { ok: false, field: name || "argv" };
    if (Object.hasOwn(flags, name)) return { ok: false, field: name };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, field: name };
    flags[name] = value;
    i++;
  }
  const int = (s: string | undefined) => (s !== undefined && /^-?\d+$/.test(s) ? Number(s) : Number.NaN);
  return {
    ok: true,
    opts: {
      agent: (flags["agent"] ?? "") as WatchdogOptions["agent"],
      deadlineMs: int(flags["deadline-ms"]),
      timeoutS: flags["timeout-s"] === undefined ? HOOK_TIMEOUT_S : int(flags["timeout-s"]),
      maxOutputBytes: flags["max-output-bytes"] === undefined ? DEFAULT_MAX_OUTPUT_BYTES : int(flags["max-output-bytes"]),
      handlerCommand: handler ?? [],
    },
  };
}
