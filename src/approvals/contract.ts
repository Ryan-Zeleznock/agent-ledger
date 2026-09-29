import type { ApprovalResult, PolicyDecision, ToolCall } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface ApprovalOptions { timeoutMs: number; channel: "slack"; }
export function requestApproval(call: ToolCall, decision: PolicyDecision, opts: ApprovalOptions): Promise<ApprovalResult> { throw notImplemented("approvals.requestApproval"); }
