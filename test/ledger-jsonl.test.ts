import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import canonicalize from "canonicalize";
import { createLedger, hashRecord } from "../src/ledger/contract.js";
import type { LedgerRecord } from "../src/types/index.js";
import { unsealed } from "./helpers/ledger-fixtures.js";

let dir: string; let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agent-ledger-")); path = join(dir, "ledger.jsonl"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lines = (p = path) => readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
const parsed = (p = path) => lines(p).map((l) => JSON.parse(l) as LedgerRecord);
const rewrite = (records: LedgerRecord[], p = path) => writeFileSync(p, records.map((r) => canonicalize(r)!).join("\n") + "\n");
/** Re-seals `records[from..]` so the hashes chain again after an edit: used to prove verify() checks MORE than hashes. */
const rechain = (records: LedgerRecord[], from: number) => {
  for (let i = from; i < records.length; i++) {
    const r = records[i]!;
    if (i > 0) r.prevHash = records[i - 1]!.hash;
    const { hash: _h, ...rest } = r;
    r.hash = hashRecord(rest);
  }
  return records;
};
async function appendN(n: number, ledger = createLedger("jsonl", path)) {
  const out: LedgerRecord[] = [];
  for (let i = 1; i <= n; i++) out.push(await ledger.append(unsealed(i)));
  return { ledger, out };
}

describe("createLedger('jsonl'): sealing", () => {
  it("genesis record has parentRecordId null and prevHash '0'; every later record's parentRecordId is the previous id and prevHash the previous hash (todo: ledger)", async () => {
    const { out } = await appendN(3);
    expect(out[0]!.parentRecordId).toBeNull();
    expect(out[0]!.prevHash).toBe("0");
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.parentRecordId).toBe(out[i - 1]!.id);
      expect(out[i]!.prevHash).toBe(out[i - 1]!.hash);
    }
  });

  it("seals hash (spec §5 rule), writtenAt (ISO 8601) and stores exactly the returned record as one JCS line", async () => {
    const { out } = await appendN(2);
    for (const r of out) {
      const { hash, ...rest } = r;
      expect(hash).toBe(hashRecord(rest));
      expect(new Date(r.writtenAt).toISOString()).toBe(r.writtenAt);
    }
    expect(lines()).toEqual(out.map((r) => canonicalize(r)));
  });

  it("creates the file and its parent directories on first append; head() is '0' while the chain is empty", async () => {
    const nested = join(dir, "a", "b", "ledger.jsonl");
    const ledger = createLedger("jsonl", nested);
    expect(await ledger.head()).toBe("0");
    expect(existsSync(nested)).toBe(false);
    const r = await ledger.append(unsealed(1));
    expect(existsSync(nested)).toBe(true);
    expect(await ledger.head()).toBe(r.hash);
  });

  it("redacts args before hashing and storage: a secret in args never appears in the stored record (spec §9, §10)", async () => {
    const ledger = createLedger("jsonl", path);
    const r = await ledger.append(unsealed(1, { command: "export DB_PASSWORD=hunter2", nested: [{ token: "tok-xyz" }] }));
    const file = readFileSync(path, "utf8");
    expect(file).not.toMatch(/hunter2|tok-xyz/);
    expect(r.call.args).toEqual({ command: "export DB_PASSWORD=[REDACTED:assignment]", nested: [{ token: "[REDACTED:key:token]" }] });
    const { hash, ...rest } = JSON.parse(lines()[0]!) as LedgerRecord;
    expect(hash).toBe(hashRecord(rest)); // the hash covers the REDACTED form
  });

  it("builds the stored record by explicit field projection: a stray credential or a pre-filled hash never reaches the file (spec §9)", async () => {
    const ledger = createLedger("jsonl", path);
    const dirty = unsealed(1) as unknown as Record<string, unknown>;
    (dirty.call as Record<string, unknown>).credential = { kind: "api_key", value: "SECRET-CRED" };
    dirty.hash = "deadbeef"; dirty.prevHash = "evil"; dirty.extra = "x";
    const r = await ledger.append(dirty as never);
    const file = readFileSync(path, "utf8");
    expect(file).not.toMatch(/SECRET-CRED|credential|deadbeef|evil|extra/);
    expect(r.prevHash).toBe("0");
  });

  it("rejects an unsealed record without a string id or a known phase, and leaves the file untouched", async () => {
    const ledger = createLedger("jsonl", path);
    await expect(ledger.append({ ...unsealed(1), id: "" })).rejects.toThrow(/id/);
    await expect(ledger.append({ ...unsealed(1), phase: "later" as never })).rejects.toThrow(/phase/);
    expect(existsSync(path)).toBe(false);
  });

  it("createLedger('postgres') stays not implemented (Slice 2)", () => {
    expect(() => createLedger("postgres", "postgres://x")).toThrow(/^not implemented: /);
  });
});

