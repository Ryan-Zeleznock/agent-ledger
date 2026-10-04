// Helpers for test/e2e-slice-2a.test.ts: long-running REAL processes (the proxy and the demo upstream from a private
// build root) whose stderr is a stream of JSON lines; every byte they print is kept for the leak sweep. Nothing here
// imports product code.
import { spawn, type ChildProcess } from "node:child_process";

export interface ServerProcess {
  readonly child: ChildProcess;
  /** Every stderr line so far, raw. */
  readonly stderr: string[];
  readonly stdout: string[];
  /** Parsed JSON stderr lines (non-JSON lines are skipped). */
  events(): Record<string, unknown>[];
  /** Resolves with the first (new or past) JSON stderr line matching `pred`, or rejects after `timeoutMs`. */
  waitFor(pred: (e: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Resolves when the process has exited (code/signal) plus how long it took. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM, then the exit result and the milliseconds it took; SIGKILL after `graceMs` as a last resort. */
  stop(graceMs?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
}

/** Spawns `node file` with `env` (NOTHING inherited beyond what the caller passes), cwd `cwd`. stdin is closed. */
export function startServerProcess(file: string, env: NodeJS.ProcessEnv, cwd: string, transcript: string[]): ServerProcess {
  const child = spawn(process.execPath, [file], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: string[] = []; const stdout: string[] = [];
  const waiters: { pred: (e: Record<string, unknown>) => boolean; resolve: (e: Record<string, unknown>) => void }[] = [];
  let errBuf = ""; let outBuf = "";
  const parse = (line: string): Record<string, unknown> | undefined => { try { const v = JSON.parse(line) as unknown; return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined; } catch { return undefined; } };
  child.stderr!.on("data", (d: Buffer) => {
    errBuf += d.toString("utf8");
    let nl: number;
    while ((nl = errBuf.indexOf("\n")) !== -1) {
      const line = errBuf.slice(0, nl); errBuf = errBuf.slice(nl + 1);
      stderr.push(line); transcript.push(line);
      const e = parse(line);
      if (e) for (let i = waiters.length - 1; i >= 0; i--) { if (waiters[i]!.pred(e)) { waiters.splice(i, 1)[0]!.resolve(e); } }
    }
  });
  child.stdout!.on("data", (d: Buffer) => {
    outBuf += d.toString("utf8");
    let nl: number;
    while ((nl = outBuf.indexOf("\n")) !== -1) { const line = outBuf.slice(0, nl); outBuf = outBuf.slice(nl + 1); stdout.push(line); transcript.push(line); }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => { if (errBuf) { stderr.push(errBuf); transcript.push(errBuf); } if (outBuf) { stdout.push(outBuf); transcript.push(outBuf); } resolve({ code, signal }); });
  });
  const events = () => stderr.map(parse).filter((e): e is Record<string, unknown> => e !== undefined);
  return {
    child, stderr, stdout, events, exited,
    waitFor(pred, timeoutMs = 20_000) {
      const past = events().find(pred);
      if (past) return Promise.resolve(past);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { const i = waiters.findIndex((w) => w.resolve === done); if (i >= 0) waiters.splice(i, 1); reject(new Error(`timed out waiting for a stderr event; stderr so far:\n${stderr.join("\n")}`)); }, timeoutMs);
        const done = (e: Record<string, unknown>) => { clearTimeout(timer); resolve(e); };
        waiters.push({ pred, resolve: done });
        void exited.then(() => { clearTimeout(timer); reject(new Error(`process exited before the event; stderr:\n${stderr.join("\n")}`)); });
      });
    },
    async stop(graceMs = 15_000) {
      const started = Date.now();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), graceMs);
      const r = await exited;
      clearTimeout(killer);
      return { ...r, ms: Date.now() - started };
    },
  };
}
