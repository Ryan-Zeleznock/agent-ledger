import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { clearArgFields, loadRegistry, type ToolRegistry } from "../src/policy/contract.js";
import { clearArgFields as helperClearArgFields, validate } from "./helpers/registry-eval.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const registry = (extra: object = {}): ToolRegistry => ({ version: 1, servers: { github: { trusted: true, tools: {
  t: { class: "read", reviewedBy: "ryan", reviewedAt: "2026-09-30", ...extra },
} } } });
async function file(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "policy-storeargs-")); dirs.push(dir);
  const path = join(dir, "tools.yaml");
  await writeFile(path, stringify(value));
  return path;
}

describe("storeArgs loader (ADR-009)", () => {
  it("keeps an absent allowlist absent and allows no clear args", async () => {
    const loaded = await loadRegistry(await file(registry()));
    expect(Object.hasOwn(loaded.servers.github!.tools.t!, "storeArgs")).toBe(false);
    expect(clearArgFields(loaded, "github", "t")).toEqual([]);
    expect(validate(loaded)).toEqual([]);
  });
  it.each([
    { storeArgs: [] },
    { storeArgs: ["owner", "repo", "title"] },
    { storeArgs: ["a", "A", "0", "file_path", "x-y", "x".repeat(64)] },
  ])("accepts and preserves $storeArgs", async extra => {
    const value = registry(extra);
    const loaded = await loadRegistry(await file(value));
    expect(loaded.servers.github!.tools.t!.storeArgs).toEqual(extra.storeArgs);
    expect(clearArgFields(loaded, "github", "t")).toEqual(extra.storeArgs);
    expect(validate(value)).toEqual([]);
  });
  it.each([
    null, "owner", 1, true, {}, { owner: true },
    [null], [1], [false], [{}], [["owner"]],
    [""], [" "], ["owner "], [" owner"], ["owner\n"], ["a\tb"], ["a\0b"],
    ["café"], ["оwner"], ["a/b"], ["*"], ["x".repeat(65)],
    ["owner", "owner"], ["owner", "repo", "owner"],
    ["options.branch"], ["options.branch.name"], [".owner"], ["owner."],
    ...[...new Set(["__proto__", "constructor", "prototype", ...Object.getOwnPropertyNames(Object.prototype)])].map(key => [key]),
  ].map(storeArgs => ({ storeArgs })))("refuses invalid allowlist %# in loader and oracle", async extra => {
    const value = registry(extra);
    await expect(loadRegistry(await file(value))).rejects.toThrow(/storeArgs/);
    expect(validate(value)).toEqual(expect.arrayContaining([expect.stringMatching(/storeArgs/)]));
  });
});

describe.each([clearArgFields, helperClearArgFields])("clearArgFields %s", fields => {
  it("returns declared fields regardless of reviewed class or server trust", () => {
    for (const cls of ["read", "write", "risky"] as const) for (const trusted of [true, false]) {
      const value = registry({ class: cls, storeArgs: ["owner", "repo"] });
      value.servers.github!.trusted = trusted;
      expect(fields(value, "github", "t")).toEqual(["owner", "repo"]);
    }
  });
  it("returns no fields for absent/empty allowlists or unknown/case-mismatched identities", () => {
    expect(fields(registry(), "github", "t")).toEqual([]);
    expect(fields(registry({ storeArgs: [] }), "github", "t")).toEqual([]);
    for (const [server, tool] of [["unknown", "t"], ["github", "unknown"], ["GitHub", "t"], ["github", "T"],
      ["__proto__", "t"], ["constructor", "t"], ["toString", "t"], ["github", "__proto__"], ["github", "constructor"], ["github", "toString"]]) {
      expect(fields(registry({ storeArgs: ["owner"] }), server!, tool!)).toEqual([]);
    }
  });
  it("ignores inherited server/tool entries and inherited allowlists", () => {
    const value = registry({ storeArgs: ["owner"] });
    const s = value.servers.github!;
    expect(fields({ ...value, servers: Object.create(value.servers) }, "github", "t")).toEqual([]);
    expect(fields({ ...value, servers: { github: { ...s, tools: Object.create(s.tools) } } }, "github", "t")).toEqual([]);
    const inherited = registry();
    Object.setPrototypeOf(inherited.servers.github!.tools.t!, { storeArgs: ["secret"] });
    expect(fields(inherited, "github", "t")).toEqual([]);
  });
  it("treats invalid hand-built classes as unreviewed", () => {
    for (const cls of ["unreviewed", "allow", "constructor", "__proto__"]) {
      expect(fields(registry({ class: cls, storeArgs: ["secret"] }), "github", "t")).toEqual([]);
    }
  });
});
