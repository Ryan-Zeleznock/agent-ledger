import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger } from "../src/ledger/contract.js";
import type { UnsealedRecord } from "../src/types/index.js";
import { unsealed } from "./helpers/ledger-fixtures.js";
import { sealRecord, sealedLine, verifyLines } from "../src/ledger/chain.js";
import { pgSkipReason, startPgCluster, type PgCluster } from "./helpers/pg-cluster.js";
import canonicalize from "canonicalize";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("shared chain storage", () => {
  it("round-trips the pinned no-channel approval and verifies it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-chain-")); dirs.push(dir);
    const ledger = createLedger("jsonl", join(dir, "ledger.jsonl"));
    // PIN-2A: shared type is supplied by Package A at integration; runtime literal is binding now.
    const input = { ...unsealed(1), approval: { callId: "call-1", decision: "no-channel",
      channel: "none", decidedAt: "2026-10-03T12:00:00.000Z" } } as unknown as UnsealedRecord;
    const record = await ledger.append(input);
    expect(record.approval?.channel).toBe("none");
    expect(await ledger.verify()).toEqual({ ok: true, checked: 1 });
    const rows = [];
    for await (const row of ledger.read({ from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" })) rows.push(row);
    expect(rows).toEqual([record]);
  });
});

const first = sealRecord(unsealed(1), { id: null, hash: "0" });
const second = sealRecord(unsealed(2), { id: first.id, hash: first.hash });
const third = sealRecord(unsealed(3), { id: second.id, hash: second.hash });
const originals = [first, second, third];
const fixtures: { name: string; change(lines: string[]): string[]; ok: boolean; checked: number }[] = [
  { name: "valid canonical chain", change: x => x, ok: true, checked: 3 },
  { name: "edited args", change: x => { const r = JSON.parse(x[1]!); r.call.args = { changed: true }; x[1] = canonicalize(r)!; return x; }, ok: false, checked: 2 },
  { name: "deleted middle row", change: x => [x[0]!, x[2]!], ok: false, checked: 2 },
  { name: "reordered rows", change: x => [x[1]!, x[0]!, x[2]!], ok: false, checked: 1 },
  { name: "truncated record bytes", change: x => [x[0]!, x[1]!.slice(0, -1)], ok: false, checked: 2 },
  { name: "deleted complete suffix needs an external anchor", change: x => x.slice(0, 2), ok: true, checked: 2 },
  { name: "duplicate id", change: x => { const r = JSON.parse(x[1]!); r.id = first.id; x[1] = canonicalize(r)!; return x; }, ok: false, checked: 2 },
  { name: "injected unknown field", change: x => { const r = JSON.parse(x[1]!); r.credential = "canary"; x[1] = canonicalize(r)!; return x; }, ok: false, checked: 2 },
  { name: "noncanonical whitespace", change: x => { x[1] += " "; return x; }, ok: false, checked: 2 },
  { name: "noncanonical member order", change: x => { x[1] = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(x[1]!)).reverse())); return x; }, ok: false, checked: 2 },
  { name: "noncanonical escape", change: x => { x[1] = x[1]!.replace("rec-2", "\\u0072ec-2"); return x; }, ok: false, checked: 2 },
  { name: "leap second", change: x => { const r = JSON.parse(x[1]!); r.writtenAt = "2026-09-30T12:00:60.000Z"; x[1] = canonicalize(r)!; return x; }, ok: false, checked: 2 },
  { name: "duplicate JSON member", change: x => { x[1] = '{"id":"unhashed",' + x[1]!.slice(1); return x; }, ok: false, checked: 2 },
];
describe("JSONL and shared verifier fixture table", () => {
  it.each(fixtures)("$name", async fixture => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-parity-")); dirs.push(dir);
    const path = join(dir, "ledger.jsonl");
    const lines = fixture.change(originals.map(sealedLine));
    writeFileSync(path, lines.join("\n") + "\n");
    const expected = { ok: fixture.ok, checked: fixture.checked };
    expect(await createLedger("jsonl", path).verify()).toMatchObject(expected);
    async function* stream() { yield* lines; }
    expect(await verifyLines(stream())).toMatchObject(expected);
    if (fixture.name.startsWith("deleted complete")) expect(lines.join("\n")).not.toContain(third.hash);
  });
});

describe.skipIf(!!pgSkipReason)("Postgres uses the same fixture table", () => {
  let cluster: PgCluster;
  beforeAll(async () => { cluster = await startPgCluster(); }, 90_000);
  afterAll(async () => { await cluster?.stop(); }, 30_000);
  it.each(fixtures)("$name", async fixture => {
    await cluster.reset();
    const lines = fixture.change(originals.map(sealedLine));
    // Superuser fixture deliberately allows line/index disagreement; production appends derive all columns.
    for (let i = 0; i < lines.length; i++) {
      const r = originals[i]!;
      await cluster.admin.query("INSERT INTO ledger.records (id,hash,prev_hash,written_at,call_id,phase,line) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [r.id, r.hash, r.prevHash, r.writtenAt, r.call.callId, r.phase, lines[i]]);
    }
    const ledger = createLedger("postgres", cluster.url());
    try { expect(await ledger.verify()).toMatchObject({ ok: fixture.ok, checked: fixture.checked }); }
    finally { if ("close" in ledger) await (ledger as { close(): Promise<void> }).close(); }
  });
  it("round-trips channel none through Postgres append and strict read", async () => {
    await cluster.reset();
    const ledger = createLedger("postgres", cluster.url());
    try {
      const input = { ...unsealed(1), approval: { callId: "call-1", decision: "no-channel", channel: "none",
        decidedAt: "2026-10-03T12:00:00.000Z" } } as unknown as UnsealedRecord;
      const record = await ledger.append(input);
      expect(record.approval?.channel).toBe("none");
      expect(await ledger.verify()).toEqual({ ok: true, checked: 1 });
      const rows = []; for await (const row of ledger.read({ from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" })) rows.push(row);
      expect(rows).toEqual([record]);
    } finally { if ("close" in ledger) await (ledger as { close(): Promise<void> }).close(); }
  });
});
