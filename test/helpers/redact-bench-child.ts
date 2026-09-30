import { redact } from "../../src/ledger/contract.js";

/**
 * Forked by test/ledger-redact-bench.test.ts (from .test-build/). Times redact() on benign and adversarial inputs of
 * doubling sizes and reports { type: "result", rows: [{ shape, bytes, ms }] } over IPC. The PARENT enforces the hard
 * deadline: synchronous quadratic work inside this child cannot be interrupted by an in-process timer (Astra #6).
 */
const SHAPES: Record<string, (n: number) => string> = {
  benign: (n) => "x".repeat(n),
  words: (n) => "alpha beta gamma delta ".repeat(Math.ceil(n / 23)).slice(0, n),
  prefixes: (n) => "eyJeyJeyJ".repeat(Math.ceil(n / 9)).slice(0, n),
  pemHeads: (n) => "-----BEGIN ".repeat(Math.ceil(n / 11)).slice(0, n),
  assignments: (n) => 'password="a b" token=c '.repeat(Math.ceil(n / 23)).slice(0, n),
  quotes: (n) => '"'.repeat(n),
  ats: (n) => "a@".repeat(Math.ceil(n / 2)).slice(0, n),
  digits: (n) => "4111 ".repeat(Math.ceil(n / 5)).slice(0, n),
  colons: (n) => "a:".repeat(Math.ceil(n / 2)).slice(0, n),
  base64ish: (n) => "QUJD".repeat(Math.ceil(n / 4)).slice(0, n),
};

const sizes = (process.argv[2] ?? "10240,20480,40960,81920,163840").split(",").map(Number);
const rows: { shape: string; bytes: number; ms: number }[] = [];
for (const [shape, make] of Object.entries(SHAPES)) {
  for (const n of sizes) {
    const s = make(n);
    const t0 = performance.now();
    redact({ text: s, nested: [{ deeper: s.slice(0, 1024) }] });
    rows.push({ shape, bytes: n, ms: performance.now() - t0 });
  }
}
const ipc = process.send?.bind(process);
if (!ipc) throw new Error("redact-bench-child: no IPC channel");
ipc({ type: "result", rows });
process.disconnect?.();
