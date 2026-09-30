import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, appendFileSync, statSync } from "node:fs";
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

  it("Astra #7: never reclaims a lock automatically: a leftover lock makes append fail closed, in bounded time, with instructions, and the lock stays", async () => {
    writeFileSync(`${path}.lock`, "999999 2020-01-01T00:00:00.000Z\n"); // a dead pid: still not ours to delete
    const ledger = createLedger("jsonl", path);
    const prev = process.env.AGENT_LEDGER_LOCK_TIMEOUT_MS;
    process.env.AGENT_LEDGER_LOCK_TIMEOUT_MS = "150";
    try {
      const t0 = performance.now();
      await expect(ledger.append(unsealed(1))).rejects.toThrow(/stale lock.*remove the lock file manually/s);
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(existsSync(`${path}.lock`)).toBe(true);
      expect(existsSync(path)).toBe(false);
      process.env.AGENT_LEDGER_LOCK_TIMEOUT_MS = "x";
      await expect(ledger.append(unsealed(1))).rejects.toThrow(/AGENT_LEDGER_LOCK_TIMEOUT_MS/);
    } finally {
      if (prev === undefined) delete process.env.AGENT_LEDGER_LOCK_TIMEOUT_MS; else process.env.AGENT_LEDGER_LOCK_TIMEOUT_MS = prev;
    }
    rmSync(`${path}.lock`); // the operator's manual recovery step
    await ledger.append(unsealed(1));
    expect(existsSync(`${path}.lock`)).toBe(false); // our own lock is released after each append
  });

  it("Astra #8: a lock path that is a symlink or a FIFO is reported, not followed or blocked on", async () => {
    const { symlinkSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const prev = process.env.AGENT_LEDGER_LOCK_TIMEOUT_MS;
    process.env.AGENT_LEDGER_LOCK_TIMEOUT_MS = "100";
    try {
      const ledger = createLedger("jsonl", path);
      writeFileSync(join(dir, "target.txt"), "12345 2020-01-01T00:00:00.000Z");
      symlinkSync(join(dir, "target.txt"), `${path}.lock`);
      await expect(ledger.append(unsealed(1))).rejects.toThrow(/lock .*is held by/);
      rmSync(`${path}.lock`);
      execFileSync("mkfifo", [`${path}.lock`]);
      const t0 = performance.now();
      await expect(ledger.append(unsealed(1))).rejects.toThrow(/not a regular file|unreadable/);
      expect(performance.now() - t0).toBeLessThan(2000);
    } finally {
      if (prev === undefined) delete process.env.AGENT_LEDGER_LOCK_TIMEOUT_MS; else process.env.AGENT_LEDGER_LOCK_TIMEOUT_MS = prev;
    }
  });
});

