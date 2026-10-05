import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger } from "../src/ledger/contract.js";
import { createAnchor } from "../src/anchor/contract.js";
import { snapshotJsonData, MAX_TOTAL_CHARS } from "../src/ledger/validate.js";
import { readConfigFile, parseConfigDocument } from "../src/config-file.js";
import { unsealed } from "./helpers/ledger-fixtures.js";

const dirs: string[] = [];
function path() { const d = fs.mkdtempSync(join(tmpdir(), "core-security-")); dirs.push(d); return join(d, "data"); }
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const range = { from: "2020-01-01T00:00:00Z", to: "2090-01-01T00:00:00Z" };
const read = async (ledger: ReturnType<typeof createLedger>) => { for await (const _ of ledger.read(range)) { /* consume */ } };

it("C6: invalid UTF-8 cannot substitute for a hashed replacement character", async () => {
  const p = path(), ledger = createLedger("jsonl", p);
  await ledger.append(unsealed(1, { text: "\ufffd" }));
  const bytes = fs.readFileSync(p), offset = bytes.indexOf(Buffer.from("\ufffd"));
  expect(offset).toBeGreaterThan(0);
  fs.writeFileSync(p, Buffer.concat([bytes.subarray(0, offset), Buffer.from([0xff]), bytes.subarray(offset + 3)]));
  expect((await ledger.verify()).ok).toBe(false);
  await expect(ledger.head()).rejects.toThrow();
  await expect(read(ledger)).rejects.toThrow();
  await expect(ledger.append(unsealed(2))).rejects.toThrow();
});

it.each(["ledger", "anchor"])("C7: %s refuses symlink reads and writes without touching the target", async kind => {
  const p = path(), target = p + ".target";
  if (kind === "ledger") await createLedger("jsonl", target).append(unsealed(1));
  else await createAnchor("file", target).write({ hash: "a".repeat(64), at: range.from });
  const before = fs.readFileSync(target); fs.symlinkSync(target, p);
  if (kind === "ledger") {
    const l = createLedger("jsonl", p);
    await expect(l.head()).rejects.toThrow();
    await expect(read(l)).rejects.toThrow();
    await expect(l.append(unsealed(2))).rejects.toThrow();
    await expect(l.verify()).rejects.toThrow();
  } else {
    const a = createAnchor("file", p);
    await expect(a.latest()).rejects.toThrow();
    await expect(a.write({ hash: "b".repeat(64), at: range.from })).rejects.toThrow();
  }
  expect(fs.readFileSync(target)).toEqual(before);
});

it("C8: key-only objects and scalar arrays obey character and structure budgets", () => {
  expect(() => snapshotJsonData({ ["x".repeat(MAX_TOTAL_CHARS + 1)]: 0 }, "args")).toThrow();
  expect(() => snapshotJsonData(Array(100_001).fill(0), "args")).toThrow();
});
it("C8: config reads reject oversized files before reading and reject non-regular descriptors", () => {
  const p = path(); fs.writeFileSync(p, " ".repeat(1024 * 1024 + 1));
  expect(() => readConfigFile(p)).toThrow(/limit|large|size/i);
  expect(() => readConfigFile(dirs.at(-1)!)).toThrow(/regular/i);
});
it.each([
  "version: 1\nx: " + "[".repeat(100) + "0" + "]".repeat(100),
  "version: 1\nx: [" + "0,".repeat(100_001) + "0]",
  "version: 1\nx: &x [*x]",
])("C8: config structure is bounded before conversion (%#)", source => {
  expect(() => parseConfigDocument(source)).toThrow();
});
it("C8: ledger line and anchor tail reads are bounded", async () => {
  const p = path(); fs.writeFileSync(p, "x".repeat(8 * 1024 * 1024 + 1) + "\n");
  const l = createLedger("jsonl", p);
  expect((await l.verify()).ok).toBe(false);
  await expect(l.head()).rejects.toThrow(/limit|large|size/i);
  await expect(read(l)).rejects.toThrow(/limit|large|size/i);
  await expect(createAnchor("file", p).latest()).rejects.toThrow(/limit|large|size/i);
});

