import { describe, it, expect, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

/**
 * Supervised benchmark (Astra #6): redact() runs in a forked child under a HARD external deadline, over doubling
 * input sizes and adversarial shapes. A quadratic scanner blows the deadline or the growth ratio; a linear one does not.
 * Astra measured the previous implementation at ~2.4 s for 80 KB of benign text.
 */
const CHILD = resolve(".test-build/test/helpers/redact-bench-child.js");
const SIZES = [10_240, 20_480, 40_960, 81_920, 163_840];
const HARD_DEADLINE_MS = 20_000;
let child: ChildProcess | undefined;
afterEach(() => { if (child && child.exitCode === null) child.kill("SIGKILL"); child = undefined; });

interface Row { shape: string; bytes: number; ms: number }

describe("redact() performance under supervision", () => {
  it("finishes every shape up to 160 KB well inside the deadline, and time grows roughly linearly with size", async () => {
    child = fork(CHILD, [SIZES.join(",")], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const c = child;
    const rows = await new Promise<Row[]>((res, rej) => {
      const timer = setTimeout(() => { c.kill("SIGKILL"); rej(new Error(`redact benchmark child exceeded the ${HARD_DEADLINE_MS} ms hard deadline (quadratic work?)`)); }, HARD_DEADLINE_MS);
      c.once("message", (m: { type: string; rows: Row[] }) => { clearTimeout(timer); res(m.rows); });
      c.once("exit", (code) => { clearTimeout(timer); rej(new Error(`benchmark child exited with ${code} before reporting`)); });
    });
    const shapes = [...new Set(rows.map((r) => r.shape))];
    expect(shapes.length).toBeGreaterThanOrEqual(14);
    const report: string[] = [];
    for (const shape of shapes) {
      const series = rows.filter((r) => r.shape === shape).sort((a, b) => a.bytes - b.bytes);
      const largest = series.at(-1)!;
      const at40 = series.find((r) => r.bytes === 40_960)!;
      report.push(`${shape}: ${series.map((r) => `${(r.bytes / 1024) | 0}K=${r.ms.toFixed(1)}ms`).join(" ")}`);
      // 160 KB of any shape must redact in under a second (Astra's baseline: 2.4 s for 80 KB benign).
      expect(largest.ms, `${shape} at 160 KB`).toBeLessThan(1000);
      // 40 KB → 160 KB is 4x the input: linear ≈ 4x time, quadratic ≈ 16x. Allow generous noise on small timings.
      const ratio = largest.ms / Math.max(at40.ms, 2);
      expect(ratio, `${shape} growth 40K→160K: ${ratio.toFixed(1)}x`).toBeLessThan(8);
    }
    console.log(report.join("\n"));
  }, HARD_DEADLINE_MS + 5_000);
});
