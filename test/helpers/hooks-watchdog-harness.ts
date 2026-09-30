// Test-only wrapper around the REAL watchdog entry point. It patches node built-ins on the shared module objects
// (`fs.writeSync`, `process.kill`, the stdio handle's `setBlocking`) BEFORE importing watchdog-main.js, so the product
// code stays free of test seams. Every fault can only make the watchdog fail; none can produce an allow.
//   HOOKS_TEST_TRACE_FILE: append one line per `process.kill`, `setBlocking` and first `writeSync` call
//   HOOKS_TEST_FAULT: short-write | slow-short-write | epipe-stdout | fail-both | eagain-always | zero-progress
//                     | no-setblocking | throw-async | fill-stdout
import fs from "node:fs";
import process from "node:process";

const trace = process.env["HOOKS_TEST_TRACE_FILE"];
const fault = process.env["HOOKS_TEST_FAULT"] ?? "";
const log = (line: string) => { if (trace) fs.appendFileSync(trace, `${Date.now()} ${line}\n`); };

const realWriteSync = fs.writeSync.bind(fs);
const realKill = process.kill.bind(process);
const errno = (code: string) => Object.assign(new Error(code), { code });

// Spy on the group kill (P2: exactly one negative-pid kill per failure path; ESRCH tolerated).
process.kill = ((pid: number, signal?: string | number) => {
  log(`kill ${pid} ${String(signal)}`);
  return realKill(pid, signal as NodeJS.Signals);
}) as typeof process.kill;

// Spy on setBlocking through the stdio handles (created here, before the watchdog touches them).
for (const fd of [1, 2] as const) {
  const stream = (fd === 1 ? process.stdout : process.stderr) as unknown as { _handle?: { setBlocking?: (b: boolean) => number } | null };
  const handle = stream._handle;
  if (handle && typeof handle.setBlocking === "function") {
    const real = handle.setBlocking.bind(handle);
    handle.setBlocking = (b: boolean) => { log(`setBlocking ${fd} ${b}`); return real(b); };
    if (fault === "no-setblocking") (handle as { setBlocking?: unknown }).setBlocking = undefined; // shadows the prototype method
  }
}

let firstWrite = true;
let eagainCount = 0;
fs.writeSync = ((fd: number, data: Uint8Array | string, ...rest: unknown[]) => {
  if (firstWrite && (fd === 1 || fd === 2)) { firstWrite = false; log(`writeSync-first ${fd}`); }
  if (fd === 1 || fd === 2) {
    if ((fault === "short-write" || fault === "slow-short-write") && typeof data !== "string") {
      const [off = 0] = rest as [number?];
      if (fault === "slow-short-write") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // 1 byte per 300 ms: progress, but far too slow
      return realWriteSync(fd, data, off, 1);
    }
    if (fault === "epipe-stdout" && fd === 1) throw errno("EPIPE");
    if (fault === "fail-both") throw errno("EPIPE");
    if (fault === "eagain-always") { eagainCount++; throw errno("EAGAIN"); }
    if (fault === "zero-progress") return 0;
  }
  return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
}) as typeof fs.writeSync;

if (fault === "throw-async") {
  // Forced uncaughtException inside the watchdog, after it has started (and usually spawned): must be watchdog:internal.
  setTimeout(() => { throw new Error("forced test fault"); }, 300);
}
if (fault === "fill-stdout") {
  // Pre-fill our own stdout pipe (the harness never reads it) until the kernel says EAGAIN, twice, so the buffer is full
  // when the watchdog tries to write its verdict (Astra P1: a blocking write would stall past the deadline).
  const stream = process.stdout as unknown as { _handle?: { setBlocking?: (b: boolean) => number } | null };
  stream._handle?.setBlocking?.(false);
  const chunk = Buffer.alloc(4096, 0x2e);
  const fill = () => { for (let i = 0; i < 1024; i++) { try { realWriteSync(1, chunk); } catch (e) { if ((e as { code?: string }).code === "EAGAIN") return; throw e; } } };
  fill();
  await new Promise((r) => setTimeout(r, 100));
  fill();
  log("stdout-filled");
}

await import("../../src/hooks/watchdog-main.js");
