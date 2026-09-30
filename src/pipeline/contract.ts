import type { ApprovalChannel, CallHandler, HookAgent, HookDecision, IncomingCall, Outcome } from "../types/index.js";
import type { IdentityService } from "../identity/contract.js";
import type { ToolRegistry } from "../policy/contract.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { Upstream } from "../upstream/contract.js";
import { notImplemented } from "../types/not-implemented.js";

/**
 * `registry` is the reviewed tool registry (ADR-004); the pipeline never sees the suggestion rules.
 * `approvals` is required and a union: `{ kind: "slack", ... }` asks in Slack; `{ kind: "hook-ask" }` (local mode,
 * no channel) hands `require_approval` back to Claude Code as `ask`, and under Codex resolves to a recorded
 * `no-channel` deny. Proxy mode with `hook-ask` is a config error: there is no terminal to ask in, so `createPipeline`
 * refuses it when `handle` would be used.
 * `hookAgent` is set in decide-only mode from the hook's own configuration (never from the event) and selects the
 * Codex rules below; absent means proxy mode (`handle`), where MCP identity is raw and the registry is the authority.
 */
export interface PipelineDeps { identity: IdentityService; registry: ToolRegistry; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalChannel; hookAgent?: HookAgent; }

export interface Pipeline {
  /**
   * Proxy mode (MCP front). Identity → policy → approval → intent record → upstream.execute → outcome record.
   * Builds the ToolCall by explicit field projection (callId, sessionId, agentId, onBehalfOf, declaredPlan, server,
   * tool, args, receivedAt). Never spread the IncomingCall: that keeps `credential` on the object at runtime.
   * Registry lookups are own-property only (`Object.hasOwn`): `github/constructor` is unreviewed, not a hit.
   * The proxy refuses an upstream that is not on its configured allowlist (spec §9) before any of this runs.
   */
  handle: CallHandler;
  /**
   * Decide-only mode (hook collector). Same steps up to and including the intent record, then STOPS: nothing is
   * executed, because the agent runtime runs the tool itself after reading our answer.
   *
   * The approval channel is resolved BEFORE the intent record is persisted, so the record carries the FINAL decision:
   * - verdict allow → `allow`, kind `decided`;
   * - verdict deny → `deny`;
   * - require_approval + slack → `approvals.requestApproval` first; the intent record then carries `approved` (with
   *   approver and reason) or `denied` / `timeout` / `unavailable`; `allow` is returned only for `approved` AND only
   *   after the append succeeded (a failed append is a deny, spec §7);
   * - require_approval + hook-ask under Claude Code → intent record with `delegated`, answer `ask`;
   * - require_approval + hook-ask under Codex → intent record with `no-channel` and its reason, a `blocked` outcome
   *   record, answer `deny`. Nothing is ever left as a dangling `delegated` under Codex.
   *
   * Codex MCP identity (ADR-006), applied before the registry is consulted, for any IncomingCall whose server is not
   * a `builtin:*` key while `hookAgent === "codex"`:
   * - `server === registry.proxy.codex.serverName` → return `{ decision: "allow", kind: "governed-by-proxy" }` and
   *   write NO record: the proxy has already decided and recorded this call with raw upstream identity;
   * - anything else → intent record with `policy: { verdict: "deny", risk: "unreviewed", ruleId:
   *   "codex-mcp-not-proxied:<server>/<tool>", reason: CODEX_MCP_NOT_PROXIED_REASON }`, a `blocked` outcome record,
   *   answer `deny`. A registry row for that server name changes nothing: hook names are not identities under Codex.
   * Under Claude Code, MCP hook names are consulted against the registry as before (its `mcp_server.source`
   * provenance is the trust anchor there, per its docs).
   */
  decide(incoming: IncomingCall): Promise<HookDecision>;
  /**
   * Decide-only mode, second half: PostToolUse (status ok) or PostToolUseFailure (status error) reports what
   * happened; the pipeline appends the outcome record for `callId`. An unknown callId is an orphan outcome, kept
   * (a `governed-by-proxy` call has no hook intent record by design; its outcome arrives through the proxy).
   */
  recordOutcome(callId: string, outcome: Outcome): Promise<void>;
}

/**
 * Refuses (throws) at construction on: `hook-ask` in proxy mode; `hookAgent: "codex"` with a `slack` channel whose
 * `timeoutMs` breaks `hooks.validateHookTiming` against WATCHDOG_DEADLINE_ENV; a `slack` channel that fails
 * `approvals.validateSlackChannel`. In the hook handler every such throw is an init failure → watchdog deny, exit 2.
 */
export function createPipeline(deps: PipelineDeps): Pipeline { throw notImplemented("pipeline.createPipeline"); }
