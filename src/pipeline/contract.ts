import type { CallHandler, HookDecision, IncomingCall, Outcome } from "../types/index.js";
import type { IdentityService } from "../identity/contract.js";
import type { ToolRegistry } from "../policy/contract.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { Upstream } from "../upstream/contract.js";
import type { ApprovalOptions } from "../approvals/contract.js";
import { notImplemented } from "../types/not-implemented.js";

/** `registry` is the reviewed tool registry (ADR-004); the pipeline never sees the suggestion rules. */
export interface PipelineDeps { identity: IdentityService; registry: ToolRegistry; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalOptions; }

export interface Pipeline {
  /**
   * Proxy mode (MCP front). Identity → policy → approval → intent record → upstream.execute → outcome record.
   * Builds the ToolCall by explicit field projection (callId, sessionId, agentId, onBehalfOf, declaredPlan, server,
   * tool, args, receivedAt). Never spread the IncomingCall: that keeps `credential` on the object at runtime.
   */
  handle: CallHandler;
  /**
   * Decide-only mode (hook collector). Same steps up to and including the intent record, then STOPS: nothing is
   * executed, because the agent runtime (Claude Code) runs the tool itself after reading our answer.
   * allow ↔ verdict allow; deny ↔ verdict deny, an approval denied, or a timeout; ask ↔ require_approval when no
   * approval channel is configured. The intent record is written before the answer is returned (spec §6).
   */
  decide(incoming: IncomingCall): Promise<HookDecision>;
  /** Decide-only mode, second half: the PostToolUse hook reports what happened; the pipeline appends the outcome record for `callId`. */
  recordOutcome(callId: string, outcome: Outcome): Promise<void>;
}

export function createPipeline(deps: PipelineDeps): Pipeline { throw notImplemented("pipeline.createPipeline"); }
