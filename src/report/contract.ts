import { handoffScan } from "./history.js";
import { checkEvidenceRecord } from "./limits.js";
import type { DateRange } from "../types/index.js";
import type { LedgerStore } from "../ledger/contract.js";
import { checkedRange, renderReport, HANDOFF_RECONCILE_GRACE_MS } from "./render.js";
export interface ReportFiles { pdfPath: string; csvPath: string; }
export type AnchorStatus = "head" | "ancestor" | "missing" | "mismatch" | "untrusted";
export interface ReportContext { anchor?: { status: AnchorStatus; latest: { hash: string; at: string } | null } }
export function generateReport(ledger: LedgerStore, range: DateRange, outDir: string, context?: ReportContext): Promise<ReportFiles> { return renderReport(ledger, range, outDir, context); }

/**
 * Reconciliation of `handoff-to-proxy` records (Codex local mode, ADR-006, spec v2.1 §6/§7). Every hook intent record
 * carrying `handoff` must have a proxy intent record for the same `callId` (the proxy is the one that decided). A
 * handoff with no proxy record means the call was cancelled before the proxy saw it, an alias reached the hook but not
 * the proxy, or the proxy's ledger is missing records: each is flagged, never silently dropped. The report lists them
 * under "unreconciled handoffs" and the section is empty in a healthy range. Runs over the range plus `graceMs` after
 * its end, so a handoff at the boundary is not flagged for a proxy record written a moment later.
 */
export interface UnreconciledHandoff { callId: string; proxyServerName: string; hookRecordId: string; handedOffAt: string; }
export { HANDOFF_RECONCILE_GRACE_MS } from "./render.js";
export async function reconcileHandoffs(ledger: LedgerStore, range: DateRange, graceMs = HANDOFF_RECONCILE_GRACE_MS): Promise<UnreconciledHandoff[]> {
  const { extended } = checkedRange(range, graceMs);
  const before = await ledger.head();
  const scan = handoffScan();
  for await (const record of ledger.read(range)) { checkEvidenceRecord(record); scan.add(record); }
  for await (const record of ledger.read({ from: range.from, to: extended })) { checkEvidenceRecord(record); scan.observe(record); }
  if (await ledger.head() !== before) throw new Error("Ledger changed during reconciliation; retry with writers paused");
  return scan.unmatched();
}
