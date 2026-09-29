import type { DateRange } from "../types/index.js";
import type { LedgerStore } from "../ledger/contract.js";
import { notImplemented } from "../types/not-implemented.js";
export interface ReportFiles { pdfPath: string; csvPath: string; }
export function generateReport(ledger: LedgerStore, range: DateRange, outDir: string): Promise<ReportFiles> { throw notImplemented("report.generateReport"); }