describe("createLedger('jsonl'): strict evidence validation (Astra #9, #10)", () => {
  it("refuses to append on a tail that is not a complete, self-consistent record", async () => {
    writeFileSync(path, '{"id":"bad","hash":"x"}\n');
    await expect(createLedger("jsonl", path).append(unsealed(1))).rejects.toThrow(/invalid.*refusing to append/s);
    rmSync(path);
    await appendN(1);
    const recs = parsed();
    recs[0]!.hash = "0".repeat(64);
    rewrite(recs);
    await expect(createLedger("jsonl", path).append(unsealed(2))).rejects.toThrow(/fails its own hash/);
    expect(lines().length).toBe(1);
  });

  it("verify() rejects a correctly hashed record that is missing required fields, duplicate ids, blank lines and non-finite numbers", async () => {
    await appendN(2);
    const recs = parsed();
    const partial: Record<string, unknown> = { id: "rec-3", prevHash: recs[1]!.hash, parentRecordId: "rec-2" };
    partial.hash = hashRecord(partial as never);
    rewrite([...recs, partial as unknown as LedgerRecord]);
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 3, brokenAt: "rec-3" });
    const dup = { ...recs[1]!, id: "rec-1" } as LedgerRecord;
    rewrite(rechain([recs[0]!, dup], 1));
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 2, brokenAt: "rec-1" });
    rewrite(recs);
    writeFileSync(path, readFileSync(path, "utf8").replace("\n", "\n\n"));
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 2, brokenAt: "line:2" });
    const big = { ...recs[1]! };
    rewrite([recs[0]!, big]);
    writeFileSync(path, readFileSync(path, "utf8").replace(`"count":`, `"count":`).replace(lines()[1]!, lines()[1]!.replace('"path":"/tmp/file-2.txt"', '"n":1e400')));
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: false, checked: 2, brokenAt: "rec-2" });
  });

  it("re-reads the tail under the lock: a same-size replacement of the last record is seen, not served from a cache", async () => {
    const ledger = createLedger("jsonl", path);
    await ledger.append(unsealed(1)); await ledger.append(unsealed(2));
    const recs = parsed();
    const swapped = { ...recs[1]!, id: "rec-9" } as LedgerRecord; // same length id, re-hashed: same file size
    rewrite(rechain([recs[0]!, swapped], 1));
    expect(statSync(path).size).toBe(Buffer.byteLength(lines().join("\n") + "\n"));
    const r3 = await ledger.append(unsealed(3));
    expect(r3.parentRecordId).toBe("rec-9");
    expect(r3.prevHash).toBe(swapped.hash);
  });

  it("read() rejects an unframed file and a record with a garbage or offset-free timestamp instead of dropping it", async () => {
    await appendN(2);
    const range = { from: "2020-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" };
    const drain = async (it: AsyncIterable<LedgerRecord>) => { const out: LedgerRecord[] = []; for await (const r of it) out.push(r); return out; };
    const good = readFileSync(path, "utf8");
    writeFileSync(path, good.slice(0, -1));
    await expect(drain(createLedger("jsonl", path).read(range))).rejects.toThrow(/incomplete line/);
    const recs = parsed(good.slice(0, -1).split("\n").length === 2 ? undefined : undefined);
    recs[1]!.writtenAt = "garbage";
    rewrite(rechain(recs, 1));
    await expect(drain(createLedger("jsonl", path).read(range))).rejects.toThrow(/writtenAt/);
    recs[1]!.writtenAt = "2026-09-30T12:00:00";
    rewrite(rechain(recs, 1));
    await expect(drain(createLedger("jsonl", path).read(range))).rejects.toThrow(/writtenAt/);
    await expect(drain(createLedger("jsonl", path).read({ from: "2026-09-30T00:00:00", to: "2026-10-01T00:00:00Z" }))).rejects.toThrow(/range\.from/);
  });
});

