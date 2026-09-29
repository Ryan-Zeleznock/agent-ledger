export type AgentId = string;
export type SessionId = string;

/** What an agent presents to prove who it is. Never stored: it appears only in IncomingCall. */
export interface AgentCredential { kind: "api_key" | "local"; value: string; }

/** A call as the front (or the hook collector) receives it: unauthenticated. The pipeline turns it into a ToolCall. */
export interface IncomingCall {
  callId: string; credential: AgentCredential;
  server: string; tool: string;
  args: Record<string, unknown>;
  receivedAt: string;
  onBehalfOf?: string; declaredPlan?: string;
}

/** An authenticated call. No credential here, so none can reach the ledger. */
export interface ToolCall {
  callId: string; sessionId: SessionId; agentId: AgentId;
  onBehalfOf?: string; declaredPlan?: string;
  server: string; tool: string;
  args: Record<string, unknown>;
  receivedAt: string;
}

export const VERDICTS = ["allow", "deny", "require_approval"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** The three reviewed classes, plus `unreviewed` for a tool the registry does not know (ADR-004). */
export const RISKS = ["read", "write", "risky", "unreviewed"] as const;
export type Risk = (typeof RISKS)[number];
export interface PolicyDecision { verdict: Verdict; ruleId: string; reason: string; risk: Risk; }

export interface ApprovalResult {
  callId: string;               // ties the approval to one call, so replay on another call is detectable
  decision: "approved" | "denied" | "timeout";
  approver?: string; decidedAt: string; channel: "slack";
}

/** Maps to draft-sharif-agent-audit-trail `record_phase`: intent = pre_execution, outcome = post_execution (spec §5). */
export type Phase = "intent" | "outcome";
export interface Outcome { status: "ok" | "error" | "blocked"; errorClass?: string; durationMs?: number; }

export interface LedgerRecord {
  id: string; phase: Phase; call: ToolCall;
  policy: PolicyDecision; approval?: ApprovalResult; outcome?: Outcome;
  /** Id of the previous record; null on the genesis record (draft-sharif `parent_record_id`). */
  parentRecordId: string | null;
  /** hash of the previous record; "0" on the genesis record (draft-sharif `prev_hash`, which uses null). */
  prevHash: string;
  /** SHA-256 hex over the RFC 8785 (JCS) canonical form of this record without `hash` (spec §5). */
  hash: string;
  writtenAt: string;
}
export type UnsealedRecord = Omit<LedgerRecord, "parentRecordId" | "prevHash" | "hash" | "writtenAt">;
export interface VerifyResult { ok: boolean; checked: number; brokenAt?: string; }

/**
 * MCP ToolAnnotations, field names verified against the 2026-07-28 schema on 2026-09-29. All four are HINTS:
 * the spec says clients MUST treat them as untrusted unless the server is trusted, so they only feed
 * `policy.suggestClass` for trusted servers and never decide anything (ADR-004).
 */
export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; }
export interface ToolInfo { server: string; name: string; description?: string; inputSchema?: unknown; annotations?: ToolAnnotations; }
export interface ToolResult { content: unknown; isError: boolean; }
export interface DateRange { from: string; to: string; }
export type CallHandler = (incoming: IncomingCall) => Promise<ToolResult>;

/**
 * What the pipeline answers in decide-only mode (hook collector). Maps 1:1 onto Claude Code's
 * `hookSpecificOutput.permissionDecision` (allow | deny | ask). The docs also define `defer`; we never emit it,
 * because an undecided call must fall to a human (`ask`), not to the agent's own permission flow.
 */
export const HOOK_DECISIONS = ["allow", "deny", "ask"] as const;
export interface HookDecision { decision: (typeof HOOK_DECISIONS)[number]; reason: string; callId: string; }
