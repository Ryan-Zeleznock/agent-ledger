import type { DateRange, LedgerRecord } from "../types/index.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { UnreconciledHandoff } from "./contract.js";
import { checkEvidenceRecord, evidenceBudget, evidenceMap } from "./limits.js";

export const hasHeartbeatRule = (r: IntentEvidence) => r.policy.ruleId === "heartbeat:session-start";
export const hasHeartbeatCall = (r: IntentEvidence) => r.call.tool === "SessionStart" && r.call.server.startsWith("builtin:");
export const isHeartbeat = (r: IntentEvidence) => hasHeartbeatRule(r) && hasHeartbeatCall(r);
export const agentSession = (r: LedgerRecord): string | undefined => r.call.agentSessionId;
export const correlationKey = (r: LedgerRecord) => JSON.stringify([r.call.callId, r.call.agentId, r.call.sessionId, r.call.agentSessionId ?? null]);
/** No historical arguments, attribution or other payloads are retained for classification. */
export type IntentEvidence = Pick<LedgerRecord, "id" | "policy" | "approval" | "handoff"> & { call: Pick<LedgerRecord["call"], "server" | "tool"> };
export type OutcomeEvidence = Pick<LedgerRecord, "outcome">;
const intentEvidence = (r: LedgerRecord): IntentEvidence => ({
  id: r.id, policy: r.policy, approval: r.approval, handoff: r.handoff, call: { server: r.call.server, tool: r.call.tool },
});

/** Index only selected handoffs. Matching remains callId correlation, with the frozen proxy exclusions. */
export function handoffScan() {
  const budget = evidenceBudget();
  const pending: { evidence: UnreconciledHandoff; group: { matched: boolean } }[] = [];
  const calls = new Map<string, Map<string, { matched: boolean }>>();
  return {
    add(r: LedgerRecord) {
      if (r.phase !== "intent" || !r.handoff) return;
      const evidence = { callId: r.call.callId, proxyServerName: r.handoff.proxyServerName, hookRecordId: r.id, handedOffAt: r.writtenAt };
      budget.add(evidence);
      let groups = calls.get(evidence.callId);
      if (!groups) { groups = new Map(); calls.set(evidence.callId, groups); }
      let group = groups.get(evidence.proxyServerName);
      if (!group) { group = { matched: false }; groups.set(evidence.proxyServerName, group); }
      pending.push({ evidence, group });
    },
    observe(r: LedgerRecord) {
      if (r.phase !== "intent" || r.handoff || r.call.server.startsWith("builtin:") ||
        r.policy.ruleId.startsWith("handoff-to-proxy:") || r.policy.ruleId.startsWith("codex-mcp-not-proxied:")) return;
      const groups = calls.get(r.call.callId); if (!groups) return;
      for (const [proxy, group] of groups) if (r.call.server !== proxy) { group.matched = true; groups.delete(proxy); }
      if (groups.size === 0) calls.delete(r.call.callId);
    },
    unmatched: () => pending.filter(x => !x.group.matched).map(x => x.evidence),
  };
}

/** Two passes: selected evidence, then history with state bounded by selected identities/calls. */
export async function collectEvidence(ledger: LedgerStore, range: DateRange, extended: string) {
  const records: LedgerRecord[] = [], selectedBudget = evidenceBudget();
  for await (const r of ledger.read(range)) { checkEvidenceRecord(r); selectedBudget.add(r); records.push(r); }
  const selectedIds = new Set(records.map(r => r.id));
  const keys = new Set(records.map(correlationKey));
  const sessions = new Set(records.map(agentSession).filter((s): s is string => s !== undefined));
  const heartbeatSessions = new Set<string>(), orphanIds = new Set<string>();
  const budget = evidenceBudget();
  const latest = evidenceMap<string, IntentEvidence>(budget);
  const precedingIntent = evidenceMap<string, IntentEvidence>(budget);
  const outcomes = evidenceMap<string, OutcomeEvidence>(budget);
  const handoffs = handoffScan();
  for (const r of records) handoffs.add(r);
  const from = Date.parse(range.from), through = Date.parse(extended);
  for await (const r of ledger.read({ from: "0100-01-01T00:00:00.000Z", to: "9999-12-31T23:59:59.999Z" })) {
    checkEvidenceRecord(r);
    const session = agentSession(r);
    if (session !== undefined && sessions.has(session) && isHeartbeat(r)) heartbeatSessions.add(session);
    const time = Date.parse(r.writtenAt);
    if (time > through) continue;
    if (time >= from) handoffs.observe(r);
    const key = correlationKey(r);
    if (!keys.has(key)) continue;
    if (r.phase === "intent" && !isHeartbeat(r)) latest.set(key, intentEvidence(r));
    else if (r.phase === "outcome") {
      const intent = latest.get(key);
      if (selectedIds.has(r.id)) {
        if (!intent) orphanIds.add(r.id); else precedingIntent.set(r.id, intent);
      }
      if (intent && selectedIds.has(intent.id)) outcomes.set(intent.id, { outcome: r.outcome });
    }
  }
  return { records, heartbeatSessions, handoffs: handoffs.unmatched(), orphanIds, precedingIntent, outcomes };
}
