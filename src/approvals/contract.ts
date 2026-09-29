import type { ApprovalChannel, ApprovalResult, PolicyDecision, ToolCall } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";

export type { ApprovalChannel };
/** The only channel that actually asks anyone: `hook-ask` is handled inside the pipeline and never reaches this module. */
export type SlackChannel = Extract<ApprovalChannel, { kind: "slack" }>;

/**
 * Posts the call to Slack and waits up to `channel.timeoutMs`. Resolves, never rejects:
 * approved | denied from a human (with `approver`), `timeout` when nobody answered, `unavailable` when Slack could
 * not be reached or answered with an error. The pipeline treats timeout and unavailable as deny (spec §7).
 */
export function requestApproval(call: ToolCall, decision: PolicyDecision, channel: SlackChannel): Promise<ApprovalResult> { throw notImplemented("approvals.requestApproval"); }