describe("createLedger('jsonl'): verify()", () => {
  it("is ok on an empty or missing file (checked 0) and on a clean chain (checked n)", async () => {
    const ledger = createLedger("jsonl", path);
    expect(await ledger.verify()).toEqual({ ok: true, checked: 0 });
    await appendN(5, ledger);
    expect(await ledger.verify()).toEqual({ ok: true, checked: 5 });
  });

  it("editing any one record makes verify() fail at that record (todo: ledger; spec §10)", async () => {
    await appendN(5);
    const recs = parsed();
    recs[2]!.call.args = { path: "/etc/shadow" };
    rewrite(recs);
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 3, brokenAt: "rec-3" });
  });

  it("fails at the record whose prevHash no longer matches when an earlier record is edited and re-hashed", async () => {
    await appendN(4);
    const recs = parsed();
    recs[1]!.policy.verdict = "deny";
    const { hash: _h, ...rest } = recs[1]!;
    recs[1]!.hash = hashRecord(rest); // rec-2 is self-consistent again, but rec-3 still points at the old hash
    rewrite(recs);
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 3, brokenAt: "rec-3" });
  });

  it("verify() fails when parentRecordId continuity breaks even if the hashes still chain (todo: ledger)", async () => {
    await appendN(4);
    const recs = parsed();
    recs[2]!.parentRecordId = "rec-1";
    rewrite(rechain(recs, 2));
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 3, brokenAt: "rec-3" });
  });

  it("fails on a deleted record, on a genesis that is not genesis, and on a malformed line", async () => {
    await appendN(4);
    const recs = parsed();
    rewrite([recs[0]!, recs[2]!, recs[3]!]);
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 2, brokenAt: "rec-3" });
    rewrite([recs[1]!, recs[2]!, recs[3]!]);
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 1, brokenAt: "rec-2" });
    rewrite(recs);
    appendFileSync(path, "{not json\n");
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 5, brokenAt: "line:5" });
  });

  it("treats a final line without a newline (crashed write) as broken, and append() refuses to build on it", async () => {
    await appendN(2);
    appendFileSync(path, '{"id":"partial"');
    const ledger = createLedger("jsonl", path);
    expect(await ledger.verify()).toEqual({ ok: false, checked: 3, brokenAt: "line:3" });
    await expect(ledger.append(unsealed(3))).rejects.toThrow(/incomplete/);
  });
});

describe("createLedger('jsonl'): concurrency and restart", () => {
  it("two (fifty) concurrent appends never share a prevHash (todo: ledger)", async () => {
    const ledger = createLedger("jsonl", path);
    const out = await Promise.all(Array.from({ length: 50 }, (_, i) => ledger.append(unsealed(i + 1))));
    expect(new Set(out.map((r) => r.prevHash)).size).toBe(50);
    expect(new Set(out.map((r) => r.parentRecordId)).size).toBe(50);
    expect(await ledger.verify()).toEqual({ ok: true, checked: 50 });
    expect(await ledger.head()).toBe(parsed().at(-1)!.hash);
  });

  it("two independent store instances on the same file (two processes' worth of state) interleave without sharing a prevHash", async () => {
    const a = createLedger("jsonl", path); const b = createLedger("jsonl", path);
    const out: LedgerRecord[] = [];
    for (let i = 1; i <= 10; i++) {
      out.push(await (i % 2 ? a : b).append(unsealed(i)));
    }
    const both = await Promise.all([...Array.from({ length: 10 }, (_, i) => a.append(unsealed(100 + i))), ...Array.from({ length: 10 }, (_, i) => b.append(unsealed(200 + i)))]);
    out.push(...both);
    expect(new Set(out.map((r) => r.prevHash)).size).toBe(out.length);
    expect(await a.verify()).toEqual({ ok: true, checked: 30 });
    expect(await b.head()).toBe(await a.head());
  });

  it("a JSONL chain verifies after a restart, and new appends continue the old chain (todo: ledger; spec §10)", async () => {
    const { out } = await appendN(3);
    const reopened = createLedger("jsonl", path);
    expect(await reopened.verify()).toEqual({ ok: true, checked: 3 });
    expect(await reopened.head()).toBe(out[2]!.hash);
    const r4 = await reopened.append(unsealed(4));
    expect(r4.prevHash).toBe(out[2]!.hash);
    expect(r4.parentRecordId).toBe("rec-3");
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: true, checked: 4 });
  });

  it("removes its lock file after each append and breaks a lock left by a dead process", async () => {
    writeFileSync(`${path}.lock`, "999999 2020-01-01T00:00:00.000Z\n"); // pid that (almost surely) does not exist
    const ledger = createLedger("jsonl", path);
    await ledger.append(unsealed(1));
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe("createLedger('jsonl'): read(range)", () => {
  it("yields records whose writtenAt falls inside the range (inclusive), in file order", async () => {
    const { out } = await appendN(4);
    const recs = parsed();
    recs[0]!.writtenAt = "2026-09-29T23:59:59.999Z"; recs[1]!.writtenAt = "2026-09-30T00:00:00.000Z";
    recs[2]!.writtenAt = "2026-09-30T12:00:00.000Z"; recs[3]!.writtenAt = "2026-10-01T00:00:00.000Z";
    rewrite(rechain(recs, 0));
    const got: string[] = [];
    for await (const r of createLedger("jsonl", path).read({ from: "2026-09-30T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" })) got.push(r.id);
    expect(got).toEqual(["rec-2", "rec-3"]);
    expect(out.length).toBe(4);
  });

  it("yields nothing for a missing file and throws on an invalid range or a malformed line", async () => {
    const empty: unknown[] = [];
    for await (const r of createLedger("jsonl", path).read({ from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" })) empty.push(r);
    expect(empty).toEqual([]);
    await appendN(1);
    appendFileSync(path, "junk\n");
    const it = createLedger("jsonl", path).read({ from: "2026-01-01T00:00:00Z", to: "2027-01-01T00:00:00Z" });
    await expect((async () => { for await (const _r of it) void _r; })()).rejects.toThrow(/line 2/);
    const bad = createLedger("jsonl", path).read({ from: "yesterday", to: "tomorrow" });
    await expect((async () => { for await (const _r of bad) void _r; })()).rejects.toThrow(/range/);
  });
});
