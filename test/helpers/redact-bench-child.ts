import { redact } from "../../src/ledger/contract.js";

/**
 * Forked by test/ledger-redact-bench.test.ts (from .test-build/). Times redact() on benign and adversarial inputs of
 * doubling sizes and reports { type: "result", rows: [{ shape, bytes, ms }] } over IPC. The PARENT enforces the hard
 * deadline: synchronous quadratic work inside this child cannot be interrupted by an in-process timer (Astra #6).
 * Each shape builds the args object for a target size in bytes; string shapes wrap the text, key shapes build objects.
 */
const rep = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const text = (unit: string) => (n: number) => ({ text: rep(unit, n), nested: [{ deeper: rep(unit, Math.min(n, 1024)) }] });
const SHAPES: Record<string, (n: number) => Record<string, unknown>> = {
  benign: text("x"),
  words: text("alpha beta gamma delta "),
  prefixes: text("eyJeyJeyJ"),
  pemHeads: text("-----BEGIN "),
  pemNoEnd: text("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n"),
  assignments: text('password="a b" token=c '),
  quotes: text('"'),
  altQuotes: text("\"'"),
  ats: text("a@"),
  digits: text("4111 "),
  colons: text("a:"),
  base64ish: text("QUJD"),
  longWords: text(`${"x".repeat(2048)} `),
  nestedArrays: (n) => ({ text: "[".repeat(n / 2) + "]".repeat(n / 2) }),
  emailKeys: (n) => { const o: Record<string, unknown> = {}; for (let i = 0; i * 20 < n; i++) o[`u${i}@example.com`] = 0; return o; },
  secretKeys: (n) => { const o: Record<string, unknown> = {}; for (let i = 0; i * 16 < n; i++) o[`password_${i}`] = "hunter2"; return o; },
};

const sizes = (process.argv[2] ?? "10240,20480,40960,81920,163840").split(",").map(Number);
const rows: { shape: string; bytes: number; ms: number }[] = [];
for (const [shape, make] of Object.entries(SHAPES)) {
  for (const n of sizes) {
    const args = make(n);
    const t0 = performance.now();
    redact(args);
    rows.push({ shape, bytes: n, ms: performance.now() - t0 });
  }
}
const ipc = process.send?.bind(process);
if (!ipc) throw new Error("redact-bench-child: no IPC channel");
ipc({ type: "result", rows });
process.disconnect?.();
