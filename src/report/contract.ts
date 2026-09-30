import type { DateRange } from "../types/index.js";
import type { LedgerStore } from "../ledger/contract.js";
import { notImplemented } from "../types/not-implemented.js";
export interface ReportFiles { pdfPath: string; csvPath: string; }
export function generateReport(ledger: LedgerStore, range: DateRange, outDir: string): Promise<ReportFiles> { throw notImplemented("report.generateReport"); }

/**
 * Reconciliation of `handoff-to-proxy` records (Codex local mode, ADR-006, spec v2.1 §6/§7). Every hook intent record
 * carrying `handoff` must have a proxy intent record for the same `callId` (the proxy is the one that decided). A
 * handoff with no proxy record means the call was cancelled before the proxy saw it, an alias reached the hook but not
 * the proxy, or the proxy's ledger is missing records: each is flagged, never silently dropped. The report lists them
 * under "unreconciled handoffs" and the section is empty in a healthy range. Runs over the range plus `graceMs` after
 * its end, so a handoff at the boundary is not flagged for a proxy record written a moment later.
 */
export interface UnreconciledHandoff { callId: string; proxyServerName: string; hookRecordId: string; handedOffAt: string; }
export const HANDOFF_RECONCILE_GRACE_MS = 60_000;
export function reconcileHandoffs(ledger: LedgerStore, range: DateRange, graceMs?: number): Promise<UnreconciledHandoff[]> { throw notImplemented("report.reconcileHandoffs"); }
