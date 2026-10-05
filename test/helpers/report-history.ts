import type { LedgerStore } from "../../src/ledger/contract.js";
import type { LedgerRecord } from "../../src/types/index.js";
import { sealedWithoutHash } from "./ledger-fixtures.js";

export const historyRange = { from: "2026-09-30T12:00:00Z", to: "2026-09-30T13:00:00Z" };
const before = "2026-09-29T12:00:00Z", grace = "2026-09-30T13:00:30Z";
function record(id: string, at: string): LedgerRecord {
  const r = { ...sealedWithoutHash(0), id, hash: "a".repeat(64), writtenAt: at };
  r.call = { ...r.call, callId: id, agentSessionId: `session-${id}` };
  return r;
}
function heartbeat(session: string, at: string): LedgerRecord {
  const r = record(`heartbeat-${session}`, at);
  r.call.agentSessionId = session; r.call.tool = "SessionStart";
  r.policy.ruleId = "heartbeat:session-start";
  return r;
}
/** Generates fresh, unrelated records; no array can hide a report's retained-history cost. */
export function historyStore(noise = 50_000, sample?: () => void): LedgerStore {
  const prior = record("prior", before); prior.policy = { verdict: "deny", risk: "risky", ruleId: "deny", reason: "denied" };
  const selectedOutcome = { ...prior, id: "selected-outcome", phase: "outcome" as const, writtenAt: historyRange.from, outcome: { status: "ok" as const } };
  const selectedIntent = record("selected-intent", historyRange.from);
  selectedIntent.policy = { verdict: "require_approval", risk: "risky", ruleId: "ask", reason: "ask" };
  const handoff = record("selected-handoff", historyRange.to);
  handoff.call.server = "agentledger_proxy_1234";
  handoff.handoff = { kind: "to-proxy", proxyServerName: handoff.call.server };
  const proxy = record("proxy", grace); proxy.call.callId = handoff.call.callId; proxy.call.server = "github";
  const laterOutcome = { ...selectedIntent, id: "grace-outcome", phase: "outcome" as const, writtenAt: grace, outcome: { status: "ok" as const } };
  async function* source() {
    yield prior; yield heartbeat(prior.call.agentSessionId!, before);
    for (let i = 0; i < noise; i++) {
      if (i === Math.floor(noise / 2)) { yield selectedOutcome; yield selectedIntent; yield handoff; }
      const r = record(`noise-${i}`, i < noise / 2 ? before : grace);
      r.call.args = { text: `${i}:` + "sample text ".repeat(200) };
      yield r;
      if (i % 2048 === 0) sample?.();
    }
    yield proxy; yield laterOutcome;
    yield heartbeat(selectedIntent.call.agentSessionId!, "2026-10-01T12:00:00Z");
  }
  return {
    append: async () => { throw new Error("read-only fixture"); }, head: async () => "a".repeat(64),
    verify: async () => ({ ok: true, checked: noise + 8 }),
    async *read(range) {
      const from = Date.parse(range.from), to = Date.parse(range.to);
      for await (const r of source()) { const time = Date.parse(r.writtenAt); if (time >= from && time <= to) yield r; }
    },
  };
}