describe("createLedger('jsonl'): re-review P1/P2 (integrity, size, duplicate ids)", () => {
  it("P1 integrity: a field injected into a STORED line (hash untouched) breaks verify(), head() and append()", async () => {
    const { ledger } = await appendN(2);
    const raw = lines();
    const injected = JSON.parse(raw[1]!) as Record<string, Record<string, unknown>>;
    injected.policy!.credential = "UNHASHED-SECRET";
    writeFileSync(path, `${raw[0]}\n${JSON.stringify(injected)}\n`);
    expect(await ledger.verify()).toEqual({ ok: false, checked: 2, brokenAt: "rec-2" });
    await expect(ledger.head()).rejects.toThrow(/unknown field/);
    await expect(ledger.append(unsealed(3))).rejects.toThrow(/unknown field/);
    // the same at the top level and inside call
    const top = JSON.parse(raw[1]!) as Record<string, unknown>; top.extra = 1;
    writeFileSync(path, `${raw[0]}\n${JSON.stringify(top)}\n`);
    expect(await ledger.verify()).toEqual({ ok: false, checked: 2, brokenAt: "rec-2" });
    const call = JSON.parse(raw[1]!) as Record<string, Record<string, unknown>>; call.call!.credential = { kind: "api_key", value: "x" };
    writeFileSync(path, `${raw[0]}\n${JSON.stringify(call)}\n`);
    expect(await ledger.verify()).toEqual({ ok: false, checked: 2, brokenAt: "rec-2" });
  });

  it("round 3: a stored line must be the exact JCS serialisation of its record: duplicate members, whitespace and reordering all break verify/head/append", async () => {
    const { ledger } = await appendN(2);
    const raw = lines();
    const variants: [string, string][] = [
      ["duplicate member before policy.reason", raw[1]!.replace('"reason":', '"reason":"UNHASHED-SECRET","reason":')],
      ["duplicate top-level id", raw[1]!.replace('{"call":', '{"id":"rec-x","call":')],
      ["whitespace", raw[1]!.replace('"phase":', ' "phase":')],
      ["reordered members", (() => { const o = JSON.parse(raw[1]!) as Record<string, unknown>; const { id, ...rest } = o; return JSON.stringify({ ...rest, id }); })()],
      ["unicode escape instead of literal", raw[1]!.replace('"Read"', '"\\u0052ead"')],
    ];
    for (const [name, line] of variants) {
      expect(line, name).not.toBe(raw[1]);
      writeFileSync(path, `${raw[0]}\n${line}\n`);
      expect(await ledger.verify(), name).toEqual({ ok: false, checked: 2, brokenAt: "rec-2" });
      await expect(ledger.head(), name).rejects.toThrow(/canonical|unknown field|invalid/);
      await expect(ledger.append(unsealed(3)), name).rejects.toThrow(/canonical|unknown field|invalid/);
    }
    writeFileSync(path, `${raw[0]}\n${raw[1]}\n`);
    expect(await ledger.verify()).toEqual({ ok: true, checked: 2 });
  });

  it("round 3: an accessor anywhere in a contract object is rejected before writing (outcome.durationMs getter that changes its answer)", async () => {
    const { ledger } = await appendN(1);
    const before = readFileSync(path);
    let reads = 0;
    const outcome = Object.defineProperty({ status: "ok" }, "durationMs", { get() { reads++; return reads <= 4 ? 1 : -1; }, enumerable: true });
    await expect(ledger.append({ ...unsealed(2), phase: "outcome", outcome: outcome as never })).rejects.toThrow(/outcome\.durationMs is an accessor/);
    expect(reads).toBe(0);
    const policy = new Proxy({ verdict: "allow", ruleId: "r", reason: "", risk: "read" }, {});
    await expect(ledger.append({ ...unsealed(3), policy: policy as never })).rejects.toThrow(/policy is a Proxy/);
    const call = Object.defineProperty({ ...unsealed(4).call }, "tool", { get: () => "Read", enumerable: true });
    await expect(ledger.append({ ...unsealed(4), call: call as never })).rejects.toThrow(/call\.tool is an accessor/);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(await ledger.verify()).toEqual({ ok: true, checked: 1 });
  });

  it("P1 size: a record whose REDACTED args exceed the storage limits is rejected before writing; the file is untouched and stays usable", async () => {
    const { ledger } = await appendN(1);
    const before = readFileSync(path);
    await expect(ledger.append(unsealed(2, { text: "a@b.co ".repeat(35_000) }))).rejects.toThrow(/after redaction.*longer than.*nothing was written/s);
    expect(readFileSync(path).equals(before)).toBe(true);
    const r3 = await ledger.append(unsealed(3));
    expect(r3.parentRecordId).toBe("rec-1");
    expect(await ledger.verify()).toEqual({ ok: true, checked: 2 });
    expect(await ledger.head()).toBe(r3.hash);
  });

  it("P2 duplicate ids: the second append of an id is refused under the lock, also from another store instance, and after reopen", async () => {
    const a = createLedger("jsonl", path); const b = createLedger("jsonl", path);
    await a.append(unsealed(1));
    await expect(a.append(unsealed(1))).rejects.toThrow(/duplicate id "rec-1"/);
    await expect(b.append(unsealed(1))).rejects.toThrow(/duplicate id "rec-1"/);
    await b.append(unsealed(2));
    await expect(a.append(unsealed(2))).rejects.toThrow(/duplicate id "rec-2"/);
    await expect(createLedger("jsonl", path).append(unsealed(1))).rejects.toThrow(/duplicate id/);
    expect(await a.verify()).toEqual({ ok: true, checked: 2 });
    expect(lines().length).toBe(2);
  });
});

describe("createLedger('jsonl'): residual limit (Astra #13)", () => {
  it("a FULL re-chain by whoever can write the file passes verify(); only a comparison with an independently kept anchor catches it", async () => {
    const { createAnchor } = await import("../src/anchor/contract.js");
    const anchorPath = join(dir, "elsewhere", "anchor.jsonl"); // stands in for an off-machine copy
    const anchor = createAnchor("file", anchorPath);
    const { ledger } = await appendN(3);
    await anchor.write({ hash: await ledger.head(), at: "2026-09-30T00:00:00Z" });

    // Attacker with write access edits record 1 and recomputes every later link and hash.
    const recs = parsed();
    recs[0]!.call.args = { path: "/etc/shadow" };
    rewrite(rechain(recs, 0));
    expect(await createLedger("jsonl", path).verify()).toEqual({ ok: true, checked: 3 }); // internal consistency cannot see it

    // The caller's duty (README "What verify() cannot see"): the anchored head must appear in the verified chain.
    const anchored = (await anchor.latest())!.hash;
    const hashes = new Set(parsed().map((r) => r.hash));
    expect(hashes.has(anchored)).toBe(false); // tamper detected by the trusted anchor, not by verify()

    // Control: the untouched chain does contain its anchored head.
    rmSync(path);
    const { out } = await appendN(3);
    await anchor.write({ hash: out[2]!.hash, at: "2026-10-01T00:00:00Z" });
    expect(new Set(parsed().map((r) => r.hash)).has((await anchor.latest())!.hash)).toBe(true);
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