it("C4: 3000 completed proxy calls retain less than 5 MiB after GC", () => {
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { createPipeline } from './.test-build/src/pipeline/contract.js';
    const pipeline = createPipeline({
      identity: { resolveAgent: async () => 'agent', startSession: async () => 'session' },
      registry: { version: 1, servers: { s: { trusted: true, tools: { t: { class: 'read', reviewedBy: 'r', reviewedAt: '2026-09-30', storeArgs: ['text'] } } } } },
      ledger: { append: async r => r, async *read() {}, head: async () => '0', verify: async () => ({ok: true, checked: 0}) },
      upstream: { execute: async () => ({content: 'ok'}), listTools: async () => [], close: async () => {} },
      approvals: {kind: 'none'}, argsHmacKey: new Uint8Array(32),
    });
    async function run(i) { await pipeline.handle({ callId: String(i), credential: {kind: 'local', value: 'x'}, server: 's', tool: 't', args: {text: ('value ' + i + ' ').repeat(1000)}, receivedAt: '2026-09-30T12:00:00Z' }); }
    for (let i = 0; i < 100; i++) await run(i);
    global.gc(); const before = process.memoryUsage().heapUsed;
    for (let i = 100; i < 3100; i++) await run(i);
    global.gc(); const growth = process.memoryUsage().heapUsed - before;
    assert.ok(growth < 5 * 1024 * 1024, 'retained bytes: ' + growth);
    await run(3101);
  `], { timeout: 30_000, killSignal: "SIGKILL", encoding: "utf8" });
  expect(child.error, child.stderr).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
}, 35_000);

it.each(["ledger", "anchor"])("C7: %s validates and appends through the same descriptor across path replacement", async kind => {
  const p = path(), target = p + ".target", held = p + ".held";
  if (kind === "ledger") await createLedger("jsonl", p).append(unsealed(1));
  else await createAnchor("file", p).write({ hash: "a".repeat(64), at: range.from });
  fs.copyFileSync(p, target);
  const before = fs.readFileSync(target), inode = fs.statSync(p).ino, original = fs.fstatSync;
  let replaced = false;
  vi.spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof original>) => {
    const st = original(...args);
    if (!replaced && st.ino === inode) {
      replaced = true; fs.renameSync(p, held); fs.symlinkSync(target, p);
    }
    return st;
  }) as typeof original);
  syncBuiltinESMExports();
  if (kind === "ledger") await createLedger("jsonl", p).append(unsealed(2));
  else await createAnchor("file", p).write({ hash: "b".repeat(64), at: range.from });
  expect(replaced).toBe(true);
  expect(fs.readFileSync(target)).toEqual(before);
  expect(fs.readFileSync(held).length).toBeGreaterThan(before.length);
});

it("C8: aggregate key characters count even when every value is numeric", () => {
  const keys = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i) + "x".repeat(220_000), 0]));
  expect(() => snapshotJsonData(keys, "args")).toThrow(/character limit/);
});

it("C8: config growth after fstat cannot bypass the read limit", () => {
  const p = path(); fs.writeFileSync(p, "version: 1\n");
  const original = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof original>) => {
    const st = original(...args);
    fs.appendFileSync(p, " ".repeat(1024 * 1024));
    return st;
  }) as typeof original);
  expect(() => readConfigFile(p)).toThrow(/size limit/);
});

it.each(["json", "shape", "utf8", "oversized", "joined"])("R2: earlier %s damage preserves append availability and remains detectable", async damage => {
  const p = path(), ledger = createLedger("jsonl", p);
  await ledger.append(unsealed(1)); const tail = await ledger.append(unsealed(2));
  const original = fs.readFileSync(p), newline = original.indexOf(10);
  const bad = damage === "json" ? Buffer.from("not-json\n") : damage === "shape" ? Buffer.from('{"id":"rec-1"}\n') :
    damage === "utf8" ? Buffer.from([0xff, 10]) : damage === "oversized" ? Buffer.from("x".repeat(8 * 1024 * 1024 + 1) + "\n") : Buffer.from("torn-prefix" + original.subarray(0, newline + 1).toString());
  fs.writeFileSync(p, Buffer.concat([bad, original.subarray(newline + 1)]));
  const damaged = fs.readFileSync(p);
  const restarted = createLedger("jsonl", p);
  expect((await restarted.verify()).ok).toBe(false);
  const appended = await restarted.append(unsealed(3));
  expect(appended.prevHash).toBe(tail.hash); expect(appended.parentRecordId).toBe(tail.id);
  await expect(restarted.append(unsealed(2))).rejects.toThrow(/duplicate id/);
  expect(fs.readFileSync(p).subarray(0, damaged.length).equals(damaged)).toBe(true);
  expect((await restarted.verify()).ok).toBe(false);
});
it.each(["json", "torn", "utf8", "oversized"])("R2: final %s damage blocks append without changing evidence", async damage => {
  const p = path(), ledger = createLedger("jsonl", p); await ledger.append(unsealed(1));
  const bad = damage === "json" ? Buffer.from("not-json\n") : damage === "torn" ? Buffer.from("torn") :
    damage === "utf8" ? Buffer.from([0xff, 10]) : Buffer.from("x".repeat(8 * 1024 * 1024 + 1) + "\n");
  fs.appendFileSync(p, bad); const before = fs.readFileSync(p);
  await expect(createLedger("jsonl", p).append(unsealed(2))).rejects.toThrow();
  expect(fs.readFileSync(p).equals(before)).toBe(true);
  expect((await ledger.verify()).ok).toBe(false);
});
it("R4: package and lockfile require Node >=24", () => {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  expect(pkg.engines.node).toBe(">=24");
  expect(lock.packages[""].engines.node).toBe(">=24");
});
