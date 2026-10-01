import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { DateRange, LedgerRecord } from "../types/index.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { ReportFiles, UnreconciledHandoff } from "./contract.js";
import { textPdf } from "./pdf.js";

export const HANDOFF_RECONCILE_GRACE_MS = 60_000;
export const HISTORY_START = "0100-01-01T00:00:00.000Z";
export function checkedRange(range: DateRange, graceMs = 0): { from: number; to: number; extended: string } {
  const instant = (s: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([Zz]|[+-]\d{2}:\d{2})$/.exec(s);
    if (!m) throw new Error("Expected RFC 3339 timestamps with explicit offsets (up to milliseconds)");
    const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
    const date = new Date(Date.UTC(y!, mo! - 1, d!));
    const off = m[8]!;
    if (y! < 100 || date.getUTCFullYear() !== y || date.getUTCMonth() !== mo! - 1 || date.getUTCDate() !== d || h! > 23 || mi! > 59 || sec! > 59 ||
      (off.toLowerCase() !== "z" && (Number(off.slice(1, 3)) > 23 || Number(off.slice(4)) > 59))) throw new Error("Invalid timestamp");
    const n = Date.parse(s); if (!Number.isFinite(n)) throw new Error("Invalid timestamp"); return n;
  };
  const from = instant(range.from), to = instant(range.to);
  if (from > to || !Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error("Invalid range or grace");
  const extended = new Date(to + graceMs).toISOString();
  instant(extended);
  return { from, to, extended };
}

export function findHandoffs(records: LedgerRecord[], range: DateRange): UnreconciledHandoff[] {
  const { from, to } = checkedRange(range);
  return records.filter(r => r.phase === "intent" && r.handoff && Date.parse(r.writtenAt) >= from && Date.parse(r.writtenAt) <= to)
    .filter(h => !records.some(r => r.phase === "intent" && !r.handoff && r.call.callId === h.call.callId &&
      !r.call.server.startsWith("builtin:") && r.call.server !== h.handoff!.proxyServerName &&
      !r.policy.ruleId.startsWith("handoff-to-proxy:") && !r.policy.ruleId.startsWith("codex-mcp-not-proxied:")))
    .map(h => ({ callId: h.call.callId, proxyServerName: h.handoff!.proxyServerName, hookRecordId: h.id, handedOffAt: h.writtenAt }));
}

const trust = "Local mode: visibility, tamper-evident logging and best-effort gating, not enforcement. Records cover governed paths only. A machine owner can bypass hooks or rewrite local files. Server mode is the enforcement boundary only when upstream credentials are isolated from the agent. These records have no deployment-mode attestation; this pack makes no server-enforcement claim.";
const vocabulary = [
  "Evidence mapping [H]: candidate support for SOC 2 criteria, not an audit opinion or proof that a criterion is satisfied.",
  "CC6.1 logical access: recorded agent identity and reviewed allowlist/policy verdicts.",
  "CC7.2 monitoring: chain links, full-ledger verification and anomalies for investigation.",
  "CC8.1 change management: writes and risky/unknown actions, approval requests, approvals and denials. A shell call is not necessarily a production change.",
  "delegated = asked in the terminal; not a recorded human approval. An intent with no outcome means execution was not observed; denial, cancellation or lost telemetry cannot be distinguished.",
  "Codex hook outcome ok means the tool ran and returned; it does not prove success.",
  "HMAC-SHA256 digest = argument withheld, not the clear argument. Keyed comparison requires the separately held per-ledger key; the pack never includes that key.",
  `Handoff matching uses callId and a non-handoff MCP intent; collector provenance is absent from the schema, so this is correlation, not proof of proxy identity. Grace: ${HANDOFF_RECONCILE_GRACE_MS} ms after range end.`,
  "Orphan outcomes have no preceding intent for their callId in available ledger history. A standalone blocked outcome can be a legitimate denial; investigate rather than infer execution.",
  "No outcome findings are relative to the range end plus grace. Missing records and activity outside governed paths cannot be ruled out by a valid chain. No external anchor was supplied to this report API; use CLI verify for the local anchor status.",
];
const display = (s: string): string => s.replace(/hmac-sha256:([a-fA-F0-9]{64})/g, "HMAC-SHA256 digest (argument withheld): $1");
const json = (value: unknown) => display(JSON.stringify(value) ?? "");
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const csvCell = (s: string) => `"${(/^[\s]*[=+@-]|^[\t\r\n]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;

export async function renderReport(ledger: LedgerStore, range: DateRange, outDir: string): Promise<ReportFiles> {
  const { from, to, extended } = checkedRange(range, HANDOFF_RECONCILE_GRACE_MS);
  const head = await ledger.head();
  const verify = await ledger.verify();
  const history: LedgerRecord[] = [];
  for await (const r of ledger.read({ from: HISTORY_START, to: extended })) history.push(r);
  if (await ledger.head() !== head) throw new Error("Ledger changed during report; retry with writers paused");
  const records = history.filter(r => Date.parse(r.writtenAt) >= from && Date.parse(r.writtenAt) <= to);
  const handoffs = findHandoffs(history.filter(r => Date.parse(r.writtenAt) >= from), range);
  const intentIds = new Set<string>(); const orphanIds = new Set<string>();
  for (const r of history) {
    if (r.phase === "intent") intentIds.add(r.call.callId);
    else if (!intentIds.has(r.call.callId)) orphanIds.add(r.id);
  }
  const orphans = records.filter(r => orphanIds.has(r.id));
  const outcomes = new Set(history.filter(r => r.phase === "outcome").map(r => r.call.callId));
  const unobserved = records.filter(r => r.phase === "intent" && !r.handoff && !outcomes.has(r.call.callId));
  const columns = ["record_id", "phase", "written_at", "call_id", "agent_id", "session_id", "server", "tool", "arguments_labeled", "policy", "approval", "outcome", "handoff", "parent_record_id", "prev_hash", "hash", "criteria", "anomalies", "on_behalf_of", "declared_plan", "received_at", "chain_verify", "chain_checked", "chain_broken_at", "trust_boundary"];
  const rows = records.map(r => {
    const criteria = r.handoff ? ["CC7.2"] : ["CC6.1", "CC7.2", ...((r.policy.risk !== "read" || r.approval || r.policy.verdict !== "allow") ? ["CC8.1"] : [])];
    const anomalies = [handoffs.some(h => h.hookRecordId === r.id) ? "unreconciled handoff" : "", orphanIds.has(r.id) ? "orphan outcome" : "", unobserved.includes(r) ? "no outcome observed" : ""].filter(Boolean);
    return [r.id, r.phase, r.writtenAt, r.call.callId, r.call.agentId, r.call.sessionId, r.call.server, r.call.tool,
      json(r.call.args), json(r.policy), json(r.approval), json(r.outcome), json(r.handoff), r.parentRecordId ?? "", r.prevHash, r.hash,
      criteria.join("; "), anomalies.join("; "), r.call.onBehalfOf ?? "", r.call.declaredPlan ?? "", r.call.receivedAt,
      verify.ok ? "PASS" : "FAIL", String(verify.checked), verify.brokenAt ?? "", trust].map(display);
  });
  const summary = ["Agent Ledger | SOC 2 evidence pack", `${records.length} records`, `Range (writtenAt, inclusive): ${range.from} to ${range.to}`,
    `Generated: ${new Date().toISOString()}`, trust,
    `Chain verification: ${verify.ok ? "PASS" : "FAIL"}; checked ${verify.checked} records (whole ledger); brokenAt: ${verify.brokenAt ?? "none"}`, `Observed ledger head: ${head}`, ...vocabulary];
  const sections: [string, string[]][] = [
    [`Unreconciled handoffs (${handoffs.length})`, handoffs.map(h => json(h))],
    [`Orphan outcomes (${orphans.length})`, orphans.map(r => `${r.id}: ${r.call.callId}`)],
    [`Intents with no outcome observed (${unobserved.length})`, unobserved.map(r => `${r.id}: ${r.call.callId}`)],
  ];
  const details = rows.map(row => columns.slice(0, 21).map((c, i) => `${c}: ${row[i]}`));
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Ledger evidence pack</title>
<style>body{font:16px/1.5 system-ui,sans-serif;color:#172b40;background:#f6f8fb;max-width:1100px;margin:40px auto;padding:0 24px}h1,h2{color:#123b59}article,section{background:white;border:1px solid #dce4eb;border-radius:8px;padding:20px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 monospace}a{color:#095d92}@media print{body{margin:0;background:white}article{break-inside:avoid}}</style>
<h1>${esc(summary[0]!)}</h1><p><a href="report.pdf">PDF</a> · <a href="records.csv">CSV</a></p>${summary.slice(1).map(s => `<p>${esc(display(s))}</p>`).join("\n")}
${sections.map(([title, values]) => `<section><h2>${esc(title)}</h2><pre>${esc((values.length ? values : ["None"]).join("\n"))}</pre></section>`).join("\n")}
<h2>Record evidence</h2>${details.map((lines, i) => `<article><h3>${esc(records[i]!.id)}</h3><pre>${esc(lines.join("\n"))}</pre></article>`).join("\n")}</html>\n`;
  const pdf = textPdf([...summary, ...sections.flatMap(([title, values]) => ["", title, ...(values.length ? values : ["None"])]), "", "Record evidence", ...details.flatMap(lines => [...lines, ""])]);
  const csv = [columns, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const dir = resolve(outDir); await mkdir(dir, { recursive: true, mode: 0o700 });
  // Never follow/overwrite an existing output file, including a symlink.
  for (const [name, content] of [["records.csv", csv], ["report.pdf", pdf], ["report.html", html]] as const) {
    await writeFile(join(dir, name), content, { flag: "wx", mode: 0o600 });
  }
  return { pdfPath: join(dir, "report.pdf"), csvPath: join(dir, "records.csv") };
}
