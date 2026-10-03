import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger } from "../src/ledger/contract.js";
import type { UnsealedRecord } from "../src/types/index.js";
import { unsealed } from "./helpers/ledger-fixtures.js";

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
