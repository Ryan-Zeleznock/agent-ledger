import type { ChildProcess } from "node:child_process";

/** Test-side IPC helpers for the forked fixtures in .test-build/test/helpers/. */
export interface ChildMsg { type: string; pid: number; message?: string; records?: { id: string; parentRecordId: string | null; prevHash: string; hash: string }[]; written?: number; appended?: number }

/** Resolves with the first message of `type`; rejects on `error`, early exit, or after `ms`. */
export const waitFor = (c: ChildProcess, type: string, ms: number) => new Promise<ChildMsg>((res, rej) => {
  const timer = setTimeout(() => { cleanup(); rej(new Error(`child ${c.pid} did not send ${type} within ${ms} ms`)); }, ms);
  const onMsg = (m: ChildMsg) => {
    if (m.type === type) { cleanup(); res(m); }
    else if (m.type === "error") { cleanup(); rej(new Error(m.message)); }
  };
  const onExit = (code: number | null) => { cleanup(); rej(new Error(`child ${c.pid} exited early with ${code} while waiting for ${type}`)); };
  const cleanup = () => { clearTimeout(timer); c.off("message", onMsg); c.off("exit", onExit); };
  c.on("message", onMsg);
  c.once("exit", onExit);
});

export const exited = (c: ChildProcess) => new Promise<number | null>((res) => (c.exitCode !== null ? res(c.exitCode) : c.once("exit", res)));
