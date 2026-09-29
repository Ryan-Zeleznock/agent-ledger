import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";

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
  pipeline: () => import("../src/pipeline/contract.js"),
} as const;
const MODULES = Object.keys(LOADERS) as (keyof typeof LOADERS)[];

describe.each(MODULES)("module %s", (m) => {
  it("has README, contract, and test to-do list", () => {
    for (const p of [`src/${m}/README.md`, `src/${m}/contract.ts`, `test/todo/${m}.todo.md`]) {
      expect(existsSync(p), p).toBe(true);
    }
  });
  it("every exported function throws not implemented", async () => {
    const mod: Record<string, unknown> = await LOADERS[m]();
    const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
    expect(fns.length).toBeGreaterThan(0);
    for (const [name, fn] of fns) {
      expect(() => (fn as (...a: unknown[]) => unknown)(), name).toThrow(/^not implemented: /);
    }
  });
});
