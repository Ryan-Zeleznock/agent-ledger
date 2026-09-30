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

/** The coding agents whose hooks the collector understands (spec §3; ADR-005 added Codex). */
export const HOOK_AGENTS = ["claude-code", "codex"] as const;
export type HookAgent = (typeof HOOK_AGENTS)[number];
/**
 * Registry-key namespace for an agent runtime's built-in tools. The separator is `:`, which neither agent lets
 * through to a hook's `mcp__<server>__<tool>` name (both verified 2026-09-29):
 * - Claude Code: `claude mcp add` accepts only `[A-Za-z0-9_-]` in a server name and any other character in a
 *   plugin or configured server name is replaced with `_` (https://code.claude.com/docs/en/mcp).
 * - Codex: `codex mcp add` accepts `[A-Za-z0-9_:@/.-]`, so `builtin:codex` IS a legal raw server name there, but
 *   the hook sees the model-visible name, built by `sanitize_responses_api_tool_name`, which keeps only ASCII
 *   alphanumerics and `_` and replaces everything else (`:` and even `-`) with `_`, then adds `mcp__`
 *   (codex-rs/codex-mcp/src/mcp/mod.rs, codex-rs/core/src/tools/handlers/mcp.rs). So `builtin:codex` arrives as
 *   `mcp__builtin_codex__<tool>`: server `builtin_codex`, which normalises to a RESERVED name and is refused.
 * So no `mcp__...` tool name from either agent can split into a server segment containing `:`.
 */
export const BUILTIN_NAMESPACE = "builtin:" as const;
/** One reserved key per agent: its built-in tools (Bash, Edit, apply_patch, ...), as that agent's hook names them. */
export const BUILTIN_SERVERS = { "claude-code": "builtin:claude-code", codex: "builtin:codex" } as const satisfies Record<HookAgent, `${typeof BUILTIN_NAMESPACE}${HookAgent}`>;
export const BUILTIN_SERVER_KEYS = [BUILTIN_SERVERS["claude-code"], BUILTIN_SERVERS.codex] as const;
export type BuiltinServer = (typeof BUILTIN_SERVER_KEYS)[number];
/** Claude Code's own tools (Read, Edit, Bash, ...). Kept as the short name; equals BUILTIN_SERVERS["claude-code"]. */
export const BUILTIN_SERVER = BUILTIN_SERVERS["claude-code"];
/** Codex's own tools (Bash, apply_patch, update_plan, ...). Equals BUILTIN_SERVERS.codex. */
export const BUILTIN_CODEX_SERVER = BUILTIN_SERVERS.codex;
/**
 * What an MCP server segment may look like in a hook's tool name. Claude Code: `[A-Za-z0-9_-]`; Codex: the subset
 * `[A-Za-z0-9_]` (its sanitiser turns `-` into `_`, so a Codex registry key is written the sanitised way, e.g.
 * `brave_search`). A registry key that is not in BUILTIN_SERVER_KEYS must match.
 */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
/**
 * Names that collide with a built-in namespace once normalised. Normalisation = lowercase, then drop every
 * character outside [a-z0-9]. `claude-code`, `Claude_Code`, `builtin_claude-code`, `codex`, `builtin_codex`,
 * `builtin:codex` and the server segment of `mcp__builtin_codex__Bash` all land here. The loader refuses such a
 * key; the hook collector refuses (throws → watchdog deny) a call whose MCP server segment normalises to one of
 * them, under EITHER agent (a Codex MCP server named `claude-code` is refused too, and vice versa).
 */
export const RESERVED_SERVER_NAMES = ["claudecode", "builtinclaudecode", "codex", "builtincodex"] as const;
/**
 * Object keys the registry loader refuses for servers and tools, on top of anything that is `in Object.prototype`.
 * Lookups use own properties only (`Object.hasOwn` or Map), so `github/constructor` is unreviewed, not a hit.
 */
export const RESERVED_KEYS = ["__proto__", "constructor", "prototype"] as const;

// ---------- Codex MCP identity: the Agent Ledger proxy is Codex's ONE MCP server (ADR-006) ----------

