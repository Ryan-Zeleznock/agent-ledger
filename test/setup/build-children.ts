import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Vitest globalSetup: compile the TypeScript sources (src + test) once to `.test-build/` so that tests can
 * `child_process.fork()` REAL Node processes running the ledger (multi-process contention, supervised redaction
 * benchmark). Vitest's transforms are not inherited by forked children, hence the plain tsc build (Astra review,
 * 2026-09-30). The directory is gitignored and rebuilt on every test run.
 */
export const TEST_BUILD_DIR = resolve(".test-build");

export default function setup(): void {
  rmSync(TEST_BUILD_DIR, { recursive: true, force: true });
  execFileSync(process.execPath, [
    resolve("node_modules/typescript/bin/tsc"),
    "--noEmit", "false", "--outDir", TEST_BUILD_DIR, "--rootDir", ".", "--declaration", "false", "--sourceMap", "false",
  ], { stdio: "inherit" });
}
