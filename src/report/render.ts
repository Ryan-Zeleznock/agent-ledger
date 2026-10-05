import { agentSession, collectEvidence, handoffScan, hasHeartbeatCall, hasHeartbeatRule, isHeartbeat, type IntentEvidence, type OutcomeEvidence } from "./history.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { DateRange, LedgerRecord } from "../types/index.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { ReportFiles, ReportContext, UnreconciledHandoff } from "./contract.js";
import { embeddedFontCss, fontLicenseNotices } from "./embedded-fonts.js";
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
  const scan = handoffScan();
  for (const r of records) if (Date.parse(r.writtenAt) >= from && Date.parse(r.writtenAt) <= to) scan.add(r);
  for (const r of records) scan.observe(r);
  return scan.unmatched();
}

const trust = "Local mode: visibility, tamper-evident logging and best-effort gating, not enforcement. Records cover governed paths only. A machine owner can bypass hooks or rewrite local files. Server mode is the enforcement boundary only when upstream credentials are isolated from the agent. These records have no deployment-mode attestation; this pack makes no server-enforcement claim.";
const vocabulary = [
  "Evidence mapping [H]: candidate support for SOC 2 criteria, not an audit opinion or proof that a criterion is satisfied.",
  "CC6.1 logical access: recorded agent identity and reviewed allowlist/policy verdicts.",
  "CC7.2 monitoring: chain links, full-ledger verification and anomalies for investigation.",
  "CC8.1 change management: writes and risky/unknown actions, approval requests, approvals and denials. A shell call is not necessarily a production change.",
  "delegated = asked in the terminal; not a recorded human approval. An intent with no outcome means execution was not observed; denial, cancellation or lost telemetry cannot be distinguished.",
  "An empty evidence_class identifies a heartbeat/handoff, an orphan without a classifiable cause, or a blocked outcome whose cause is not recorded; consult the raw outcome. It does not mean allowed or successful execution.",
  "Agent session id: not recorded (server mode or pre-1c) means the record has no agent runtime session id. Records have no deployment-mode discriminator, so a missing id cannot identify a proxy writer or establish record age.",
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
const isToolIntent = (r: LedgerRecord) => r.phase === "intent" && !r.handoff && !isHeartbeat(r);
// No deployment-mode/provenance field exists; MCP names and missing hook ids cannot identify the writer.
const missingSessionLabel = "not recorded (server mode or pre-1c)";
const sessionLabel = (r: LedgerRecord) => agentSession(r) ?? missingSessionLabel;
function approvalLabel(r: LedgerRecord): string {
  const a = r.approval; if (!a) return "not recorded";
  const member = a.approver ? (a.approverName?.trim() ? `${a.approverName} (${a.approver})` : a.approver) : "not recorded";
  return `${a.decision}, ${member}`;
}
const denial = "A manual denial at the Claude Code permission prompt fires no hook event (Claude Code hooks reference, read 2026-10-01), so 'asked, no outcome observed' cannot distinguish a user's denial from a cancelled call, an interrupted session or lost telemetry. Only auto-mode denials are recorded (`permission-denied:auto-mode`).";

function anchorLine(context?: ReportContext): string {
  const a = context?.anchor;
  const status = !a ? "not supplied to this report" : a.status === "head" ? `head anchored at ${a.latest?.at ?? "unknown"}` :
    a.status === "ancestor" ? `ancestor anchored at ${a.latest?.at ?? "unknown"}: records after it are unprotected` :
      a.status === "missing" ? "no anchor" : a.status === "mismatch" ? "MISMATCH" : "untrusted";
  return `Anchor: ${status}; local file anchor, editable by this machine's owner`;
}
function evidenceClass(intent: IntentEvidence, outcome?: OutcomeEvidence): string {
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
  const { extended } = checkedRange(range, HANDOFF_RECONCILE_GRACE_MS);
  const head = await ledger.head(); const verify = await ledger.verify();
  const { records, heartbeatSessions, handoffs, orphanIds, precedingIntent, outcomes } = await collectEvidence(ledger, range, extended);
  if (await ledger.head() !== head) throw new Error("Ledger changed during report; retry with writers paused");
  const tools = records.filter(isToolIntent), heartbeats = records.filter(isHeartbeat);
  const sessions = new Map<string, LedgerRecord[]>();
  for (const r of tools) { const s = agentSession(r); if (s !== undefined) { const group = sessions.get(s) ?? []; group.push(r); sessions.set(s, group); } }
  const missing = [...sessions].filter(([s]) => !heartbeatSessions.has(s));
  const missingFirst = new Set(missing.map(([, rs]) => rs[0]!.id));
  const handoffIds = new Set(handoffs.map(h => h.hookRecordId));
  const orphans = records.filter(r => orphanIds.has(r.id));
  const unobserved = tools.filter(r => !outcomes.has(r.id));
  const unobservedIds = new Set(unobserved.map(r => r.id));
  const label = (r: LedgerRecord) => {
    if (r.phase === "intent") return evidenceClass(r, outcomes.get(r.id));
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
  let sectionNumber = 0, tableNumber = 0;
  const tableStyles: string[] = [];
  const reference = (i: number) => `R-${String(i + 1).padStart(4, "0")}`;
  const namedApproval = (r: LedgerRecord) => r.policy.risk !== "read" && r.approval?.decision === "approved" && Boolean(r.approval.approver?.trim());
  const anomalousRecords = new Set(records.filter((_, i) => rows[i]![17]).map(r => r.id));
  const exception = (r: LedgerRecord) => /denied|error|despite deny/.test(label(r)) || r.policy.verdict === "deny" ||
    ["denied", "timeout", "unavailable", "no-channel"].includes(r.approval?.decision ?? "") || anomalousRecords.has(r.id);
  const text = (lines: string[]) => { pdf.push({ kind: "text", lines: lines.map(display) }); return lines.map(s => `<p>${esc(display(s))}</p>`).join("\n"); };
  const heading = (title: string) => { pdf.push({ kind: "heading", lines: [title] }); return `<h3>${esc(title)}</h3>`; };
  const short = (value: string) => value.length > 20 && !value.includes("HMAC-SHA256 digest") ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
  const mono = (value: string, compact = true) => `<code title="${esc(display(value))}">${esc(compact ? short(display(value)) : display(value))}</code>`;
  const isId = (name: string) => /(?:_id|_hash)$/.test(name) || ["hash", "first_tool_record"].includes(name);
  const isTime = (name: string) => ["written_at", "handed_off_at", "Time"].includes(name);
  const table = (headers: string[], values: string[][], caption = "Evidence", pinned = true, sourceRecords: LedgerRecord[] = []) => {
    const tableId = `table-${sectionNumber}-${++tableNumber}`;
    caption = `Table ${sectionNumber}.${tableNumber} · ${caption}`;
    const dates = [...new Set(values.flatMap(row => row.filter((value, i) => isTime(headers[i]!) && Number.isFinite(Date.parse(value))).map(value => new Date(value).toISOString().slice(0, 10))))];
    const dateCaption = `${caption}${dates.length ? ` · Dates (UTC): ${dates.join(", ")}` : ""}`;
    const pdfRows = values.map(row => row.map((value, i) => {
      if (pinned) return display(value);
      if (isTime(headers[i]!) && Number.isFinite(Date.parse(value))) {
        const utc = new Date(value).toISOString();
        return dates.length === 1 ? utc.slice(11) : utc.replace("T", " ");
      }
      return isId(headers[i]!) && value !== missingSessionLabel ? short(display(value)).replace("…", "...") : display(value);
    }));
    const exceptionRows = values.map((_, i) => sourceRecords[i] ? (headers.includes("verdict") ? sourceRecords[i]!.policy.verdict === "deny" : exception(sourceRecords[i]!)) : /Record anomalies|Sessions without heartbeat|Launch-environment warnings|Orphan outcomes|Unreconciled handoffs|Intents with no outcome/.test(caption));
    const approvalColumn = headers.indexOf("approval (decision, approver)");
    const approvalRows = values.map((_, i) => approvalColumn >= 0 && Boolean(sourceRecords[i] && namedApproval(sourceRecords[i]!)));
    // The e2e parser requires literal <tr>/<td> tags in pinned tables. Style by position only.
    values.forEach((_, i) => {
      if (exceptionRows[i]) tableStyles.push(`.${tableId} tbody tr:nth-child(${i + 1}) td{background:var(--exception-tint)}`);
      if (approvalRows[i]) tableStyles.push(`/* human-approval-mark */ .${tableId} tbody tr:nth-child(${i + 1}) td:nth-child(${approvalColumn + 1}){color:var(--human-approval);outline:1.5px solid var(--human-approval);outline-offset:-4px;padding:8px 16px}`);
    });
    pdf.push({ kind: "table", headers, rows: pdfRows, caption: dateCaption.replaceAll(" · ", " / "), exceptionRows, approvalRows, approvalColumn });
    const cell = (value: string, name: string, source?: LedgerRecord) => {
      const approval = source?.approval;
      if (name === "approval (decision, approver)" && approval?.approver && approval.approverName?.trim()) {
        // Isolate even historical names containing bidi controls; the stable member id stays outside.
        return `<td>${esc(display(approval.decision))}, <bdi>${esc(display(approval.approverName))}</bdi> (${esc(display(approval.approver))})</td>`;
      }
      if (name === "Chain") return `<td class="chain-margin">${esc(value).replaceAll("\n", "<br>")}</td>`;
      if (pinned) return `<td>${esc(display(value))}</td>`;
      if (isTime(name) && Number.isFinite(Date.parse(value))) {
        const utc = new Date(value).toISOString();
        return `<td class="time"><time datetime="${esc(value)}" title="${esc(value)}">${dates.length === 1 ? utc.slice(11) : utc.replace("T", " ")}</time></td>`;
      }
      if (isId(name) && value !== missingSessionLabel) return `<td>${mono(value)}</td>`;
      return `<td${/^\d+$/.test(value) ? ' class="number"' : ""}>${esc(display(value))}</td>`;
    };
    // Pinned cells retain their text; approval names alone get bidi isolation. Wrapper classes style columns.
    const columnClasses = pinned ? headers.map((name, i) => isTime(name) ? `time-${i + 1}` : isId(name) ? `id-${i + 1}` : name === "tool_records" ? `number-${i + 1}` : "").filter(Boolean).join(" ") : "";
    return `<div class="table-scroll ${tableId}${columnClasses ? ` ${columnClasses}` : ""}"><table><caption>${esc(dateCaption)}</caption><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${values.length ? values.map((row, rowIndex) => `<tr>${row.map((value, i) => cell(value, headers[i]!, sourceRecords[rowIndex])).join("")}</tr>`).join("\n") : `<tr><td colspan="${headers.length}">None</td></tr>`}</tbody></table></div>`;
  };
  const detailTable = (title: string, headers: string[], values: string[][]) => values.length ? heading(`${title} (${values.length})`) + table(headers, values, title) : "";
  const checks: [string, number][] = [["Record anomalies", recordAnomalies.size], ["Sessions without heartbeat", missing.length], ["Launch-environment warnings", warnings.length], ["Orphan outcomes", orphans.length], ["Unreconciled handoffs", handoffs.length], ["Intents with no outcome observed", unobserved.length]];
  const contents = [
    ["summary", "Executive summary", `${findings.length} findings`], ["cc6-1", "CC6.1 logical access", `${tools.length} intents`],
    ["cc7-2", "CC7.2 monitoring", `${checks.length} anomaly checks; ${heartbeats.length} heartbeats`],
    ["cc8-1", "CC8.1 change management", `${tools.filter(r => r.policy.risk !== "read").length} intents`],
    ["records", "Record evidence", `${records.length} records`], ["legend", "Vocabulary", `${vocabulary.length + 5} entries`]
  ];
  // ReportContext has no entity, policy version, reviewer or deployment-mode attestation.
  const registration = [["Pack", `AL-${generated}`], ["Period", `${range.from} to ${range.to}`],
    ["Records", String(records.length)], ["Policy version / reviewer", "Not recorded in ledger schema"], ["Mode", "Not attested; see trust boundary"]];
  const scope = `Scope: ${records.length} selected records; criteria CC6.1, CC7.2 and CC8.1. Candidate evidence mapping, not an audit opinion.`;
  pdf.push(
    { kind: "cover", title: "SOC 2 evidence pack", entity: "Agent Ledger / Entity not supplied", scope, registration, chain: display(chain), anchor: display(anchor), head: display(head), trust, findings: findings.length },
    { kind: "pagebreak" }, { kind: "contents", entries: contents.map(([id, title, count], i) => ({ id: id!, title: `${i + 1}. ${title}`, count: count! })) },
    { kind: "pagebreak" }
  );
  const section = (id: string, title: string, body: () => string) => {
    sectionNumber++; tableNumber = 0;
    const numbered = `${sectionNumber}. ${title}`;
    pdf.push({ kind: "heading", id, lines: [numbered] });
    return `<section id="${id}"><h2>${title}</h2>${body()}</section>`;
  };
  const sections = [
    section("summary", "Executive summary", () => {
      pdf.push({ kind: "text", lines: summary.map(display) });
      const status = `<p class="findings-status">Findings: ${findings.length} · ${findings.length ? "Review the findings below" : "No findings"}</p>`;
      const facts = [["Records", summary[0]!], ["Range", summary[1]!], ["Generated", summary[2]!], ["Observed ledger head", summary[3]!], ["Chain verification", chain], ["Anchor", anchor], ["Sessions / heartbeats", summary[7]!], ["Intents by risk", summary[8]!], ["Asks / approvals", summary[9]!], ["Denials by cause", summary[10]!], ["Outcomes", summary[11]!]];
      const grid = `<dl class="facts">${facts.map(([key, value]) => `<div><dt>${key}</dt><dd${key === "Observed ledger head" ? ` class="ledger-head" title="${esc(display(head))}"` : ""}>${esc(display(value!))}</dd></div>`).join("")}</dl>`;
      pdf.push({ kind: "heading", lines: ["Findings"] }, { kind: "text", lines: (findings.length ? findings : ["No findings"]).map(display) });
      return status + grid + `<aside class="trust-boundary" aria-label="Trust boundary"><strong>Trust boundary</strong><p>${esc(trust)}</p></aside><h3>Findings</h3><ul>${(findings.length ? findings : ["No findings"]).map(s => `<li>${esc(display(s))}</li>`).join("")}</ul>`;
    }),
    section("cc6-1", "CC6.1 logical access", () => text(["[V] Scope: logical access protections (AICPA TSC, printed p. 33). [H] Mapping: recorded identities and policy decisions."]) + table(["written_at", "agent_session_id", "agent_id", "server/tool", "risk", "verdict", "rule_id"], tools.map(r => [r.writtenAt, sessionLabel(r), r.call.agentId, `${r.call.server}/${r.call.tool}`, r.policy.risk, r.policy.verdict, r.policy.ruleId]), "Access decisions", true, tools)),
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
    section("cc8-1", "CC8.1 change management", () => text(["[V] Scope: controlled, authorized changes (AICPA TSC, printed p. 44). [H] Mapping: write/risky/unreviewed tool decisions; a shell call need not be a production change."]) + table(["written_at", "agent_session_id", "server/tool", "risk", "approval (decision, approver)", "outcome (status, errorClass)", "evidence_class"], tools.filter(r => r.policy.risk !== "read").map(r => [r.writtenAt, sessionLabel(r), `${r.call.server}/${r.call.tool}`, r.policy.risk, approvalLabel(r), outcomes.get(r.id)?.outcome ? json(outcomes.get(r.id)!.outcome) : "no outcome observed", label(r)]), "Change decisions", true, tools.filter(r => r.policy.risk !== "read")) + text([denial])),
    section("records", "Record evidence", () => {
      // Presentation derives from the unchanged CSV projection; retain every non-empty source field.
      const compact = table(["Chain", "Time", "Phase", "Tool", "Decision", "Evidence class", "Criteria"], records.map((r, i) => [`${reference(i)}\nprev ${display(r.prevHash).slice(0, 12)}\nhash ${display(r.hash).slice(0, 12)}`, r.writtenAt, r.phase, r.call.tool, isHeartbeat(r) ? "health record" : r.handoff ? "handoff" : r.policy.verdict, label(r), rows[i]![16]!]), "Record index; full fields follow in numbered details", false, records);
      return compact + rows.map((row, i) => {
        const fields = [...columns.slice(0, 20).map((name, n) => [name, row[n]!] as const), ["agent_session_id", display(agentSession(records[i]!) ?? "")] as const, ["evidence_class", row[26]!] as const, ["received_at", row[20]!] as const].filter(([name, value]) => value !== "" && !(name === "arguments_labeled" && Object.keys(records[i]!.call.args).length === 0));
        const lines: string[] = [];
        for (const [name, value] of fields) {
          const line = `${name}: ${value}`;
          const previous = lines.at(-1);
          // Keep record boundaries explicit; combine short interior fields without dropping evidence.
          if (previous && !isId(name) && !/^(?:record_id|call_id|agent_id|session_id|agent_session_id|parent_record_id|prev_hash|hash):/.test(previous) && name !== "received_at" && previous.length + line.length < 100) lines[lines.length - 1] = `${previous} | ${line}`;
          else lines.push(line);
        }
        pdf.push({ kind: "record", lines: [reference(i), ...lines] });
        return `<details open id="record-${i + 1}"><summary>${reference(i)} · ${esc(records[i]!.phase)} · ${esc(display(records[i]!.call.tool))} · ${mono(records[i]!.id)}</summary><dl class="record-fields">${fields.map(([name, value]) => `<dt>${name}</dt><dd>${isId(name) ? mono(value, false) : esc(value)}</dd>`).join("")}</dl></details>`;
      }).join("\n");
    }),
    section("legend", "Vocabulary", () => text([...vocabulary, "UTC = Coordinated Universal Time; criterion tables retain full source timestamps, identifiers and hashes. The record index uses UTC times with dates in captions (multi-date rows retain the date). Record summaries may shorten identifiers; full values are in Record evidence. R-0001 references are pack-local sequence numbers. Chain margins show prefixes only; the record index is filtered to this range, so adjacent rows need not be consecutive ledger records. CC = Common Criteria; SOC = System and Organization Controls; TSC = Trust Services Criteria; [V] = verified scope; [H] = hypothesized mapping. OK = no finding in this check; FLAG = observations to review, not proof of a control failure.", denial, "heartbeat = the SessionStart hook ran and could reach the ledger; it does not prove every later call was hooked", "AICPA 2017 Trust Services Criteria (Revised Points of Focus 2022), printed pages 33, 39, 44; [V] scope / [H] evidence mapping. https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022", "Fonts embedded in HTML: Source Serif 4 © Adobe; IBM Plex Sans Condensed © IBM Corp.; JetBrains Mono © The JetBrains Mono Project Authors. All licensed under SIL Open Font License 1.1. Full license notices are in the HTML pack and src/report/fonts."]) + `<details class="font-notices"><summary>Font license notices (SIL Open Font License 1.1)</summary>${fontLicenseNotices.map(notice => `<pre>${esc(notice)}</pre>`).join("\n")}</details>`)
  ];
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Ledger evidence pack</title>
<style>
body{counter-reset:section}section[id]>h2::before{counter-increment:section;content:counter(section) ". "}
${embeddedFontCss}
:root{--paper:#FFFFFF;--surround:#EEF0EE;--ink:#1B2733;--ink-muted:#4A5866;--rule:#C9D0CC;--rule-strong:#9AA69F;--seal:#8C6A1E;--human-approval:#7A1F2B;--exception-tint:#F6F1EA;--serif:"Source Serif 4",serif;--form:"IBM Plex Sans Condensed",sans-serif;--mono:"JetBrains Mono",monospace;--xs:4px;--sm:8px;--md:16px;--lg:24px;--xl:32px;--2xl:48px;--3xl:64px;color-scheme:light;background:var(--surround);color:var(--ink)}
*{box-sizing:border-box;border-radius:0}body{margin:0;font:400 1.0625rem/1.55 var(--serif);font-optical-sizing:auto}.sheet{max-width:1080px;margin:48px auto;padding:64px;background:var(--paper);box-shadow:0 8px 24px #1B273310}h1,h2,h3{font-family:var(--serif);font-weight:600;margin:0}h1{font-size:2.75rem;letter-spacing:-.005em;line-height:1.08}h2{font-size:1.625rem;line-height:1.2;margin:64px 0 16px}h3{font-size:1.1875rem;margin:32px 0 8px}p{max-width:68ch;margin:0 0 16px}a{color:inherit;text-underline-offset:3px}.label,dt,caption,th{font:600 .78rem/1.3 var(--form);letter-spacing:.01em;color:var(--ink-muted)}.muted{color:var(--ink-muted)}.cover{display:grid;grid-template-columns:2fr 1fr;gap:48px;border-bottom:2px solid var(--ink);padding-bottom:32px}.entity{font-size:1.1875rem;margin-top:16px}.registration{margin:0;border:1px solid var(--rule-strong);min-width:0}.registration>div{display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px;padding:8px 16px;border-bottom:1px solid var(--rule)}.registration>div:last-child{border-bottom:0}.registration dd{margin:0;text-align:right;font:400 .9rem/1.4 var(--form);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.integrity-block{display:grid;grid-template-columns:auto minmax(0,1fr);gap:24px;margin-top:32px;padding:24px;border:1px solid var(--rule-strong)}.verification-seal{width:76px;height:76px;border:2px solid var(--seal);color:var(--seal);border-radius:9999px;display:grid;align-content:center;text-align:center;font:600 .78rem/1.2 var(--form)}.verdict{font-weight:600;font-size:1.25rem}.ledger-head,code{font:400 .84rem/1.55 var(--mono);font-variant-ligatures:none;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.trust-boundary{border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);margin:24px 0;padding:16px 0}.trust-boundary strong{font:600 .78rem/1.3 var(--form)}.trust-boundary p{margin:8px 0 0}.downloads{display:flex;gap:24px;font-family:var(--form)}nav{border-block:1px solid var(--rule);padding:16px 0;font-family:var(--form)}nav ol{display:grid;grid-template-columns:1fr 1fr;gap:8px 32px;padding-left:24px}nav span{display:block;font-size:.9rem;color:var(--ink-muted)}section{scroll-margin-top:16px}.facts{margin:16px 0}.facts>div{display:grid;grid-template-columns:160px minmax(0,1fr);gap:24px;padding:8px 0;border-bottom:1px solid var(--rule)}.facts dd{margin:0;max-width:68ch}
table{border-collapse:collapse;width:100%;font:400 .9rem/1.4 var(--form);font-variant-numeric:tabular-nums}caption{text-align:left;padding-bottom:8px}th,td{text-align:left;vertical-align:top;padding:8px;overflow-wrap:break-word}th{border-bottom:1.5px solid var(--ink)}td{border-bottom:1px solid var(--rule)}.time,.number{font-variant-numeric:tabular-nums}.time{white-space:nowrap}.table-scroll{overflow-x:auto;margin:16px 0}.chain-margin{font:400 12px/1.35 var(--mono);font-variant-ligatures:none;white-space:nowrap;color:var(--ink-muted);border-right:1px dashed var(--rule-strong)}.anomaly-checks{list-style:none;padding:0;max-width:68ch}.anomaly-checks li{display:flex;justify-content:space-between;gap:24px;padding:8px;border-bottom:1px solid var(--rule)}.anomaly-checks strong{font:600 .78rem/1.4 var(--form)}.anomaly-checks .flag{background:var(--exception-tint)}details{border-bottom:1px solid var(--rule);padding:16px 0}summary{cursor:pointer;font-family:var(--form)}summary:focus-visible,a:focus-visible{outline:2px solid var(--ink);outline-offset:4px}.record-fields{display:grid;grid-template-columns:160px minmax(0,1fr);gap:8px 24px}.record-fields dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.font-notices pre{font:400 .84rem/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:760px){.sheet{margin:0;padding:24px}.cover,nav ol,.facts>div,.record-fields{grid-template-columns:1fr}.cover{gap:24px}.integrity-block{padding:16px;gap:16px}.record-fields dd{margin-bottom:16px}table{min-width:700px}}
@media print{@page{size:landscape;margin:14mm}:root{background:var(--paper)}.sheet{max-width:none;margin:0;padding:0;box-shadow:none}.cover,nav,.integrity-block,.trust-boundary{break-inside:avoid}h2,h3,caption{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}.table-scroll{overflow:visible}table{min-width:0}th,td{padding:4px}.downloads{display:none}details::details-content{content-visibility:visible}details>*{display:block}details>.record-fields{display:grid}.record-fields{break-inside:avoid}a{color:inherit}}

${tableStyles.join("\n")}
${Array.from({ length: 7 }, (_, i) => {
  const n = i + 1;
  return `.time-${n} td:nth-child(${n}){font-variant-numeric:tabular-nums}.number-${n} td:nth-child(${n}){font-variant-numeric:tabular-nums}.id-${n} td:nth-child(${n}){font-family:var(--mono);font-size:.84rem;overflow-wrap:anywhere;font-variant-ligatures:none}`;
}).join("\n")}
</style><body><main class="sheet">
<header class="cover" aria-label="Exhibit cover"><div><h1>SOC 2 evidence pack</h1><p class="entity">Agent Ledger · Entity not supplied</p><p>${esc(scope)}</p><p class="muted">Generated: ${esc(generated)}</p></div><dl class="registration" aria-label="Registration">${registration.map(([key, value]) => `<div><dt>${key}</dt><dd>${key === "Pack" ? mono(value!, false) : esc(display(value!))}</dd></div>`).join("")}</dl></header>
<div class="integrity-block" aria-label="Integrity statement"><div class="verification-seal">CHAIN<br>${verify.ok ? "VERIFIED" : "FAIL"}</div><div><p class="verdict">${esc(display(chain))}</p><p>${esc(display(anchor))}</p><div class="label">Ledger head (SHA-256)</div><div class="ledger-head">${esc(display(head))}</div></div></div>
<aside class="trust-boundary" aria-label="Cover trust boundary"><strong>Trust boundary</strong><p>${esc(trust)}</p></aside>
<p class="downloads"><a href="report.pdf" download>Download PDF</a><a href="records.csv" download>Download CSV</a></p>
<nav aria-label="Contents"><strong>Contents</strong><ol>${contents.map(([id, title, count]) => `<li><a href="#${id}">${title}</a><span>${count}</span></li>`).join("")}</ol></nav>${sections.join("\n")}</main></body></html>\n`;
  const csv = [columns, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const dir = resolve(outDir); await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of [["records.csv", csv], ["report.pdf", textPdf(pdf, verify.ok ? "PASS" : "FAIL")], ["report.html", html]] as const) await writeFile(join(dir, name), content, { flag: "wx", mode: 0o600 });
  return { pdfPath: join(dir, "report.pdf"), csvPath: join(dir, "records.csv") };
}