/**
 * Codex hook names are NOT unique MCP identities (Astra, 2026-09-29; verified in openai/codex
 * codex-rs/core/src/tools/handlers/mcp.rs `join_tool_name`: `namespace.trim_end_matches('_')` and
 * `name.trim_start_matches('_')` run AFTER sanitising and collision hashing, so servers `github_` and `github` with
 * tools `list_repos` and `_list_repos` both fire the hook as `mcp__github__list_repos`). So under Codex the hook never
 * allows an `mcp__*` call on the name's say-so. Instead every MCP server Codex uses is configured to go THROUGH the
 * Agent Ledger proxy, which appears to Codex as exactly one MCP server named `registry.proxy.codex.serverName`, sees
 * raw upstream identity, decides, and records. The hook's job for that server is to say `allow` with
 * `kind: "governed-by-proxy"` and write a small `handoff-to-proxy` intent record (callId + proxy server name, no
 * classification: `LedgerRecord.handoff`), which the report later reconciles against the proxy's own record for that
 * call (spec v2.1, Astra 2026-09-30: a call cancelled before the proxy sees it, or an alias, must still leave a trace).
 * Any other `mcp__*` server → deny.
 *
 * What the configured name must look like: Codex's hook-visible form, `[A-Za-z0-9_]` only (its sanitiser turns
 * everything else into `_`), no leading or trailing `_` (Codex trims those before the `__`, so a name ending in `_`
 * would never match itself), NO internal `__` (the hook name is split at the first `__` after `mcp__`, so
 * `a__b` would be read as server `a`, tool `b__<tool>`, and could never match itself either), at least
 * CODEX_PROXY_SERVER_NAME_MIN_LENGTH characters with a random suffix so it is not guessable, and not a reserved
 * builtin name. The RESIDUAL (local mode): a locally added server named e.g. `<name>_` (or `<name>-`) produces
 * identical hook names and would inherit the allow. The closer is Codex's managed `requirements.toml`
 * `mcp_servers` allowlist, which enables a server only when BOTH its name AND its identity (stdio `command`, or the
 * structured `executable` + `args` matcher; HTTP `url`) match, and disables everything else (spec §7, §8).
 */
export const CODEX_PROXY_SERVER_NAME_RE = /^[A-Za-z0-9](?!.*__)[A-Za-z0-9_]*[A-Za-z0-9]$/;
export const CODEX_PROXY_SERVER_NAME_MIN_LENGTH = 16;
/** What the Codex hook answers for an `mcp__*` server that is not the proxy. Approval cannot fix it; configuration can. */
export const CODEX_MCP_NOT_PROXIED_REASON =
  "agent-ledger: route this MCP server through the Agent Ledger proxy. Under Codex, hook tool names are not unique MCP identities, so only calls that reach the proxy (configured as Codex's single MCP server) are governed; add the server as an upstream of the proxy." as const;

export const VERDICTS = ["allow", "deny", "require_approval"] as const;
export type Verdict = (typeof VERDICTS)[number];
/** The three reviewed classes, plus `unreviewed` for a tool the registry does not know (ADR-004). */
export const RISKS = ["read", "write", "risky", "unreviewed"] as const;
export type Risk = (typeof RISKS)[number];
export interface PolicyDecision { verdict: Verdict; ruleId: string; reason: string; risk: Risk; }

/**
 * Where a secret VALUE lives. Config, records and logs carry only this reference; `secrets` resolves it at init
 * (env var name, or a file path) and hands the value to exactly one consumer. Never store or hash the value.
 */
export type SecretRef = { kind: "env"; name: string } | { kind: "file"; path: string };

/**
 * How a `require_approval` verdict reaches a human (spec §6, §7; ADR-006).
 * - `slack`: a Slack app in **Socket Mode** (verified 2026-09-29, https://docs.slack.dev/apis/events-api/using-socket-mode/:
 *   "use the Events API and interactive features — without exposing a public HTTP Request URL"; interactive payloads
 *   arrive over the WebSocket; each envelope is acknowledged by `envelope_id`). `botToken` is the `xoxb-` token
 *   (scope `chat:write`, plus `chat:write.public` when the bot is not a channel member) used for `chat.postMessage` and
 *   `chat.update`; `appToken` is the `xapp-` app-level token (scope `connections:write`) used for
 *   `apps.connections.open`. `approvers` is the allowlist of Slack user ids (`block_actions.user.id`) whose clicks
 *   count; anyone else's click is ignored and answered in-thread. The pipeline waits up to `timeoutMs`: no answer →
 *   `timeout` → deny. Configured but unreachable (auth failure, WebSocket never opens, non-ok API reply) →
 *   `unavailable` → deny. Required under Codex for any `require_approval` to ever become an allow.
 * - `hook-ask`: local mode with no channel. Claude Code: the pipeline writes the intent record with
 *   `decision: "delegated"` and answers `ask`; Claude Code prompts the human in the terminal, and the answer shows up
 *   as the outcome record (PostToolUse → ok, PostToolUseFailure → error, nothing → no outcome), never as `approved`.
 *   Codex cannot ask, so under Codex `hook-ask` resolves to `decision: "no-channel"` → deny, RECORDED as the final
 *   decision before anything is persisted (nothing is left as a dangling `delegated`).
 * Absent is not a state: `PipelineDeps.approvals` is required, so "no channel" must be said out loud.
 */
