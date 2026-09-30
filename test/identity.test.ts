import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { createIdentity } from "../src/identity/contract.js";
import type { AgentCredential } from "../src/types/index.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function file(value: unknown, format: "yaml" | "json" | "raw" = "yaml") {
  const dir = mkdtempSync(join(tmpdir(), "ledger-identity-")); dirs.push(dir);
  const path = join(dir, "agents.yaml");
  writeFileSync(path, format === "raw" ? value as string : format === "json" ? JSON.stringify(value) : stringify(value));
  return path;
}
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const agent = (id = "astra", kind = "local", value = "local-test-credential") => ({ id, credential: { kind, sha256: digest(value) } });
const config = (agents: unknown[] = [agent()]) => ({ version: 1, agents });

describe("file identity", () => {
  it.each(["yaml", "json"] as const)("resolves known credentials from %s without persisting their values", async format => {
    const path = file(config([agent(), agent("build-bot", "api_key", "test-api-key")]), format);
    const before = readFileSync(path, "utf8");
    const identity = createIdentity("file", path);
    expect(await identity.resolveAgent({ kind: "local", value: "local-test-credential" })).toBe("astra");
    expect(await identity.resolveAgent({ kind: "api_key", value: "test-api-key" })).toBe("build-bot");
    expect(before).not.toContain("local-test-credential");
    expect(before).not.toContain("test-api-key");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
  it.each([
    { kind: "local", value: "unknown" }, { kind: "api_key", value: "local-test-credential" },
    { kind: "local", value: "Local-test-credential" }, { kind: "local", value: "local-test-credential " },
    { kind: "local", value: "" }, { kind: "other", value: "local-test-credential" },
    { kind: "local", value: 42 }, {}, null,
    Object.create({ kind: "local", value: "local-test-credential" }),
  ])("rejects unknown or malformed credentials without echoing them %#", async credential => {
    const identity = createIdentity("file", file(config()));
    await expect(identity.resolveAgent(credential as AgentCredential)).rejects.toThrow(/^Unknown agent credential$/);
  });
  it("namespaces identical values by kind", async () => {
    const identity = createIdentity("file", file(config([agent("local-agent", "local", "same"), agent("api-agent", "api_key", "same")])));
    expect(await identity.resolveAgent({ kind: "local", value: "same" })).toBe("local-agent");
    expect(await identity.resolveAgent({ kind: "api_key", value: "same" })).toBe("api-agent");
  });
  it("does not resolve a stored digest as a credential", async () => {
    const identity = createIdentity("file", file(config()));
    await expect(identity.resolveAgent({ kind: "local", value: digest("local-test-credential") })).rejects.toThrow();
  });
  it("uses a static validated snapshot until the service is recreated", async () => {
    const path = file(config()); const first = createIdentity("file", path);
    writeFileSync(path, stringify(config([agent("new-agent", "local", "new-credential")])));
    expect(await first.resolveAgent({ kind: "local", value: "local-test-credential" })).toBe("astra");
    await expect(first.resolveAgent({ kind: "local", value: "new-credential" })).rejects.toThrow();
    const second = createIdentity("file", path);
    expect(await second.resolveAgent({ kind: "local", value: "new-credential" })).toBe("new-agent");
    await expect(second.resolveAgent({ kind: "local", value: "local-test-credential" })).rejects.toThrow();
  });
  it("creates unique opaque sessions across agents, concurrent calls, and instances", async () => {
    const path = file(config([agent(), agent("fable", "local", "fable-credential")]));
    const a = createIdentity("file", path), b = createIdentity("file", path);
    const ids = await Promise.all(Array.from({ length: 1000 }, (_, i) => (i % 2 ? a : b).startSession(i % 3 ? "astra" : "fable", i % 5 ? "ryan" : undefined)));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(readFileSync(path, "utf8")).not.toContain(ids[0]);
  });
  it("refuses sessions for unknown agents and malformed attribution", async () => {
    const identity = createIdentity("file", file(config()));
    for (const id of ["unknown", "constructor", "__proto__", "Astra", ""]) await expect(identity.startSession(id)).rejects.toThrow(/^Unknown agent$/);
    await expect(identity.startSession("astra", "")).rejects.toThrow(/onBehalfOf/);
    await expect(identity.startSession("astra", 42 as unknown as string)).rejects.toThrow(/onBehalfOf/);
  });
  it.each([
    null, [], {}, { version: 2, agents: [] }, { version: 1, agents: {} }, { ...config(), extra: true },
    config([{}]), config([null]), config([{ ...agent(), extra: true }]), config([{ ...agent(), id: " " }]),
    config([{ ...agent(), credential: { kind: "other", sha256: digest("x") } }]),
    config([{ ...agent(), credential: { kind: "local", sha256: "xyz" } }]),
    config([{ ...agent(), credential: { kind: "local", sha256: "A".repeat(64) } }]),
    config([{ ...agent(), credential: { kind: "local", value: "DO-NOT-ECHO-THIS" } }]),
    config([agent(), agent("astra", "api_key", "different")]),
    config([agent(), agent("other-agent")]),
  ])("refuses malformed/ambiguous registry at initialization %#", value => {
    expect(() => createIdentity("file", file(value))).toThrow(/^Invalid identity registry$/);
  });
  it.each([
    'version: 1\nversion: 1\nagents: []',
    'version: 1\nagents: [\nDO-NOT-ECHO-THIS',
    'version: 1\nagents: !unknown []',
    'version: 1\nagents: []\n__proto__: {}',
  ])("refuses invalid YAML without exposing source %#", raw => {
    expect(() => createIdentity("file", file(raw, "raw"))).toThrow(/^Invalid identity registry$/);
  });
  it("refuses unreadable files and supports an empty registry without granting access", async () => {
    const path = file(config([])); const identity = createIdentity("file", path);
    await expect(identity.resolveAgent({ kind: "local", value: "anything" })).rejects.toThrow();
    rmSync(path);
    expect(() => createIdentity("file", path)).toThrow(/^Unable to read identity registry$/);
  });
  it("keeps postgres explicitly unimplemented", () => {
    expect(() => createIdentity("postgres", "unused")).toThrow(/^not implemented: identity.createIdentity/);
  });
});
