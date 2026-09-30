import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// ADR-008: a module is exempt from the stub check once its README contains the line
// "Status: implemented". Each builder flips only its own module README.
const implemented = (m: string) => /^Status: implemented$/m.test(readFileSync(`src/${m}/README.md`, "utf8"));

const LOADERS = {
  identity: () => import("../src/identity/contract.js"),
  secrets: () => import("../src/secrets/contract.js"),
  policy: () => import("../src/policy/contract.js"),
  approvals: () => import("../src/approvals/contract.js"),
  ledger: () => import("../src/ledger/contract.js"),
  anchor: () => import("../src/anchor/contract.js"),
  report: () => import("../src/report/contract.js"),
  upstream: () => import("../src/upstream/contract.js"),
  front: () => import("../src/front/contract.js"),
  hooks: () => import("../src/hooks/contract.js"),
  pipeline: () => import("../src/pipeline/contract.js"),
} as const;
const MODULES = Object.keys(LOADERS) as (keyof typeof LOADERS)[];

describe.each(MODULES)("module %s", (m) => {
  it("has README, contract, and test to-do list", () => {
    for (const p of [`src/${m}/README.md`, `src/${m}/contract.ts`, `test/todo/${m}.todo.md`]) {
      expect(existsSync(p), p).toBe(true);
    }
  });
  it.skipIf(implemented(m))("every exported function throws not implemented (until implemented)", async () => {
    const mod: Record<string, unknown> = await LOADERS[m]();
    const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
    expect(fns.length).toBeGreaterThan(0);
    for (const [name, fn] of fns) {
      expect(() => (fn as (...a: unknown[]) => unknown)(), name).toThrow(/^not implemented: /);
    }
  });
});
