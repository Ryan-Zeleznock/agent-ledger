import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { DateRange, LedgerRecord } from "../types/index.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { ReportFiles, ReportContext, UnreconciledHandoff } from "./contract.js";
import { textPdf, type PdfBlock } from "./pdf.js";

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
  "An empty evidence_class identifies a heartbeat/handoff, an orphan without a classifiable cause, or a blocked outcome whose cause is not recorded; consult the raw outcome. It does not mean allowed or successful execution.",
  "Codex hook outcome ok means the tool ran and returned; it does not prove success.",
  "HMAC-SHA256 digest = argument withheld, not the clear argument. Keyed comparison requires the separately held per-ledger key; the pack never includes that key.",
  `Handoff matching uses callId and a non-handoff MCP intent; collector provenance is absent from the schema, so this is correlation, not proof of proxy identity. Grace: ${HANDOFF_RECONCILE_GRACE_MS} ms after range end.`,
  "Orphan outcomes have no preceding intent for their callId in available ledger history. A standalone blocked outcome can be a legitimate denial; investigate rather than infer execution.",
  "No outcome findings are relative to the range end plus grace. Missing records and activity outside governed paths cannot be ruled out by a valid chain. Anchor status is supplied by the caller; a local file anchor is editable by the machine owner.",
];
const display = (s: string): string => s.replace(/hmac-sha256:([a-fA-F0-9]{64})/g, "HMAC-SHA256 digest (argument withheld): $1");
const json = (value: unknown) => display(JSON.stringify(value) ?? "");
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const csvCell = (s: string) => `"${(/^[\s]*[=+@-]|^[\t\r\n]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;

// Pin 7 literals keep B buildable against the frozen base; no dependency on A's implementation.
const hasHeartbeatRule = (r: LedgerRecord) => r.policy.ruleId === "heartbeat:session-start";
const hasHeartbeatCall = (r: LedgerRecord) => r.call.tool === "SessionStart" && r.call.server.startsWith("builtin:");
const isHeartbeat = (r: LedgerRecord) => hasHeartbeatRule(r) && hasHeartbeatCall(r);
const isToolIntent = (r: LedgerRecord) => r.phase === "intent" && !r.handoff && !isHeartbeat(r);
const agentSession = (r: LedgerRecord): string | undefined =>
  "agentSessionId" in r.call && typeof r.call.agentSessionId === "string" ? r.call.agentSessionId : undefined;
const sessionLabel = (r: LedgerRecord) => agentSession(r) ?? "pre-1c, no agent session id";
const denial = "A manual denial at the Claude Code permission prompt fires no hook event (Claude Code hooks reference, read 2026-10-01), so 'asked, no outcome observed' cannot distinguish a user's denial from a cancelled call, an interrupted session or lost telemetry. Only auto-mode denials are recorded (`permission-denied:auto-mode`).";

function anchorLine(context?: ReportContext): string {
  const a = context?.anchor;
  const status = !a ? "not supplied to this report" : a.status === "head" ? `head anchored at ${a.latest?.at ?? "unknown"}` :
    a.status === "ancestor" ? `ancestor anchored at ${a.latest?.at ?? "unknown"}: records after it are unprotected` :
      a.status === "missing" ? "no anchor" : a.status === "mismatch" ? "MISMATCH" : "untrusted";
  return `Anchor: ${status}; local file anchor, editable by this machine's owner`;
}
function evidenceClass(intent: LedgerRecord, outcome?: LedgerRecord): string {
  if (intent.handoff || isHeartbeat(intent)) return "";
  const o = outcome?.outcome, a = intent.approval;
  const denied = intent.policy.verdict === "deny" || (a !== undefined && ["denied", "timeout", "unavailable", "no-channel"].includes(a.decision));
  if (o?.status === "ok" && denied) return "executed despite deny";
  if (o?.status === "ok") return intent.policy.verdict === "require_approval" ? "executed after ask" : "executed (allowed)";
  if (o?.status === "error") return "execution error";
  if (o?.status === "blocked" && o.errorClass === "permission-denied:auto-mode") return "denied: auto mode";
  if (intent.policy.verdict === "deny") return "denied by policy";
  if (a?.decision === "no-channel") return "denied: no channel";
  if (a?.channel === "slack" && (o?.status === "blocked" || ["denied", "timeout", "unavailable"].includes(a.decision))) return `denied: Slack ${a.decision}`;
  // A blocked outcome without a recorded cause does not establish a policy denial.
  if (o?.status === "blocked") return "";
  return intent.policy.verdict === "require_approval" && a?.decision !== "approved" ? "asked, no outcome observed" : "allowed, no outcome observed";
}

