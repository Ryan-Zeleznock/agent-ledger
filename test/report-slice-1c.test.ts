import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReport, type ReportContext } from "../src/report/contract.js";
import type { LedgerStore } from "../src/ledger/contract.js";
import type { LedgerRecord, ApprovalResult } from "../src/types/index.js";
import { sealedWithoutHash } from "./helpers/ledger-fixtures.js";

// Pin 7 fixtures, intentionally independent of Package A's types and implementation.
const range = { from: "2026-09-30T12:00:00Z", to: "2026-09-30T13:00:00Z" };
const denial = "A manual denial at the Claude Code permission prompt fires no hook event (Claude Code hooks reference, read 2026-10-01), so 'asked, no outcome observed' cannot distinguish a user's denial from a cancelled call, an interrupted session or lost telemetry. Only auto-mode denials are recorded (`permission-denied:auto-mode`).";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
function rec(n: number, session?: string): LedgerRecord {
  const r = { ...sealedWithoutHash(n), hash: String(n).padStart(64, "0") };
  if (session !== undefined) Object.assign(r.call, { agentSessionId: session });
  r.policy.risk = "risky"; r.call.tool = "Bash";
  return r;
}
function heartbeat(n: number, session: string): LedgerRecord {
  const r = rec(n, session);
  r.policy = { verdict: "allow", risk: "read", ruleId: "heartbeat:session-start", reason: "health record" };
  r.call.tool = "SessionStart";
  r.call.args = { agentSessionId: session, hookAgent: "claude-code", source: "startup", permissionMode: "default", interpreter: "/usr/local/bin/node", nodeOptionsSet: false, watchdogCheck: "ok" };
  return r;
}
function result(r: LedgerRecord, status: "ok" | "error" | "blocked", errorClass?: string): LedgerRecord {
  return { ...r, id: `${r.id}-outcome`, phase: "outcome", outcome: { status, ...(errorClass ? { errorClass } : {}) } };
}
function approve(r: LedgerRecord, decision: ApprovalResult["decision"], channel: ApprovalResult["channel"] = "slack") {
  r.policy.verdict = "require_approval";
  r.approval = { callId: r.call.callId, decision, channel, decidedAt: range.from, approver: "reviewer" };
}
function pdfText(raw: string): string {
  return [...raw.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(m => m[1]!.replace(/\\267/g, "·").replace(/\\([\\()])/g, "$1").replace(/\\u([0-9a-f]{4})/g, (_, n: string) => String.fromCharCode(parseInt(n, 16)))).join("\n");
}
async function pack(records: LedgerRecord[], context?: ReportContext) {
  const dir = await mkdtemp(join(tmpdir(), "pack-1c-")); dirs.push(dir);
  const ledger: LedgerStore = { append: vi.fn(), head: async () => records.at(-1)?.hash ?? "0", verify: async () => ({ ok: true, checked: records.length }),
    async *read(r) { for (const x of records) if (Date.parse(x.writtenAt) >= Date.parse(r.from) && Date.parse(x.writtenAt) <= Date.parse(r.to)) yield x; } };
  await generateReport(ledger, range, dir, context);
  const html = await readFile(join(dir, "report.html"), "utf8");
  const pdf = await readFile(join(dir, "report.pdf"), "ascii");
  return { html, pdf, pdfText: pdfText(pdf), csv: await readFile(join(dir, "records.csv"), "utf8") };
}
const section = (html: string, id: string) => html.split(`<section id="${id}">`)[1]?.split("</section>")[0] ?? "";

it("orders all six sections and repeats the literal denial caveat in HTML and PDF", async () => {
  const p = await pack([]);
  const ids = ["summary", "cc6-1", "cc7-2", "cc8-1", "records", "legend"];
  const titles = ["Executive summary", "CC6.1 logical access", "CC7.2 monitoring", "CC8.1 change management", "Record evidence", "Vocabulary"];
  let h = -1, t = -1;
  ids.forEach((id, i) => { const next = p.html.indexOf(`<section id="${id}">`); expect(next).toBeGreaterThan(h); h = next; const title = p.pdfText.indexOf(titles[i]!); expect(title).toBeGreaterThan(t); t = title; });
  expect(p.html.replaceAll("&#39;", "'")).toContain(denial);
  expect(p.pdfText.replace(/\n/g, "")).toContain(denial);
  expect(section(p.html, "summary")).toContain("No findings");
});
it.each(["head", "ancestor", "missing", "mismatch", "untrusted", "absent"] as const)("renders anchor status %s honestly", async status => {
  const p = await pack([], status === "absent" ? undefined : { anchor: { status, latest: status === "missing" ? null : { hash: "a".repeat(64), at: range.from } } });
  const expected = { head: `Anchor: head anchored at ${range.from}`, ancestor: `Anchor: ancestor anchored at ${range.from}: records after it are unprotected`, missing: "Anchor: no anchor", mismatch: "Anchor: MISMATCH", untrusted: "Anchor: untrusted", absent: "Anchor: not supplied to this report" }[status];
  expect(section(p.html, "summary")).toContain(expected);
  expect(p.pdfText.replace(/\n/g, "")).toContain(expected);
  expect(p.html).toContain("local file anchor, editable by this machine&#39;s owner");
});
it("finds exactly the session without a heartbeat, never a pre-1c record; heartbeat is CC7.2 only", async () => {
  const p = await pack([heartbeat(1, "healthy"), rec(2, "healthy"), rec(3, "missing-session"), rec(4, "missing-session"), rec(5)]);
  const monitoring = section(p.html, "cc7-2");
  expect(monitoring).toContain("Sessions without heartbeat (1)");
  expect(monitoring).toMatch(/title="missing-session">missing-session<\/code><\/td><td><code title="rec-3">rec-3<\/code><\/td><td class="number">2/);
  expect(p.html).toContain("pre-1c, no agent session id");
  expect(section(p.html, "cc6-1")).not.toContain("SessionStart");
  expect(section(p.html, "cc8-1")).not.toContain("SessionStart");
  expect(p.html).toContain("Intents with no outcome observed (4)");
  const lines = p.csv.trim().split("\r\n");
  expect(lines[0]).toMatch(/,"agent_session_id","evidence_class","anchor_status"$/);
  expect(lines[1]).toContain('"CC7.2"'); expect(lines[1]).not.toContain("no outcome observed");
  expect(lines[3]).toContain("session without heartbeat"); expect(lines[4]).not.toContain("session without heartbeat");
  expect(section(p.html, "summary")).toContain("Agent sessions seen: 2; heartbeats: 1");
});
it.each(["2026-09-29T12:00:00Z", "2026-10-01T12:00:00Z"])("uses heartbeats anywhere in history (%s)", async at => {
  const h = heartbeat(1, "covered"); h.writtenAt = at;
  const p = await pack([h, rec(2, "covered")]);
  expect(section(p.html, "cc7-2")).toContain("Sessions without heartbeat (0)");
});
it("labels orphan intent gaps and reports each launch warning", async () => {
  const h = heartbeat(1, "known"); Object.assign(h.call.args, { watchdogCheck: "failed", nodeOptionsSet: true, permissionMode: "bypassPermissions" });
  const p = await pack([h, result(rec(2, "known"), "ok"), result(rec(3, "unknown"), "error")]);
  const s = section(p.html, "cc7-2");
  for (const text of ["intent gap", "watchdogCheck: failed", "nodeOptionsSet: true", "permissionMode: bypassPermissions", "A bypass-mode session produces no asks"]) expect(s).toContain(text);
});
it.each([
  ["executed after ask", "delegated", "ok"], ["executed (allowed)", null, "ok"], ["execution error", null, "error"],
  ["denied by policy", null, "policy"], ["denied: no channel", "no-channel", "blocked"],
  ...(["approved", "denied", "timeout", "unavailable"] as const).map(d => [`denied: Slack ${d}`, d, "blocked"] as const),
  ["denied: auto mode", "delegated", "auto"], ["asked, no outcome observed", "delegated", null], ["allowed, no outcome observed", null, null],
] as const)("classifies %s from pinned record facts", async (label, decision, outcome) => {
  const r = rec(1, "s");
  if (decision) approve(r, decision as ApprovalResult["decision"], decision === "delegated" || decision === "no-channel" ? "hook-ask" : "slack");
  if (outcome === "policy") r.policy.verdict = "deny";
  const records = [r];
  if (outcome && outcome !== "policy") records.push(result(r, outcome === "auto" ? "blocked" : outcome as "ok" | "error" | "blocked", outcome === "auto" ? "permission-denied:auto-mode" : undefined));
  const p = await pack(records);
  expect(section(p.html, "cc8-1")).toContain(`>${label}</td>`);
  expect(p.csv).toContain(`,"${label}",`);
});
it("escapes new table cells and appended CSV columns, labels digests and preserves PDF strings", async () => {
  const s = '=x<script>(evil)\\é'; const r = rec(1, s);
  r.call.tool = `hmac-sha256:${"a".repeat(64)}`;
  const p = await pack([r]);
  expect(section(p.html, "cc6-1")).toContain("&lt;script&gt;"); expect(p.html).not.toContain("<script>");
  expect(p.csv).toContain(`,"'${s}",`); expect(p.pdfText).toContain(s);
  for (const text of [p.html, p.csv, p.pdfText]) { expect(text).not.toContain("hmac-sha256:"); expect(text).toContain("argument withheld"); }
});
it("paginates aligned tables with repeated headers, larger titles, footers and unsplit fitting record blocks", async () => {
  const p = await pack(Array.from({ length: 45 }, (_, i) => rec(i, `session-${i}`)));
  const pages = [...p.pdf.matchAll(/stream\n([\s\S]*?)endstream/g)].map(m => pdfText(m[1]!));
  expect(p.pdf).toMatch(/\/F1 1[2-8] Tf/);
  expect(p.pdf).toContain("Agent Ledger evidence pack \\267 page");
  pages.forEach((page, i) => expect(page).toContain(`Agent Ledger evidence pack · page ${i + 1} / ${pages.length} · chain PASS`));
  expect(pages.filter(page => page.includes("rule_id")).length).toBeGreaterThan(1);
  for (const page of pages) expect((page.match(/^record_id: rec-/gm) ?? []).length).toBe((page.match(/^received_at:/gm) ?? []).length);
  expect(pages.flatMap(page => [...page.matchAll(/^record_id: (rec-\d+)$/gm)].map(m => m[1]))).toEqual(Array.from({ length: 45 }, (_, i) => `rec-${i}`));
});

it.each(["policy", "denied", "timeout", "unavailable", "no-channel"] as const)("review #1: execution after %s remains a denied execution and a finding", async cause => {
  const r = rec(200);
  if (cause === "policy") r.policy.verdict = "deny";
  else approve(r, cause, cause === "no-channel" ? "hook-ask" : "slack");
  const outcome = result(r, "ok");
  const p = await pack([r, outcome]);
  expect(section(p.html, "cc8-1")).toContain(">executed despite deny</td>");
  for (const id of [r.id, outcome.id]) {
    expect(section(p.html, "summary")).toContain(`executed despite deny: ${id};`);
    expect(section(p.html, "cc7-2")).toContain(`<code title="${id}">${id}</code>`);
  }
  expect(section(p.html, "cc7-2")).toContain("executed despite deny");
  expect(p.csv.split("\r\n")[1]).toContain('"executed despite deny"');
  expect(p.pdfText.replaceAll("\n", "")).toContain("executed despite deny");
  const causeLabel = cause === "policy" ? "denied by policy" : cause === "no-channel" ? "denied: no channel" : `denied: Slack ${cause}`;
  expect(section(p.html, "summary")).toContain(`${causeLabel}: 1`);
});
it("review #1: prior-range deny still flags every in-range execution outcome", async () => {
  const r = rec(201); r.policy.verdict = "deny"; r.writtenAt = "2026-09-29T12:00:00Z";
  const outcome = { ...result(r, "ok"), writtenAt: range.from };
  const p = await pack([r, outcome]);
  expect(section(p.html, "summary")).toContain(`executed despite deny: ${outcome.id};`);
  expect(section(p.html, "cc7-2")).toContain(`<code title="${outcome.id}">${outcome.id}</code>`);
});
it.each([false, true])("review #2: handoff outcome uses its preceding intent (proxy present: %s)", async withProxy => {
  const h = rec(202); h.handoff = { kind: "to-proxy", proxyServerName: "agentledger_proxy_1234" };
  h.call.server = h.handoff.proxyServerName; h.policy.ruleId = `handoff-to-proxy:${h.call.server}`;
  const proxy = rec(203); proxy.call.callId = h.call.callId; proxy.call.server = "github";
  const p = await pack([h, ...(withProxy ? [proxy] : []), result(h, "ok")]);
  expect(section(p.html, "cc7-2")).toContain("Orphan outcomes (0)");
  expect(section(p.html, "cc7-2")).toContain(`Unreconciled handoffs (${withProxy ? 0 : 1})`);
  expect(section(p.html, "summary")).not.toContain("orphan outcome:");
  if (withProxy) expect(section(p.html, "cc8-1")).toContain("executed (allowed)");
  else {
    expect((section(p.html, "summary").match(/<li>/g) ?? []).length).toBe(1);
    expect(p.csv.split("\r\n")[2]).not.toContain("executed");
  }
});
it("review #4: a blank class for an unexplained blocked outcome is explained in the legend", async () => {
  const r = rec(204); const p = await pack([r, result(r, "blocked", "unknown-cause")]);
  expect(p.csv.split("\r\n")[1]).toMatch(/,"","not supplied"$/);
  expect(section(p.html, "legend")).toContain("blocked outcome whose cause is not recorded");
});
it.each(["tool", "server", "rule"] as const)("review #7: heartbeat %s mismatch stays visible as tool evidence and a finding", async field => {
  const h = heartbeat(205, "not-covered");
  if (field === "tool") h.call.tool = "Bash";
  if (field === "server") h.call.server = "github";
  if (field === "rule") h.policy.ruleId = "other-rule";
  h.policy.risk = "risky";
  const p = await pack([h, rec(206, "not-covered")]);
  expect(section(p.html, "cc7-2")).toContain("Heartbeats (0)");
  expect(section(p.html, "cc7-2")).toContain("Sessions without heartbeat (1)");
  expect(section(p.html, "cc6-1")).toContain(h.call.tool);
  expect(section(p.html, "cc8-1")).toContain(h.call.tool);
  expect(section(p.html, "summary")).toContain(`heartbeat discriminator mismatch: ${h.id};`);
  expect(section(p.html, "cc7-2")).toContain("heartbeat discriminator mismatch");
  expect(p.csv.split("\r\n")[1]).toContain("heartbeat discriminator mismatch");
});

it("design: status comes before definition facts, with contents, labeled downloads and an offline print layout", async () => {
  const p = await pack([rec(1)]);
  const summary = section(p.html, "summary");
  expect(summary).toContain('class="status-band"');
  expect(summary.indexOf('class="status-band"')).toBeLessThan(summary.indexOf('<dl class="facts">'));
  expect(summary).toContain('class="trust-boundary"');
  expect(summary).toContain(`title="${rec(1).hash}"`);
  expect(p.html).toContain('aria-label="Contents"');
  for (const id of ["summary", "cc6-1", "cc7-2", "cc8-1", "records", "legend"]) expect(p.html).toContain(`href="#${id}"`);
  expect(p.html).toContain('href="report.pdf" download>Download PDF');
  expect(p.html).toContain('href="records.csv" download>Download CSV');
  expect(p.html).toContain("font-variant-numeric:tabular-nums");
  expect(p.html).toContain("@media print");
  expect(p.html).not.toMatch(/<(script|link)\b/);
});
it("design: compact record table and non-empty details retain full evidence and escape attribute values", async () => {
  const r = rec(1); r.call.args = {}; r.call.declaredPlan = ''; r.call.onBehalfOf = '\"><script>hostile</script>';
  const p = await pack([r]); const s = section(p.html, "records");
  expect(s.match(/<table>/g)).toHaveLength(1);
  for (const title of ["Time", "Phase", "Tool", "Decision", "Evidence class", "Criteria"]) expect(s).toContain(`>${title}</th>`);
  expect(s.match(/<details\b/g)).toHaveLength(1);
  const details = s.split('<details')[1]!;
  for (const absent of ["approval", "outcome", "handoff", "parent_record_id", "declared_plan", "arguments_labeled"]) expect(details).not.toContain(`<dt>${absent}</dt>`);
  for (const present of ["record_id", "hash", "received_at", "on_behalf_of"]) expect(details).toContain(`<dt>${present}</dt>`);
  expect(details).toContain(r.hash);
  expect(s).toContain('&quot;&gt;&lt;script&gt;hostile&lt;/script&gt;');
  expect(s).not.toContain('<script>');
  expect(s).toMatch(/<caption>[^<]*2026-09-30/);
  expect(s).toContain('class="time"');
});
it("design: monitoring check list reports zero checks without empty detail tables", async () => {
  const p = await pack([]); const s = section(p.html, "cc7-2");
  expect(s).toContain('class="anomaly-checks"');
  expect(s).toContain("Sessions without heartbeat (0)");
  expect(s).toContain("OK");
  expect(s).not.toContain('<table>');
  const flagged = section((await pack([rec(1, "missing")])).html, "cc7-2");
  expect(flagged).toContain("FLAG");
  expect(flagged).toContain('<table>');
});
it("design: CSV bytes remain frozen across presentation changes", async () => {
  const { createHash } = await import('node:crypto');
  const r = rec(2, '=hostile<script>'); approve(r, 'delegated', 'hook-ask');
  r.call.args = { digest: `hmac-sha256:${'a'.repeat(64)}`, clear: '"x",é\n=SUM(A1)' };
  const p = await pack([heartbeat(1, 'healthy'), r, result(r, 'ok')], { anchor: { status: 'head', latest: { hash: r.hash, at: range.from } } });
  expect(createHash('sha256').update(p.csv).digest('hex')).toBe('14a75575c75df78c86ff72a6945ee767381172dfc008d344bbd97300ad47c206');
});
