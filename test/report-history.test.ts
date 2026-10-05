import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReport, reconcileHandoffs } from "../src/report/contract.js";
import { historyRange, historyStore } from "./helpers/report-history.js";

const dirs: string[] = [];
function output() { const dir = mkdtempSync(join(tmpdir(), "report-history-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("R1: 50k historical and grace records produce a selected pack with complete correlations", async () => {
  const dir = output(), ledger = historyStore();
  const files = await generateReport(ledger, historyRange, dir);
  const html = readFileSync(join(dir, "report.html"), "utf8"), csv = readFileSync(files.csvPath, "utf8");
  expect(csv.trim().split("\n")).toHaveLength(4);
  expect(csv).toContain("executed despite deny");
  expect(csv).toContain("executed after ask");
  expect(csv).not.toContain("noise-");
  expect(html).toContain("Orphan outcomes (0)");
  expect(html).toContain("Unreconciled handoffs (0)");
  expect(html).not.toContain("session without heartbeat:");
  expect(readFileSync(files.pdfPath, "ascii")).toContain("%PDF-1.4");
  expect(await reconcileHandoffs(ledger, historyRange)).toEqual([]);
}, 15_000);

it("R1: streaming 50k records retains less than 32 MiB during history scans", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=128", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { generateReport, reconcileHandoffs } from './.test-build/src/report/contract.js';
    import { historyStore, historyRange } from './.test-build/test/helpers/report-history.js';
    global.gc(); const before = process.memoryUsage().heapUsed;
    let peak = 0;
    const ledger = historyStore(50000, () => {
      global.gc(); peak = Math.max(peak, process.memoryUsage().heapUsed - before);
      assert.ok(peak < 32 * 1024 * 1024, 'retained scan bytes: ' + peak);
    });
    await generateReport(ledger, historyRange, process.argv[1]);
    assert.deepEqual(await reconcileHandoffs(ledger, historyRange), []);
    process.stdout.write(String(peak));
  `, output()], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
  expect(child.error, child.stderr).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
  expect(Number(child.stdout)).toBeLessThan(32 * 1024 * 1024);
}, 25_000);