export async function renderReport(ledger: LedgerStore, range: DateRange, outDir: string, context?: ReportContext): Promise<ReportFiles> {
  const { from, to, extended } = checkedRange(range, HANDOFF_RECONCILE_GRACE_MS);
  const head = await ledger.head(); const verify = await ledger.verify();
  const all: LedgerRecord[] = [];
  // Pin 8 heartbeat coverage is anywhere in history, including outside the report/grace window.
  for await (const r of ledger.read({ from: HISTORY_START, to: "9999-12-31T23:59:59.999Z" })) all.push(r);
  if (await ledger.head() !== head) throw new Error("Ledger changed during report; retry with writers paused");
  const history = all.filter(r => Date.parse(r.writtenAt) <= Date.parse(extended));
  const records = history.filter(r => Date.parse(r.writtenAt) >= from && Date.parse(r.writtenAt) <= to);
  const tools = records.filter(isToolIntent), heartbeats = records.filter(isHeartbeat);
  const heartbeatSessions = new Set(all.filter(isHeartbeat).map(agentSession).filter((s): s is string => s !== undefined));
  const sessions = new Map<string, LedgerRecord[]>();
  for (const r of tools) { const s = agentSession(r); if (s !== undefined) { const group = sessions.get(s) ?? []; group.push(r); sessions.set(s, group); } }
  const missing = [...sessions].filter(([s]) => !heartbeatSessions.has(s));
  const missingFirst = new Set(missing.map(([, rs]) => rs[0]!.id));
  const handoffs = findHandoffs(history.filter(r => Date.parse(r.writtenAt) >= from), range);
  const handoffIds = new Set(handoffs.map(h => h.hookRecordId));
  const intents = new Map<string, LedgerRecord>(), outcomes = new Map<string, LedgerRecord>();
  const orphanIds = new Set<string>();
  const precedingIntent = new Map<string, LedgerRecord>();
  for (const r of history) {
    if (r.phase === "intent" && !isHeartbeat(r)) intents.set(r.call.callId, r);
    else if (r.phase === "outcome") {
      const intent = intents.get(r.call.callId);
      if (!intent) orphanIds.add(r.id); else precedingIntent.set(r.id, intent);
      outcomes.set(r.call.callId, r);
    }
  }
  const orphans = records.filter(r => orphanIds.has(r.id));
  const unobserved = tools.filter(r => !outcomes.has(r.call.callId));
  const unobservedIds = new Set(unobserved.map(r => r.id));
  const label = (r: LedgerRecord) => {
    if (r.phase === "intent") return evidenceClass(r, outcomes.get(r.call.callId));
    // Orphans carry no reconstructed approval/policy decision, except the explicit auto-mode cause.
    const intent = precedingIntent.get(r.id);
    return intent ? evidenceClass(intent, r) : r.outcome?.status === "blocked" && r.outcome.errorClass === "permission-denied:auto-mode" ? "denied: auto mode" : "";
  };
  const recordAnomalies = new Map<string, string[]>();
  for (const r of records) {
    const messages = [label(r) === "executed despite deny" ? "executed despite deny" : "",
      hasHeartbeatRule(r) !== hasHeartbeatCall(r) ? "heartbeat discriminator mismatch" : ""].filter(Boolean);
    if (messages.length) recordAnomalies.set(r.id, messages);
  }
  const warnings: string[][] = [];
  for (const r of heartbeats) {
    const a = r.call.args;
    for (const message of [a.watchdogCheck !== "ok" ? `watchdogCheck: ${String(a.watchdogCheck)}` : "", a.nodeOptionsSet === true ? "nodeOptionsSet: true" : "", ["bypassPermissions", "dontAsk"].includes(String(a.permissionMode)) ? `permissionMode: ${String(a.permissionMode)}` : ""].filter(Boolean)) warnings.push([r.id, sessionLabel(r), message, "informational"]);
  }
  const anchor = anchorLine(context);
  const chain = `Chain verification: ${verify.ok ? "PASS" : "FAIL"}; checked ${verify.checked} records (whole ledger); brokenAt: ${verify.brokenAt ?? "none"}`;
  const findings = [
    ...(!verify.ok ? [chain] : []),
    ...records.flatMap(r => (recordAnomalies.get(r.id) ?? []).map(message => `${message}: ${r.id}; call ${r.call.callId}`)),
    ...(context?.anchor && ["missing", "mismatch", "untrusted"].includes(context.anchor.status) ? [anchor] : []),
    ...missing.map(([s, rs]) => `session without heartbeat: ${s}; first tool record ${rs[0]!.id}; ${rs.length} tool records in range`),
    ...warnings.map(row => `Launch environment: ${row.join("; ")}`),
    ...orphans.map(r => `${agentSession(r) !== undefined && heartbeatSessions.has(agentSession(r)!) ? "intent gap" : "orphan outcome"}: ${r.id}; call ${r.call.callId}`),
    ...handoffs.map(h => `unreconciled handoff: ${h.hookRecordId}; call ${h.callId}`),
    ...unobserved.map(r => `no outcome observed: ${r.id}; call ${r.call.callId}`),
  ];
  const causes = new Map<string, number>();
  for (const r of tools) { const observed = label(r); const l = observed === "executed despite deny" ? evidenceClass(r) : observed; if (l.startsWith("denied")) causes.set(l, (causes.get(l) ?? 0) + 1); }
  // Explicit orphan auto-mode denials are evidence too; count once without an invented intent.
  for (const r of orphans) if (label(r) === "denied: auto mode") causes.set("denied: auto mode", (causes.get("denied: auto mode") ?? 0) + 1);
  const seen = new Set(records.map(agentSession).filter((s): s is string => s !== undefined));
  const generated = new Date().toISOString();
  const summary = [`${records.length} records`, `Range (writtenAt, inclusive): ${range.from} to ${range.to}`, `Generated: ${generated}`, `Observed ledger head: ${head}`, chain, anchor, trust,
    `Agent sessions seen: ${seen.size}; heartbeats: ${heartbeats.length}`,
    `Tool intents by risk: ${["read", "write", "risky", "unreviewed"].map(risk => `${risk}: ${tools.filter(r => r.policy.risk === risk).length}`).join("; ")}`,
    `Asks: ${tools.filter(r => r.policy.verdict === "require_approval" && r.approval?.decision !== "no-channel").length}; recorded approvals: ${tools.filter(r => r.approval?.decision === "approved").length}`,
    `Recorded denials by cause: ${[...causes].map(([cause, n]) => `${cause}: ${n}`).join("; ") || "none"}`,
    `Outcomes ok: ${records.filter(r => r.phase === "outcome" && r.outcome?.status === "ok").length}; error: ${records.filter(r => r.phase === "outcome" && r.outcome?.status === "error").length}; no outcome observed: ${unobserved.length}`];
  const columns = ["record_id", "phase", "written_at", "call_id", "agent_id", "session_id", "server", "tool", "arguments_labeled", "policy", "approval", "outcome", "handoff", "parent_record_id", "prev_hash", "hash", "criteria", "anomalies", "on_behalf_of", "declared_plan", "received_at", "chain_verify", "chain_checked", "chain_broken_at", "trust_boundary", "agent_session_id", "evidence_class", "anchor_status"];
  const rows = records.map(r => {
    const criteria = r.handoff || isHeartbeat(r) ? ["CC7.2"] : ["CC6.1", "CC7.2", ...((r.policy.risk !== "read" || r.approval || r.policy.verdict !== "allow") ? ["CC8.1"] : [])];
    const anomalies = [...(recordAnomalies.get(r.id) ?? []), handoffIds.has(r.id) ? "unreconciled handoff" : "", orphanIds.has(r.id) ? (heartbeatSessions.has(agentSession(r) ?? "") ? "orphan outcome; intent gap" : "orphan outcome") : "", unobservedIds.has(r.id) ? "no outcome observed" : "", missingFirst.has(r.id) ? "session without heartbeat" : ""].filter(Boolean);
    return [r.id, r.phase, r.writtenAt, r.call.callId, r.call.agentId, r.call.sessionId, r.call.server, r.call.tool, json(r.call.args), json(r.policy), json(r.approval), json(r.outcome), json(r.handoff), r.parentRecordId ?? "", r.prevHash, r.hash, criteria.join("; "), anomalies.join("; "), r.call.onBehalfOf ?? "", r.call.declaredPlan ?? "", r.call.receivedAt, verify.ok ? "PASS" : "FAIL", String(verify.checked), verify.brokenAt ?? "", trust, sessionLabel(r), label(r), context?.anchor?.status ?? "not supplied"].map(display);
  });
  const pdf: PdfBlock[] = [];
  const text = (lines: string[]) => { pdf.push({ kind: "text", lines: lines.map(display) }); return lines.map(s => `<p>${esc(display(s))}</p>`).join("\n"); };
  const heading = (title: string) => { pdf.push({ kind: "heading", lines: [title] }); return `<h3>${esc(title)}</h3>`; };
  const short = (value: string) => value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
  const mono = (value: string, compact = true) => `<code title="${esc(display(value))}">${esc(compact ? short(display(value)) : display(value))}</code>`;
  const isId = (name: string) => /(?:_id|_hash)$/.test(name) || ["hash", "first_tool_record"].includes(name);
  const isTime = (name: string) => ["written_at", "handed_off_at", "Time"].includes(name);
  const table = (headers: string[], values: string[][], caption = "Evidence") => {
    pdf.push({ kind: "table", headers, rows: values.map(row => row.map(display)) });
    const dates = [...new Set(values.flatMap(row => row.filter((value, i) => isTime(headers[i]!) && Number.isFinite(Date.parse(value))).map(value => new Date(value).toISOString().slice(0, 10))))];
    const cell = (value: string, name: string) => {
      if (isTime(name) && Number.isFinite(Date.parse(value))) {
        const utc = new Date(value).toISOString();
        return `<td class="time"><time datetime="${esc(value)}" title="${esc(value)}">${dates.length === 1 ? utc.slice(11) : utc.replace("T", " ")}</time></td>`;
      }
      if (isId(name) && value !== "pre-1c, no agent session id") return `<td>${mono(value)}</td>`;
      return `<td${/^\d+$/.test(value) ? ' class="number"' : ""}>${esc(display(value))}</td>`;
    };
    return `<div class="table-scroll"><table><caption>${esc(caption)}${dates.length ? ` · Dates (UTC): ${dates.join(", ")}` : ""}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${values.length ? values.map(row => `<tr>${row.map((value, i) => cell(value, headers[i]!)).join("")}</tr>`).join("\n") : `<tr><td colspan="${headers.length}">None</td></tr>`}</tbody></table></div>`;
  };
  const detailTable = (title: string, headers: string[], values: string[][]) => values.length ? heading(`${title} (${values.length})`) + table(headers, values, title) : "";
  const checks: [string, number][] = [["Record anomalies", recordAnomalies.size], ["Sessions without heartbeat", missing.length], ["Launch-environment warnings", warnings.length], ["Orphan outcomes", orphans.length], ["Unreconciled handoffs", handoffs.length], ["Intents with no outcome observed", unobserved.length]];
  const contents = [
    ["summary", "Executive summary", `${findings.length} findings`], ["cc6-1", "CC6.1 logical access", `${tools.length} intents`],
    ["cc7-2", "CC7.2 monitoring", `${checks.length} anomaly checks; ${heartbeats.length} heartbeats`],
    ["cc8-1", "CC8.1 change management", `${tools.filter(r => r.policy.risk !== "read").length} intents`],
    ["records", "Record evidence", `${records.length} records`], ["legend", "Vocabulary", "definitions and limitations"]
  ];
  const section = (id: string, title: string, body: () => string) => { pdf.push({ kind: "heading", lines: [title] }); return `<section id="${id}"><h2>${title}</h2>${body()}</section>`; };
  const sections = [
    section("summary", "Executive summary", () => {
      pdf.push({ kind: "text", lines: summary.map(display) });
      const anchorStatus = context?.anchor?.status;
      const status = `<div class="status-band" aria-label="Evidence status"><div class="${verify.ok ? "ok" : "flag"}"><strong>Chain verification: ${verify.ok ? "PASS" : "FAIL"}</strong><span>Checked ${verify.checked} records (whole ledger); brokenAt: ${esc(display(verify.brokenAt ?? "none"))}</span></div><div class="${anchorStatus === "head" ? "ok" : "flag"}"><strong>Anchor status: ${esc(anchorStatus ?? "not supplied")}</strong><span>${esc(display(anchor))}</span></div><div class="${findings.length ? "flag" : "ok"}"><strong>Findings: ${findings.length}</strong><span>${findings.length ? "Review the findings below" : "No findings"}</span></div></div>`;
      const facts = [["Records", summary[0]!], ["Range", summary[1]!], ["Generated", summary[2]!], ["Observed ledger head", head], ["Sessions / heartbeats", summary[7]!], ["Intents by risk", summary[8]!], ["Asks / approvals", summary[9]!], ["Denials by cause", summary[10]!], ["Outcomes", summary[11]!]];
      const grid = `<dl class="facts">${facts.map(([key, value]) => `<div><dt>${key}</dt><dd>${key === "Observed ledger head" ? mono(value!) : esc(display(value!))}</dd></div>`).join("")}</dl>`;
      pdf.push({ kind: "heading", lines: ["Findings"] }, { kind: "text", lines: (findings.length ? findings : ["No findings"]).map(display) });
      return status + grid + `<aside class="trust-boundary" aria-label="Trust boundary"><strong>Trust boundary</strong><p>${esc(trust)}</p></aside><h3>Findings</h3><ul>${(findings.length ? findings : ["No findings"]).map(s => `<li>${esc(display(s))}</li>`).join("")}</ul>`;
    }),
    section("cc6-1", "CC6.1 logical access", () => text(["[V] Scope: logical access protections (AICPA TSC, printed p. 33). [H] Mapping: recorded identities and policy decisions."]) + table(["written_at", "agent_session_id", "agent_id", "server/tool", "risk", "verdict", "rule_id"], tools.map(r => [r.writtenAt, sessionLabel(r), r.call.agentId, `${r.call.server}/${r.call.tool}`, r.policy.risk, r.policy.verdict, r.policy.ruleId]))),
    section("cc7-2", "CC7.2 monitoring", () => text(["[V] Scope: monitor operations and analyze anomalies (AICPA TSC, printed p. 39). [H] Mapping: chain, anchor, heartbeat and findings.", chain, anchor]) +
      heading("Anomaly checks") + (() => {
        pdf.push({ kind: "text", lines: checks.map(([name, count]) => `${name} (${count}): ${count ? "FLAG" : "OK"}`) });
        return `<ul class="anomaly-checks">${checks.map(([name, count]) => `<li class="${count ? "flag" : "ok"}"><span>${name} (${count})</span><strong>${count ? "FLAG" : "OK"}</strong></li>`).join("")}</ul>`;
      })() +
      detailTable("Record anomalies", ["record_id", "call_id", "finding"], records.flatMap(r => (recordAnomalies.get(r.id) ?? []).map(message => [r.id, r.call.callId, message]))) +
      heading(`Heartbeats (${heartbeats.length})`) + (heartbeats.length ? table(["written_at", "agent_session_id", "source", "permission_mode", "watchdog_check", "node_options_set", "interpreter"], heartbeats.map(r => [r.writtenAt, sessionLabel(r), ...["source", "permissionMode", "watchdogCheck", "nodeOptionsSet", "interpreter"].map(k => String(r.call.args[k] ?? "not supplied"))]), "Heartbeats") : "") +
      detailTable("Sessions without heartbeat", ["agent_session_id", "first_tool_record", "tool_records"], missing.map(([s, rs]) => [s, rs[0]!.id, String(rs.length)])) +
      text(["Tool counts and first_tool_record are within the selected range; heartbeat coverage uses all available ledger history. Pre-1c records without an agent session id are not missing-heartbeat findings."]) +
      detailTable("Launch-environment warnings", ["record_id", "agent_session_id", "warning", "severity"], warnings) + text(["A bypass-mode session produces no asks. Launch-environment warnings are informational observations, not proof of later hook coverage."]) +
      detailTable("Orphan outcomes", ["record_id", "call_id", "agent_session_id", "finding"], orphans.map(r => [r.id, r.call.callId, sessionLabel(r), heartbeatSessions.has(agentSession(r) ?? "") ? "intent gap" : "orphan outcome"])) +
      detailTable("Unreconciled handoffs", ["call_id", "proxy_server_name", "hook_record_id", "handed_off_at"], handoffs.map(h => [h.callId, h.proxyServerName, h.hookRecordId, h.handedOffAt])) +
      detailTable("Intents with no outcome observed", ["record_id", "call_id"], unobserved.map(r => [r.id, r.call.callId]))),
    section("cc8-1", "CC8.1 change management", () => text(["[V] Scope: controlled, authorized changes (AICPA TSC, printed p. 44). [H] Mapping: write/risky/unreviewed tool decisions; a shell call need not be a production change."]) + table(["written_at", "agent_session_id", "server/tool", "risk", "approval (decision, approver)", "outcome (status, errorClass)", "evidence_class"], tools.filter(r => r.policy.risk !== "read").map(r => [r.writtenAt, sessionLabel(r), `${r.call.server}/${r.call.tool}`, r.policy.risk, r.approval ? `${r.approval.decision}, ${r.approval.approver ?? "not recorded"}` : "not recorded", outcomes.get(r.call.callId)?.outcome ? json(outcomes.get(r.call.callId)!.outcome) : "no outcome observed", label(r)])) + text([denial])),
    section("records", "Record evidence", () => {
      // Keep the complete PDF blocks until its separate layout pass; CSV rows are never edited for presentation.
      const compact = table(["Time", "Phase", "Tool", "Decision", "Evidence class", "Criteria"], records.map((r, i) => [r.writtenAt, r.phase, r.call.tool, isHeartbeat(r) ? "health record" : r.handoff ? "handoff" : r.policy.verdict, label(r), rows[i]![16]!]), "Record index; full fields follow in numbered details");
      return compact + rows.map((row, i) => {
        const fields = columns.slice(0, 21).map((name, n) => [name, row[n]!] as const).filter(([, value]) => value !== "" && value !== "{}" && value !== "[]" && value !== "null");
        pdf.push({ kind: "record", lines: columns.slice(0, 21).map((c, n) => `${c}: ${row[n]}`) });
        return `<details id="record-${i + 1}"><summary>Record ${i + 1} · ${esc(records[i]!.phase)} · ${esc(display(records[i]!.call.tool))} · ${mono(records[i]!.id)}</summary><dl class="record-fields">${fields.map(([name, value]) => `<dt>${name}</dt><dd>${isId(name) ? mono(value, false) : esc(value)}</dd>`).join("")}</dl></details>`;
      }).join("\n");
    }),
    section("legend", "Vocabulary", () => text([...vocabulary, "UTC = Coordinated Universal Time; times in tables use UTC, with dates in captions (multi-date rows retain the date). IDs and hashes may be shortened in tables; full values are in titles and Record evidence. CC = Common Criteria; SOC = System and Organization Controls; TSC = Trust Services Criteria; [V] = verified scope; [H] = hypothesized mapping. OK = no finding in this check; FLAG = observations to review, not proof of a control failure.", denial, "heartbeat = the SessionStart hook ran and could reach the ledger; it does not prove every later call was hooked", "AICPA 2017 Trust Services Criteria (Revised Points of Focus 2022), printed pages 33, 39, 44; [V] scope / [H] evidence mapping. https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022"]))
  ];
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Ledger evidence pack</title>
<style>
:root{font-family:Charter,"Iowan Old Style",Cambria,Georgia,serif;color:#202b33;background:#fff;font-size:16px;line-height:1.55}
body{max-width:1180px;margin:40px auto;padding:0 28px}h1,h2,h3,nav,dt,table,summary,.status-band,.downloads{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}h1{font-size:2rem;line-height:1.2;margin-bottom:12px}h2{font-size:1.35rem}h3{font-size:1rem}p,section>ul{max-width:72ch}p{margin:12px 0}a{color:#174d75;text-underline-offset:3px}header{margin-bottom:28px}.subtitle{color:#4b5963}.downloads{display:flex;gap:20px;font-size:.9rem}nav{background:#f4f6f7;padding:16px 20px;margin:24px 0}nav ol{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 28px;padding-left:24px}nav span{display:block;color:#4b5963;font-size:.8rem}section{border-top:1px solid #b8c3cb;padding:20px 0;scroll-margin-top:16px}
.status-band{display:grid;grid-template-columns:1fr 1.6fr .8fr;gap:12px;margin:20px 0}.status-band>div{padding:14px;border:1px solid #bdcbc5;border-top:4px solid #28634b;background:#f2f7f4}.status-band .flag{border-color:#956019;background:#fff8eb}.status-band strong,.status-band span{display:block}.status-band span{font-size:.8rem;margin-top:6px}.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 28px}.facts dt{color:#4b5963;font-size:.8rem}.facts dd{margin:4px 0 0;font-variant-numeric:tabular-nums}.trust-boundary{border-left:4px solid #526b7c;background:#f4f6f7;padding:16px 20px;margin:24px 0}.trust-boundary p{margin-bottom:0}
table{border-collapse:collapse;width:100%;font-size:.78rem}caption{text-align:left;color:#4b5963;font-size:.75rem;padding:8px 0}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #d5dce1;padding:9px 10px;overflow-wrap:break-word}th{background:#e9eef1;font-weight:600}tbody tr:nth-child(even){background:#f7f9fa}.time{white-space:nowrap}.time,.number{font-variant-numeric:tabular-nums}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.85em;overflow-wrap:anywhere}td code{white-space:nowrap}.table-scroll{overflow-x:auto}.anomaly-checks{list-style:none;padding:0;max-width:72ch}.anomaly-checks li{display:flex;justify-content:space-between;gap:20px;padding:8px 12px;border-bottom:1px solid #d5dce1}.anomaly-checks strong{font:600 .8rem system-ui;color:#28634b}.anomaly-checks .flag strong{color:#80500d}details{border-bottom:1px solid #d5dce1;padding:12px 0}summary{cursor:pointer;font-size:.9rem}summary:focus-visible,a:focus-visible{outline:2px solid #174d75;outline-offset:4px}.record-fields{display:grid;grid-template-columns:170px minmax(0,1fr);gap:8px 20px;font-size:.9rem}.record-fields dt{font-size:.8rem;color:#4b5963}.record-fields dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:760px){body{margin:24px auto;padding:0 16px}.status-band,.facts,nav ol{grid-template-columns:1fr}.record-fields{grid-template-columns:1fr}.record-fields dd{margin-bottom:12px}table{min-width:700px}}
@media print{@page{size:landscape;margin:14mm}body{max-width:none;margin:0;padding:0;font-size:10pt}header,nav,.status-band,.trust-boundary{break-inside:avoid}h2,h3,caption{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}.table-scroll{overflow:visible}table{min-width:0;font-size:8pt}th,td{padding:5px}.downloads{display:none}.status-band>div,.status-band .flag{background:white;border-color:#555}.anomaly-checks strong,.anomaly-checks .flag strong{color:#222}details::details-content{content-visibility:visible}details>*{display:block}details>.record-fields{display:grid}details{break-inside:avoid}.record-fields{font-size:8pt}td code{white-space:normal}a{color:inherit}}
</style>
<header><h1>SOC 2 evidence pack</h1><p class="subtitle">Agent Ledger · Range: ${esc(range.from)} to ${esc(range.to)}<br>Generated: ${esc(generated)} · Head: ${mono(head)}</p><p class="downloads"><a href="report.pdf" download>Download PDF</a><a href="records.csv" download>Download CSV</a></p></header>
<nav aria-label="Contents"><strong>Contents</strong><ol>${contents.map(([id, title, count]) => `<li><a href="#${id}">${title}</a><span>${count}</span></li>`).join("")}</ol></nav><main>${sections.join("\n")}</main></html>\n`;
  const csv = [columns, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const dir = resolve(outDir); await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of [["records.csv", csv], ["report.pdf", textPdf(pdf, verify.ok ? "PASS" : "FAIL")], ["report.html", html]] as const) await writeFile(join(dir, name), content, { flag: "wx", mode: 0o600 });
  return { pdfPath: join(dir, "report.pdf"), csvPath: join(dir, "records.csv") };
}
