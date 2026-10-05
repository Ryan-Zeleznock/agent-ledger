import { readFileSync } from "node:fs";
const requireFont = (name: string) => readFileSync(new URL(`../src/report/fonts/${name}`, import.meta.url));

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
async function pack(records: LedgerRecord[], context?: ReportContext, selectedRange = range) {
  const dir = await mkdtemp(join(tmpdir(), "pack-1c-")); dirs.push(dir);
  const ledger: LedgerStore = { append: vi.fn(), head: async () => records.at(-1)?.hash ?? "0", verify: async () => ({ ok: true, checked: records.length }),
    async *read(r) { for (const x of records) if (Date.parse(x.writtenAt) >= Date.parse(r.from) && Date.parse(x.writtenAt) <= Date.parse(r.to)) yield x; } };
  await generateReport(ledger, selectedRange, dir, context);
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
  expect(monitoring).toMatch(/missing-session<\/td><td>rec-3<\/td><td>2/);
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
  expect(p.pdf).toMatch(/\/F[13] 1[2-8] Tf/);
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
    expect(section(p.html, "cc7-2")).toContain(`<td>${id}</td>`);
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
  expect(section(p.html, "cc7-2")).toContain(`<td>${outcome.id}</td>`);
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

it("design: integrity precedes summary facts, with contents, labeled downloads and an offline print layout", async () => {
  const p = await pack([rec(1)]);
  const summary = section(p.html, "summary");
  expect(p.html.indexOf('class="integrity-block"')).toBeLessThan(p.html.indexOf('<dl class="facts">'));
  expect(summary).toContain('class="findings-status"');
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
it("design: PDF starts with dedicated cover and contents pages", async () => {
  const p = await pack([rec(1)]);
  const pages = [...p.pdf.matchAll(/stream\n([\s\S]*?)endstream/g)].map(m => pdfText(m[1]!));
  expect(p.pdf).toContain('/BaseFont /Helvetica');
  expect(pages[0]).toContain('SOC 2 evidence pack');
  for (const text of ['Period', 'Chain verification: PASS', 'Anchor:', 'Findings:', 'Scope:', 'best-effort gating']) expect(pages[0]).toContain(text);
  expect(pages[1]).toContain('Contents');
  for (const title of ['Executive summary', 'CC6.1 logical access', 'CC7.2 monitoring', 'CC8.1 change management', 'Record evidence', 'Vocabulary']) expect(pages[1]).toContain(title);
  expect(pages[2]).toContain('Executive summary');
});
it("design: contents page numbers resolve to real section headings and record details preserve false/zero", async () => {
  const r = rec(1, 'a-session-id-that-is-long-enough-to-shorten'); r.call.args = { enabled: false, count: 0 };
  const p = await pack([r]);
  expect(section(p.html, 'records')).toContain('&quot;enabled&quot;:false,&quot;count&quot;:0');
  expect(section(p.html, 'records')).toContain('<dt>agent_session_id</dt>');
  expect(p.pdfText).toContain('a-session-id-that-is-long-enough-to-shorten');
  expect(p.pdfText).toContain('"enabled":false,"count":0');
  const pages = [...p.pdf.matchAll(/stream\n([\s\S]*?)endstream/g)].map(m => pdfText(m[1]!));
  for (const title of ['Executive summary', 'CC6.1 logical access', 'CC7.2 monitoring', 'CC8.1 change management', 'Record evidence', 'Vocabulary']) {
    const contentsLines = pages[1]!.split('\n');
    const numberedTitle = contentsLines.find(line => line.endsWith(`. ${title}`))!;
    const number = Number(contentsLines[contentsLines.indexOf(numberedTitle) + 1]);
    expect(number).toBeGreaterThanOrEqual(3);
    expect(pages[number - 1]!.split('\n')).toContain(numberedTitle);
  }
});
it("design: multi-date tables retain row dates and original timestamp offsets", async () => {
  const r = rec(1); r.writtenAt = '2026-09-30T23:30:00-10:00';
  const p = await pack([rec(2), r], undefined, { from: range.from, to: '2026-10-01T13:00:00Z' });
  const records = section(p.html, 'records');
  expect(records).toContain('Dates (UTC): 2026-09-30, 2026-10-01');
  expect(records).toContain('datetime="2026-09-30T23:30:00-10:00"');
  expect(records).toContain('>2026-10-01 09:30:00.000Z</time>');
  expect(records).toContain('>2026-09-30 12:00:01.000Z</time>');
});
it.each(['{}', '[]', 'null'])("design: non-empty literal %s remains evidence in record details", async value => {
  const r = rec(1); r.call.declaredPlan = value;
  const p = await pack([r]);
  expect(section(p.html, 'records')).toContain(`<dt>declared_plan</dt><dd>${value}</dd>`);
  expect(p.pdfText).toContain(`declared_plan: ${value}`);
});
it("design: appended record-detail identifiers still label HMAC values", async () => {
  const r = rec(1, `hmac-sha256:${'d'.repeat(64)}`);
  const p = await pack([r]);
  for (const output of [p.html, p.pdfText, p.csv]) {
    expect(output).not.toContain('hmac-sha256:');
    expect(output).toContain('HMAC-SHA256 digest (argument withheld)');
    expect(output).toContain('d'.repeat(64));
  }
});

// Mirror the coordinator's e2e parsers; criterion cells are literal escaped text, not nested markup.
const seamUnesc = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);
const seamRows = (html: string): string[][] => {
  const tbody = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  return [...tbody.matchAll(/<tr>(.*?)<\/tr>/gs)].map(m => [...m[1]!.matchAll(/<td(?: colspan="\d+")?>(.*?)<\/td>/gs)].map(c => c[1]!)).filter(row => !(row.length === 1 && row[0] === "None"));
};
const seamUnder = (html: string, heading: string) => {
  const body = html.split(`<h3>${heading}</h3>`)[1]?.split("<h3>")[0];
  expect(body).toBeDefined(); return body!;
};
it("pin 8 coordinator regression: summary lines remain contiguous in definition facts", async () => {
  const r = rec(1, 'session-with-a-full-identifier');
  const p = await pack([r], { anchor: { status: 'ancestor', latest: { hash: r.hash, at: range.from } } });
  const summary = seamUnesc(section(p.html, 'summary'));
  const afterBand = summary.slice(summary.indexOf('<dl class="facts">'));
  for (const line of [
    '1 records', `Range (writtenAt, inclusive): ${range.from} to ${range.to}`,
    `Observed ledger head: ${r.hash}`, 'Chain verification: PASS; checked 1 records (whole ledger); brokenAt: none',
    `Anchor: ancestor anchored at ${range.from}: records after it are unprotected; local file anchor, editable by this machine's owner`,
    'Agent sessions seen: 1; heartbeats: 0', 'Tool intents by risk: read: 0; write: 0; risky: 1; unreviewed: 0',
    'Asks: 0; recorded approvals: 0', 'Recorded denials by cause: none', 'Outcomes ok: 0; error: 0; no outcome observed: 1',
  ]) expect(afterBand).toContain(`>${line}<`);
  expect(afterBand).toMatch(/>Generated: [^<]+</);
  expect(afterBand).toMatch(/>Local mode: visibility, tamper-evident logging and best-effort gating, not enforcement\.[^<]+</);
});
it("pin 8 coordinator regression: exact criterion columns and full cells agree with CSV and e2e parsers", async () => {
  const { parseCsv } = await import('./helpers/e2e-demo.js');
  const session = 'd247c305-c18e-4a4b-893c-049e87ed62c6';
  const h = heartbeat(1, session); h.call.args.nodeOptionsSet = true;
  const r = rec(2, session); r.writtenAt = '2026-09-30T08:00:02.123-04:00'; approve(r, 'delegated', 'hook-ask');
  const m = rec(3, 'missing-session-with-a-long-identifier'); m.writtenAt = '2026-09-30T12:00:03.000Z';
  const o = result(m, 'blocked', 'permission-denied:auto-mode'); o.writtenAt = '2026-09-30T12:00:04.000Z';
  const p = await pack([h, r, m, o]);
  const access = seamUnesc(section(p.html, 'cc6-1')), monitoring = seamUnesc(section(p.html, 'cc7-2')), change = seamUnesc(section(p.html, 'cc8-1'));
  const headers = (html: string) => [...html.split('</thead>')[0]!.matchAll(/<th scope="col">(.*?)<\/th>/g)].map(m => m[1]);
  expect(headers(access)).toEqual(['written_at', 'agent_session_id', 'agent_id', 'server/tool', 'risk', 'verdict', 'rule_id']);
  expect(headers(change)).toEqual(['written_at', 'agent_session_id', 'server/tool', 'risk', 'approval (decision, approver)', 'outcome (status, errorClass)', 'evidence_class']);
  expect(seamRows(access)).toEqual([r, m].map(x => [x.writtenAt, x.call.agentSessionId, x.call.agentId, `${x.call.server}/${x.call.tool}`, x.policy.risk, x.policy.verdict, x.policy.ruleId]));
  const heartbeatTable = seamUnder(monitoring, 'Heartbeats (1)');
  expect(headers(heartbeatTable)).toEqual(['written_at', 'agent_session_id', 'source', 'permission_mode', 'watchdog_check', 'node_options_set', 'interpreter']);
  expect(seamRows(heartbeatTable)).toEqual([[h.writtenAt, session, 'startup', 'default', 'ok', 'true', '/usr/local/bin/node']]);
  expect(seamRows(seamUnder(monitoring, 'Sessions without heartbeat (1)'))).toEqual([[m.call.agentSessionId, m.id, '1']]);
  expect(seamRows(seamUnder(monitoring, 'Launch-environment warnings (1)'))).toEqual([[h.id, session, 'nodeOptionsSet: true', 'informational']]);
  expect(seamRows(seamUnder(monitoring, 'Intents with no outcome observed (1)'))).toEqual([[r.id, r.call.callId]]);
  expect(seamRows(change)).toEqual([
    [r.writtenAt, session, `${r.call.server}/${r.call.tool}`, 'risky', 'delegated, reviewer', 'no outcome observed', 'asked, no outcome observed'],
    [m.writtenAt, m.call.agentSessionId, `${m.call.server}/${m.call.tool}`, 'risky', 'not recorded', JSON.stringify(o.outcome), 'denied: auto mode'],
  ]);
  const [header, ...csv] = parseCsv(p.csv); const col = (name: string) => header!.indexOf(name);
  for (const row of seamRows(change)) {
    const csvRow = csv.find(c => c[col('written_at')] === row[0] && c[col('phase')] === 'intent');
    expect(csvRow).toBeDefined();
    expect([csvRow![col('agent_session_id')], csvRow![col('evidence_class')]]).toEqual([row[1], row[6]]);
  }
});
it("pin 8 coordinator regression: PDF keeps section order, full criterion values and contiguous extracted anchor text", async () => {
  const { pdfText: extract } = await import('./helpers/e2e-demo.js');
  const r = rec(1, 'd247c305-c18e-4a4b-893c-049e87ed62c6'); r.writtenAt = '2026-09-30T08:00:02.123-04:00';
  const p = await pack([r], { anchor: { status: 'ancestor', latest: { hash: r.hash, at: range.from } } });
  const pdf = extract(Buffer.from(p.pdf, 'ascii'));
  const titles = ['Executive summary', 'CC6.1 logical access', 'CC7.2 monitoring', 'CC8.1 change management', 'Record evidence', 'Vocabulary'];
  let previous = -1;
  for (const title of titles) { expect(pdf.indexOf(title)).toBeGreaterThan(previous); previous = pdf.indexOf(title); }
  expect(pdf).toContain(`Anchor: ancestor anchored at ${range.from}: records after it are unprotected; local file anchor, editable by this machine's owner`);
  expect(pdf).toContain(denial);
  // Check the actual access section, past the cover and contents references.
  const body = p.pdfText.slice(p.pdfText.lastIndexOf('CC6.1 logical access\n')).split('CC7.2 monitoring\n')[0]!;
  expect(body).toContain(r.writtenAt);
  expect(body).toContain(r.call.agentSessionId);
});
it("pin 8 coordinator regression: Slice 2a CC8.1 server/tool, risk and evidence-class positions remain fixed", async () => {
  const write = rec(1); write.call.server = 'demo'; write.call.tool = 'add'; write.policy.risk = 'write';
  const risky = rec(2); risky.call.server = 'demo'; risky.call.tool = 'wipe'; approve(risky, 'no-channel', 'hook-ask'); delete risky.approval!.approver;
  const unreviewed = rec(3); unreviewed.call.server = 'demo'; unreviewed.call.tool = 'whoami'; unreviewed.policy.risk = 'unreviewed'; approve(unreviewed, 'no-channel', 'hook-ask'); delete unreviewed.approval!.approver;
  const p = await pack([write, result(write, 'ok'), risky, unreviewed]);
  const rows = seamRows(seamUnesc(section(p.html, 'cc8-1')));
  expect(rows.map(r => [r[2], r[3], r[6]])).toEqual([
    ['demo/add', 'write', 'executed (allowed)'], ['demo/wipe', 'risky', 'denied: no channel'], ['demo/whoami', 'unreviewed', 'denied: no channel'],
  ]);
  expect(rows[1]![4]).toBe('no-channel, not recorded');
  expect(rows.every(r => r.length === 7)).toBe(true);
});

it('filed instrument: embeds all four vendored fonts and the three OFL notices offline', async () => {
  const p = await pack([]);
  const fonts = [...p.html.matchAll(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g)].map(m => Buffer.from(m[1]!, 'base64'));
  const names = ['SourceSerif4-variable-latin.woff2', 'IBMPlexSansCondensed-400-latin.woff2', 'IBMPlexSansCondensed-600-latin.woff2', 'JetBrainsMono-400-latin.woff2'];
  expect(fonts).toHaveLength(names.length);
  for (const name of names) expect(fonts.some(f => f.equals(requireFont(name)))).toBe(true);
  for (const name of ['Source Serif 4', 'IBM Plex Sans Condensed', 'JetBrains Mono', 'SIL Open Font License 1.1']) expect(section(p.html, 'legend')).toContain(name);
  expect(Buffer.byteLength(p.html)).toBeLessThan(200_000);
  expect(p.html).not.toMatch(/(?:src|href)=["']https?:|url\(["']?https?:|@import/);
});

it('filed instrument: cover registration, full head, numbered sections and ruled tables', async () => {
  const p = await pack([rec(1)]);
  expect(p.html).toContain('<header class="cover" aria-label="Exhibit cover"><div><h1>');
  expect(p.html).toContain('aria-label="Registration"');
  expect(p.html).toContain('class="verification-seal"');
  expect(p.html).toContain('class="integrity-block"');
  expect(p.html).toContain('1. Executive summary');
  expect(p.html).toContain('6. Vocabulary');
  expect(section(p.html, 'records')).toContain('Table 5.1');
  expect(p.html).toContain('border-bottom:1.5px solid var(--ink)');
  expect(p.html).not.toMatch(/border-left:|status-band|repeat\(3,/);
  for (const font of ['Times-Roman', 'Times-Bold', 'Helvetica', 'Courier']) expect(p.pdf).toContain(`/BaseFont /${font}`);
  const cover = [...p.pdf.matchAll(/stream\n([\s\S]*?)endstream/g)][0]![1]!;
  expect(pdfText(cover)).toContain(rec(1).hash);
  expect(cover).toMatch(/1 0 0 1 5\d\d\.00 /); // registration at right
});

it('filed instrument: chain margin interlocks and never replaces pinned columns', async () => {
  const a = rec(1), b = rec(2); b.prevHash = a.hash;
  const p = await pack([a, b]);
  const index = section(p.html, 'records');
  expect(index).toContain('>Chain</th>');
  for (const [i, r] of [a, b].entries()) {
    expect(index).toContain(`R-${String(i + 1).padStart(4, '0')}`);
    expect(index).toContain(`prev ${r.prevHash.slice(0, 12)}`);
    expect(index).toContain(`hash ${r.hash.slice(0, 12)}`);
  }
  expect(section(p.html, 'cc6-1')).not.toContain('>Chain</th>');
});

it('filed instrument: only approved named humans receive a stamp; exceptions retain words', async () => {
  const named = rec(1), unnamed = rec(2), delegated = rec(3), timeout = rec(4), blank = rec(5);
  approve(named, 'approved'); named.approval!.approver = '<Human & reviewer>';
  approve(unnamed, 'approved'); delete unnamed.approval!.approver;
  approve(delegated, 'delegated', 'hook-ask'); approve(timeout, 'timeout');
  approve(blank, 'approved'); blank.approval!.approver = '  ';
  const p = await pack([named, unnamed, delegated, timeout, blank]);
  const change = section(p.html, 'cc8-1');
  expect(p.html.match(/\/\* human-approval-mark \*\//g)).toHaveLength(1);
  expect(p.html).toContain('.table-4-1 tbody tr:nth-child(1) td:nth-child(5){color:var(--human-approval)');
  expect(change).toContain('approved, &lt;Human &amp; reviewer&gt;');
  expect(p.html).toContain('.table-4-1 tbody tr:nth-child(4) td{background:var(--exception-tint)}');
  expect(change).toContain('<td>timeout, reviewer</td>');
  expect(change).toContain('denied: Slack timeout');
  expect(p.pdf).toContain('0.4784 0.1216 0.1686 rg');
  const anonymous = await pack([unnamed, delegated, timeout, blank]);
  expect(anonymous.html).not.toContain('/* human-approval-mark */');
  expect(anonymous.pdf).not.toContain('0.4784 0.1216 0.1686 rg');
});
