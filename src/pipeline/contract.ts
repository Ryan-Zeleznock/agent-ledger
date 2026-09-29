import type { CallHandler } from "../types/index.js";
import type { Policy } from "../policy/contract.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { Upstream } from "../upstream/contract.js";
import type { ApprovalOptions } from "../approvals/contract.js";
import { notImplemented } from "../types/not-implemented.js";
export interface PipelineDeps { policy: Policy; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalOptions; }
export function createPipeline(deps: PipelineDeps): CallHandler { throw notImplemented("pipeline.createPipeline"); }
