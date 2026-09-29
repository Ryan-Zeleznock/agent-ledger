import type { ApprovalChannel, CallHandler, HookDecision, IncomingCall, Outcome } from "../types/index.js";
import type { IdentityService } from "../identity/contract.js";
import type { ToolRegistry } from "../policy/contract.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { Upstream } from "../upstream/contract.js";
import { notImplemented } from "../types/not-implemented.js";

/**
 * `registry` is the reviewed tool registry (ADR-004); the pipeline never sees the suggestion rules.
 * `approvals` is required and a union: `{ kind: "slack", ... }` asks in Slack; `{ kind: "hook-ask" }` (local mode,
 * no channel) hands `require_approval` back to Claude Code as `ask`. Proxy mode with `hook-ask` is a config error:
 * there is no terminal to ask in, so `createPipeline` refuses it when `handle` would be used.
 */
export interface PipelineDeps { identity: IdentityService; registry: ToolRegistry; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalChannel; }

export interface Pipeline {
  /**
   * Proxy mode (MCP front). Identity → policy → approval → intent record → upstream.execute → outcome record.
   * Builds the ToolCall by explicit field projection (callId, sessionId, agentId, onBehalfOf, declaredPlan, server,
   * tool, args, receivedAt). Never spread the IncomingCall: that keeps `credential` on the object at runtime.
   * Registry lookups are own-property only (`Object.hasOwn`): `github/constructor` is unreviewed, not a hit.
   */
  handle: CallHandler;
  /**
   * Decide-only mode (hook collector). Same steps up to and including the intent record, then STOPS: nothing is
   * executed, because the agent runtime (Claude Code) runs the tool itself after reading our answer.
   * allow ↔ verdict allow, or an approval `approved` AFTER the intent record carrying it has persisted (a failed
   * append is a deny, spec §7); deny ↔ verdict deny, approval denied, timeout, or unavailable; ask ↔
   * require_approval with `approvals.kind === "hook-ask"` (intent record written with `decision: "delegated"`).
   */
  decide(incoming: IncomingCall): Promise<HookDecision>;
  /**
   * Decide-only mode, second half: PostToolUse (status ok) or PostToolUseFailure (status error) reports what
   * happened; the pipeline appends the outcome record for `callId`. An unknown callId is an orphan outcome, kept.
   */
  recordOutcome(callId: string, outcome: Outcome): Promise<void>;
}

export function createPipeline(deps: PipelineDeps): Pipeline { throw notImplemented("pipeline.createPipeline"); }
