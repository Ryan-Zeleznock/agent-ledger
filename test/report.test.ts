import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReport, reconcileHandoffs } from "../src/report/contract.js";
import type { LedgerStore } from "../src/ledger/contract.js";
import type { LedgerRecord, DateRange } from "../src/types/index.js";
import { sealedWithoutHash } from "./helpers/ledger-fixtures.js";

const range = { from: "2026-09-30T12:00:00.000Z", to: "2026-09-30T13:00:00.000Z" };
function record(n: number, patch: Partial<LedgerRecord> = {}): LedgerRecord {
  return { ...sealedWithoutHash(n), hash: String(n).padStart(64, "0"), ...patch };
}
function handoff(n: number, at = range.to): LedgerRecord {
  const r = record(n, { writtenAt: at, handoff: { kind: "to-proxy", proxyServerName: "agentledger_proxy_1234" } });
  r.call.server = "agentledger_proxy_1234";
  r.policy.ruleId = "handoff-to-proxy:agentledger_proxy_1234";
  return r;
}
function proxy(h: LedgerRecord, at: string): LedgerRecord {
  const r = record(99, { writtenAt: at });
  r.call.callId = h.call.callId; r.call.server = "github";
  return r;
}
function store(records: LedgerRecord[]): LedgerStore {
  return { append: vi.fn(), verify: vi.fn(async () => ({ ok: true, checked: records.length })),
    head: vi.fn(async () => records.at(-1)?.hash ?? "0"),
    async *read(r: DateRange) { for (const rec of records) if (Date.parse(rec.writtenAt) >= Date.parse(r.from) && Date.parse(rec.writtenAt) <= Date.parse(r.to)) yield rec; } };
}
const dirs: string[] = [];
async function output() { const d = await mkdtemp(join(tmpdir(), "report-test-")); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe("handoff reconciliation", () => {
  it("reports every missing handoff with the contract fields", async () => {
    const h = handoff(1);
    expect(await reconcileHandoffs(store([h]), range)).toEqual([{ callId: "call-1", proxyServerName: h.handoff!.proxyServerName, hookRecordId: "rec-1", handedOffAt: range.to }]);
  });
  it.each([range.to, "2026-09-30T13:00:30.000Z", "2026-09-30T13:01:00.000Z"])("matches proxy intent at %s", async at => {
    const h = handoff(1); expect(await reconcileHandoffs(store([h, proxy(h, at)]), range)).toEqual([]);
  });
  it("does not match a late proxy, an outcome, another handoff, or a builtin intent", async () => {
    const h = handoff(1);
    for (const r of [proxy(h, "2026-09-30T13:01:00.001Z"), { ...proxy(h, range.to), phase: "outcome" as const }, { ...record(2), call: { ...h.call, server: "builtin:codex" } }]) {
      expect(await reconcileHandoffs(store([h, r]), range)).toHaveLength(1);
    }
    expect(await reconcileHandoffs(store([h, { ...handoff(1), id: "other-handoff" }]), range)).toHaveLength(2);
  });
  it("does not flag proxy-only records or handoffs outside the selected range", async () => {
    const h = handoff(1, "2026-09-30T13:00:30.000Z");
    expect(await reconcileHandoffs(store([h, proxy(h, range.to)]), range)).toEqual([]);
  });
  it("honors custom grace and rejects invalid ranges or grace", async () => {
    const h = handoff(1);
    expect(await reconcileHandoffs(store([h, proxy(h, "2026-09-30T13:00:30.000Z")]), range, 0)).toHaveLength(1);
    for (const g of [-1, NaN, Infinity, 0.5]) await expect(reconcileHandoffs(store([]), range, g)).rejects.toThrow();
    await expect(reconcileHandoffs(store([]), { from: range.to, to: range.from })).rejects.toThrow();
  });
});

describe("evidence pack", () => {
  it("exports an empty range as HTML, PDF and header-only CSV with an empty handoff section", async () => {
    const dir = await output(); const ledger = store([]);
    const files = await generateReport(ledger, range, dir);
    const html = await readFile(join(dir, "report.html"), "utf8");
    expect(html).toContain("0 records"); expect(html).toContain("Unreconciled handoffs"); expect(html).toContain("None");
    expect(html).toContain("best-effort gating"); expect(html).toContain("not enforcement");
    expect((await readFile(files.csvPath, "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
    expect((await readFile(files.pdfPath, "utf8")).startsWith("%PDF-1.4")).toBe(true);
    expect(ledger.verify).toHaveBeenCalled(); expect(ledger.append).not.toHaveBeenCalled();
  });
  it("maps every row, includes policy/approval/chain evidence and labels withheld arguments", async () => {
    const r = record(1); r.call.args = { command: `hmac-sha256:${"a".repeat(64)}`, path: '<script>alert("x")</script>', unicode: "é🙂" };
    r.policy = { verdict: "require_approval", risk: "risky", ruleId: "registry:builtin:claude-code/Bash", reason: "Shell" };
    r.approval = { callId: r.call.callId, decision: "delegated", decidedAt: range.from, channel: "hook-ask" };
    const dir = await output(); const files = await generateReport(store([r, record(2, { writtenAt: "2026-10-01T00:00:00.000Z" })]), range, dir);
    const html = await readFile(join(dir, "report.html"), "utf8"); const csv = await readFile(files.csvPath, "utf8"); const pdf = await readFile(files.pdfPath, "utf8");
    for (const content of [html, csv, pdf]) {
      for (const text of ["CC6.1", "CC7.2", "CC8.1", "rec-1", "delegated", "argument withheld", "registry:builtin:claude-code/Bash"]) expect(content).toContain(text);
      expect(content).not.toContain("hmac-sha256:");
    }
    expect(html).not.toContain('<script>'); expect(html).toContain("&lt;script&gt;");
    expect(csv.trim().split(/\r?\n/)).toHaveLength(2); expect(html).toContain("Chain verification: PASS");
    expect(html).toContain("not a recorded human approval"); expect(html).toContain("no outcome");
  });
  it("lists missing handoffs and true orphan outcomes, using intents before the range", async () => {
    const prior = record(1, { writtenAt: "2026-09-29T12:00:00.000Z" });
    const good = record(2, { phase: "outcome", outcome: { status: "ok" }, call: prior.call });
    const orphan = record(3, { phase: "outcome", outcome: { status: "ok" } });
    const dir = await output(); await generateReport(store([prior, good, orphan, handoff(4)]), range, dir);
    const html = await readFile(join(dir, "report.html"), "utf8");
    expect(html).toContain("call-4"); expect(html).toContain("Orphan outcomes (1)"); expect(html).toContain("rec-3");
  });
  it("shows a broken verification result without claiming a healthy chain", async () => {
    const ledger = store([record(1)]); ledger.verify = async () => ({ ok: false, checked: 1, brokenAt: "rec-1" });
    const dir = await output(); await generateReport(ledger, range, dir);
    const html = await readFile(join(dir, "report.html"), "utf8"); expect(html).toContain("Chain verification: FAIL"); expect(html).toContain("rec-1");
  });
  it("refuses a changing ledger or a read failure before publishing files", async () => {
    const ledger = store([record(1)]); let calls = 0; ledger.head = async () => String(calls++);
    await expect(generateReport(ledger, range, await output())).rejects.toThrow(/changed/);
    ledger.read = async function* () { throw new Error("damaged"); };
    await expect(generateReport(ledger, range, await output())).rejects.toThrow();
  });
  it("neutralizes CSV formulas and writes valid PDF offsets across multiple pages", async () => {
    const rows = Array.from({ length: 12 }, (_, n) => { const r = record(n); r.call.agentId = '=HYPERLINK("evil")'; return r; });
    const files = await generateReport(store(rows), range, await output());
    const csv = await readFile(files.csvPath, "utf8"); expect(csv).toContain("'=HYPERLINK");
    const pdf = await readFile(files.pdfPath); const text = pdf.toString("ascii");
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]); expect(pdf.subarray(xref, xref + 4).toString()).toBe("xref");
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n /gm)].map(m => Number(m[1]));
    offsets.forEach((off, i) => expect(pdf.subarray(off, off + 20).toString()).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(text).toContain("rec-11"); expect(Number(/\/Count (\d+)/.exec(text)![1])).toBeGreaterThan(1);
  });
});

it("maps outcome and approval variants without treating handoffs as authorization", async () => {
  const rows = [record(1), record(2), record(3), handoff(4)];
  rows[0]!.approval = { callId: "call-1", decision: "approved", approver: "U123", reason: "reviewed change", decidedAt: range.from, channel: "slack" };
  rows[1]!.approval = { callId: "call-2", decision: "denied", approver: "U123", reason: "rejected change", decidedAt: range.from, channel: "slack" };
  rows[2]!.phase = "outcome"; rows[2]!.outcome = { status: "blocked" }; rows[2]!.policy.verdict = "deny";
  const files = await generateReport(store(rows), range, await output());
  const csv = await readFile(files.csvPath, "utf8"); const lines = csv.trim().split(/\r?\n/).slice(1);
  expect(lines).toHaveLength(rows.length);
  lines.forEach(line => expect(line).toContain("CC7.2"));
  for (const line of lines.slice(0, 3)) { expect(line).toContain("CC6.1"); expect(line).toContain("CC8.1"); }
  expect(lines[3]).not.toContain('"CC6.1;');
  expect(csv).toContain("U123"); expect(csv).toContain("approved"); expect(csv).toContain("denied");
});
it("rejects invalid calendar dates and honors offsets", async () => {
  for (const from of ["2026-02-30T12:00:00Z", "2026-09-30T24:00:00Z", "2026-09-30T12:00:60Z", "2026-09-30T12:00:00.0001Z", "2026-09-30T12:00:00"]) {
    await expect(generateReport(store([]), { from, to: range.to }, await output())).rejects.toThrow();
  }
  const dir = await output(); await generateReport(store([record(1)]), { from: "2026-09-30T08:00:00-04:00", to: "2026-09-30T08:00:02-04:00" }, dir);
  expect(await readFile(join(dir, "report.html"), "utf8")).toContain("1 records");
});
it("refuses to replace an existing export", async () => {
  const dir = await output(); const files = await generateReport(store([record(1)]), range, dir);
  const before = await readFile(files.csvPath);
  await expect(generateReport(store([record(2)]), range, dir)).rejects.toThrow();
  expect(await readFile(files.csvPath)).toEqual(before);
});