export type ApprovalChannel =
  | {
      kind: "slack";
      channelId: string;            // Slack channel id (C…), never a name
      timeoutMs: number;            // how long a human has; must sit below the watchdog deadline (hooks: APPROVAL_MIN_MARGIN_MS)
      transport: "socket-mode";     // the only transport we specify: the homelab has no public Request URL
      botToken: SecretRef;          // xoxb-…  chat:write (+ chat:write.public)
      appToken: SecretRef;          // xapp-…  connections:write
      approvers: readonly string[]; // Slack user ids allowed to approve or deny; must be non-empty
    }
  | { kind: "hook-ask" };
/**
 * The FINAL decision on a require_approval verdict, as the intent record stores it. approved | denied come from a
 * human (with `approver`); timeout | unavailable mean deny; `no-channel` means deny because the agent cannot ask and
 * no Slack channel is configured (Codex + hook-ask); `delegated` exists only under Claude Code hook-ask, where the
 * terminal prompt decides after us. Only `approved` can become an allow.
 */
export const APPROVAL_DECISIONS = ["approved", "denied", "timeout", "unavailable", "no-channel", "delegated"] as const;
export interface ApprovalResult {
  callId: string;               // ties the approval to one call, so replay on another call is detectable
  decision: (typeof APPROVAL_DECISIONS)[number];
  /** Slack user id of the human who clicked (approved | denied only). Never a display name. */
  approver?: string;
  /** Why this decision: the approver's note, "no approver answered within N ms", "Slack unreachable: …", "Codex cannot ask and no Slack channel is configured". Stored. */
  reason?: string;
  decidedAt: string; channel: ApprovalChannel["kind"];
}

/** Maps to draft-sharif-agent-audit-trail `record_phase`: intent = pre_execution, outcome = post_execution (spec §5). */
export type Phase = "intent" | "outcome";
export interface Outcome { status: "ok" | "error" | "blocked"; errorClass?: string; durationMs?: number; }

/**
 * Present only on the hook's `handoff-to-proxy` intent record (Codex, ADR-006, spec v2.1): the hook saw a call for the
 * proxy's tool and handed the decision to the proxy without classifying it. `policy` on such a record is
 * `{ verdict: "allow", risk: "unreviewed", ruleId: "handoff-to-proxy:<proxyServerName>", reason: HANDOFF_TO_PROXY_REASON }`.
 * The report reconciles every handoff with the proxy's record for the same callId and flags the ones with none.
 */
export interface ProxyHandoff { kind: "to-proxy"; proxyServerName: string; }
export const HANDOFF_TO_PROXY_RULE_PREFIX = "handoff-to-proxy:" as const;
export const HANDOFF_TO_PROXY_REASON = "agent-ledger: tool of the Agent Ledger proxy; the proxy decides and records this call with raw upstream identity" as const;

export interface LedgerRecord {
  id: string; phase: Phase; call: ToolCall;
  policy: PolicyDecision; approval?: ApprovalResult; outcome?: Outcome;
  /** Only on a `handoff-to-proxy` intent record (hook, Codex). Absent everywhere else. */
  handoff?: ProxyHandoff;
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
/**
 * `decided`: the pipeline classified the call against the registry and wrote (or tried to write) the intent record.
 * `governed-by-proxy` (Codex only, ADR-006): the call is a tool of the Agent Ledger proxy, Codex's one MCP server; the
 * proxy makes the real decision with raw upstream identity and records it, so the hook answers `allow` and writes
 * only a `handoff-to-proxy` intent record (`LedgerRecord.handoff`; no classification, no double-counting of the
 * decision). Never used for a built-in tool and never under Claude Code.
 */
export const HOOK_DECISION_KINDS = ["decided", "governed-by-proxy"] as const;
export type HookDecisionKind = (typeof HOOK_DECISION_KINDS)[number];
export interface HookDecision { decision: (typeof HOOK_DECISIONS)[number]; reason: string; callId: string; kind: HookDecisionKind; }
