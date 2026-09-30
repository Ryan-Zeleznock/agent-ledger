import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnchor } from "../src/anchor/contract.js";

let dir: string; let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agent-ledger-anchor-")); path = join(dir, "anchors", "chain-head.jsonl"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const h = (c: string) => c.repeat(64);
const lines = () => readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);

describe("createAnchor('file')", () => {
  it("latest() is null before any write, then returns the last write (todo: anchor)", async () => {
    const anchor = createAnchor("file", path);
    expect(await anchor.latest()).toBeNull();
    await anchor.write({ hash: h("a"), at: "2026-09-30T00:00:00.000Z" });
    await anchor.write({ hash: h("b"), at: "2026-10-01T00:00:00.000Z" });
    expect(await anchor.latest()).toEqual({ hash: h("b"), at: "2026-10-01T00:00:00.000Z" });
  });

  it("the file anchor is append-only: every write adds one line, earlier lines never change, the file only grows (todo: anchor)", async () => {
    const anchor = createAnchor("file", path);
    await anchor.write({ hash: h("a"), at: "2026-09-30T00:00:00.000Z" });
    const first = readFileSync(path, "utf8");
    const size1 = statSync(path).size;
    await anchor.write({ hash: h("b"), at: "2026-10-01T00:00:00.000Z" });
    await anchor.write({ hash: h("a"), at: "2026-10-02T00:00:00.000Z" }); // same head again: still a new line
    expect(readFileSync(path, "utf8").startsWith(first)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(size1);
    expect(lines().map((l) => JSON.parse(l) as { hash: string })).toEqual([
      { at: "2026-09-30T00:00:00.000Z", hash: h("a") }, { at: "2026-10-01T00:00:00.000Z", hash: h("b") }, { at: "2026-10-02T00:00:00.000Z", hash: h("a") },
    ]);
    // The API surface is exactly the interface: write and latest. No update, no delete, no truncate.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(anchor)).filter((k) => k !== "constructor" && !k.startsWith("_") && k !== "serialize").sort();
    expect(methods).toEqual(["latest", "write"]);
  });

  it("stores each entry as one canonical JSON line and creates parent directories", async () => {
    const anchor = createAnchor("file", path);
    expect(existsSync(path)).toBe(false);
    await anchor.write({ hash: h("c"), at: "2026-09-30T00:00:00.000Z" });
    expect(lines()).toEqual([`{"at":"2026-09-30T00:00:00.000Z","hash":"${h("c")}"}`]);
  });

  it("rejects a malformed entry without touching the file: hash must be 64 lowercase hex (or '0' for an empty chain), at must be a date", async () => {
    const anchor = createAnchor("file", path);
    await expect(anchor.write({ hash: "not-a-hash", at: "2026-09-30T00:00:00.000Z" })).rejects.toThrow(/hash/);
    await expect(anchor.write({ hash: h("A"), at: "2026-09-30T00:00:00.000Z" })).rejects.toThrow(/hash/);
    await expect(anchor.write({ hash: h("a"), at: "yesterday" })).rejects.toThrow(/at/);
    await expect(anchor.write({ hash: h("a"), at: "2026-09-30T00:00:00.000Z", extra: 1 } as never)).rejects.toThrow(/extra/);
    expect(existsSync(path)).toBe(false);
    await anchor.write({ hash: "0", at: "2026-09-30T00:00:00.000Z" });
    expect(await anchor.latest()).toEqual({ hash: "0", at: "2026-09-30T00:00:00.000Z" });
  });

  it("latest() survives a reopen and refuses a tampered or incomplete last line", async () => {
    await createAnchor("file", path).write({ hash: h("d"), at: "2026-09-30T00:00:00.000Z" });
    expect(await createAnchor("file", path).latest()).toEqual({ hash: h("d"), at: "2026-09-30T00:00:00.000Z" });
    appendFileSync(path, '{"hash":"zzz","at":"2026-09-30T00:00:00.000Z"}\n');
    await expect(createAnchor("file", path).latest()).rejects.toThrow(/anchor/);
    appendFileSync(path, '{"hash":"');
    await expect(createAnchor("file", path).latest()).rejects.toThrow(/anchor/);
  });

  it("concurrent writes all land, one line each", async () => {
    const anchor = createAnchor("file", path);
    await Promise.all(Array.from({ length: 20 }, (_, i) => anchor.write({ hash: h((i % 16).toString(16)), at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() })));
    expect(lines().length).toBe(20);
    for (const l of lines()) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("createAnchor('s3') stays not implemented (later: S3 Object Lock)", () => {
    expect(() => createAnchor("s3", "s3://bucket/key")).toThrow(/^not implemented: /);
  });
});
