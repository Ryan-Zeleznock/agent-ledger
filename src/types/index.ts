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

// ---------- Server identity: built-in tools live in a namespace MCP can never produce (spec §8) ----------

/**
 * Registry-key namespace for an agent runtime's built-in tools. The separator is `:`, which Claude Code strips
 * from every MCP callable name: `claude mcp add` accepts only `[A-Za-z0-9_-]` in a server name, and any other
 * character in a plugin or configured server name is replaced with `_` before the `mcp__<server>__<tool>`
 * name reaches a hook (https://code.claude.com/docs/en/mcp, read 2026-09-29). So no `mcp__...` tool name
 * can ever split into a server segment containing `:`, and `mcp__claude-code__Read` maps to server
 * `claude-code`, never to BUILTIN_SERVER.
 */
export const BUILTIN_NAMESPACE = "builtin:" as const;
/** Claude Code's own tools (Read, Edit, Bash, ...), as the hook collector names them. The only legal registry key with a `:`. */
export const BUILTIN_SERVER = "builtin:claude-code" as const;
/** What an MCP server name may look like in Claude Code. A registry key that is not BUILTIN_SERVER must match. */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
/**
 * Names that collide with the built-in namespace once normalised. Normalisation = lowercase, then drop every
 * character outside [a-z0-9]. `claude-code`, `Claude_Code`, `builtin_claude-code`, `builtin:claude-code` and
 * `mcp__builtin_claude-code__Bash`'s server segment all land here. The loader refuses such a key; the hook
 * collector refuses (throws → supervisor deny) a call whose MCP server segment normalises to one of them.
 */
export const RESERVED_SERVER_NAMES = ["claudecode", "builtinclaudecode"] as const;
/**
 * Object keys the registry loader refuses for servers and tools, on top of anything that is `in Object.prototype`.
 * Lookups use own properties only (`Object.hasOwn` or Map), so `github/constructor` is unreviewed, not a hit.
 */
export const RESERVED_KEYS = ["__proto__", "constructor", "prototype"] as const;

export const VERDICTS = ["allow", "deny", "require_approval"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** The three reviewed classes, plus `unreviewed` for a tool the registry does not know (ADR-004). */
export const RISKS = ["read", "write", "risky", "unreviewed"] as const;
export type Risk = (typeof RISKS)[number];
export interface PolicyDecision { verdict: Verdict; ruleId: string; reason: string; risk: Risk; }

/**
 * How a `require_approval` verdict reaches a human (spec §6, §7).
 * - `slack`: a channel exists; the pipeline waits up to `timeoutMs` for an answer. No answer → `timeout` → deny.
 *   Configured but unreachable (auth failure, network error, non-2xx) → `unavailable` → deny.
 * - `hook-ask`: local mode with no channel. The pipeline writes the intent record with `decision: "delegated"`
 *   and answers `ask`; Claude Code prompts the human in the terminal. The human's answer shows up as the
 *   outcome record (PostToolUse → ok, PostToolUseFailure → error, nothing → no outcome), never as `approved`.
 * Absent is not a state: `PipelineDeps.approvals` is required, so "no channel" must be said out loud.
 */
export type ApprovalChannel =
  | { kind: "slack"; channelId: string; timeoutMs: number }
  | { kind: "hook-ask" };
export const APPROVAL_DECISIONS = ["approved", "denied", "timeout", "unavailable", "delegated"] as const;
export interface ApprovalResult {
  callId: string;               // ties the approval to one call, so replay on another call is detectable
  /** approved | denied come from a human; timeout | unavailable mean deny; delegated only with channel hook-ask. */
  decision: (typeof APPROVAL_DECISIONS)[number];
  approver?: string; decidedAt: string; channel: ApprovalChannel["kind"];
}

/** Maps to draft-sharif-agent-audit-trail `record_phase`: intent = pre_execution, outcome = post_execution (spec §5). */
export type Phase = "intent" | "outcome";
export interface Outcome { status: "ok" | "error" | "blocked"; errorClass?: string; durationMs?: number; }

export interface LedgerRecord {
  id: string; phase: Phase; call: ToolCall;
  policy: PolicyDecision; approval?: ApprovalResult; outcome?: Outcome;
  /** Id of the previous record; null on the genesis record (draft-sharif `parent_record_id`). */
  parentRecordId: string | null;
  /**
   * Hash of the previous record; "0" on the genesis record. Conceptually the draft-sharif `prev_hash` (which uses
   * null), but NOT byte-compatible: the draft hashes the complete stored previous record, we hash it without its
   * own `hash` field and use our own field names (spec §5).
   */
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
