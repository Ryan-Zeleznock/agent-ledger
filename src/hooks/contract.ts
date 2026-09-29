import type { AgentCredential, HookDecision, IncomingCall, Outcome } from "../types/index.js";
import { BUILTIN_NAMESPACE, BUILTIN_SERVER, RESERVED_SERVER_NAMES } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";

export { BUILTIN_NAMESPACE, BUILTIN_SERVER, RESERVED_SERVER_NAMES };

/**
 * Claude Code hook wire format. Field names are the documented ones, verified against
 * https://code.claude.com/docs/en/hooks on 2026-09-29 (spec §3). They stay snake_case on purpose: these types
 * describe someone else's JSON, and test/fixtures/claude-code-*.json pin them so drift shows up as a red test.
 */
export interface HookCommon {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: string;
  permission_mode?: "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | string;
  prompt_id?: string;
  scratchpad_dir?: string;
  /** Present when the hook fires inside a subagent. */
  agent_id?: string;
  agent_type?: string;
}
/**
 * Provenance of an MCP tool, present on tool events for MCP tools only (Claude Code ≥ 2.1.274). The docs say to
 * base trust on `source`, not on `name` or the `mcp__<server>__` prefix. We use it for one thing now: a tool
 * event that carries `mcp_server` is an MCP call even if its name lacks the prefix, and such a call is refused.
 */
export interface McpServerProvenance { name: string; source: string; }
export interface ToolEventFields {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  mcp_server?: McpServerProvenance;
}
export interface PreToolUseEvent extends HookCommon, ToolEventFields {
  hook_event_name: "PreToolUse";
}
export interface PostToolUseEvent extends HookCommon, ToolEventFields {
  hook_event_name: "PostToolUse";
  /** "object or string" in the docs; the Bash example is a plain string. */
  tool_response: unknown;
}
/**
 * Fires when a tool that STARTED executing fails (threw, or an MCP tool returned an error result). Not for
 * permission denials or validation rejections, which never reach PostToolUseFailure. Cannot block anything.
 */
export interface PostToolUseFailureEvent extends HookCommon, ToolEventFields {
  hook_event_name: "PostToolUseFailure";
  /** Tool-specific text. For Bash the first line is `Exit code N` when the command ran; treat the rest as display text. */
  error: string;
  /** True when the failure reached Claude Code as an abort rather than an error the tool reported. */
  is_interrupt?: boolean;
  /** Tool execution time, excluding permission prompts and PreToolUse hooks. */
  duration_ms?: number;
}
export type HookEvent = PreToolUseEvent | PostToolUseEvent | PostToolUseFailureEvent;
export const HOOK_EVENT_NAMES = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;

/** Claude Code names MCP tools `mcp__<server>__<tool>`; plugin servers appear as `mcp__plugin_<plugin>_<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp__";

/** Exact output shape for a PreToolUse decision. `defer` exists in the docs but we never emit it (types: HookDecision). */
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

/** Parses stdin. Throws on invalid JSON, a missing common or tool field, or a hook_event_name outside HOOK_EVENT_NAMES. */
export function parseHookInput(raw: string): HookEvent { throw notImplemented("hooks.parseHookInput"); }

/**
 * callId = tool_use_id (so the post events can find the intent record). args = tool_input (copied). receivedAt = now
 * (ISO 8601). The credential comes from the hook's own config (local mode), never from the event. server/tool:
 * - `mcp__...`: split at the FIRST `__` after the prefix into server and tool (the server part is kept verbatim,
 *   plugin form included). If the server segment, lowercased and stripped of everything outside [a-z0-9], is in
 *   RESERVED_SERVER_NAMES, throw: an MCP server is impersonating the built-in namespace. Under the supervisor a
 *   throw is a deny.
 * - no prefix but `mcp_server` present: throw (MCP provenance with a non-MCP name is malformed input).
 * - anything else is a built-in tool on BUILTIN_SERVER (`builtin:claude-code`). MCP can never produce a server
 *   containing `:` (see types), so `mcp__claude-code__Read` → server `claude-code`, which is not BUILTIN_SERVER.
 */
export function toIncomingCall(ev: PreToolUseEvent, credential: AgentCredential): IncomingCall { throw notImplemented("hooks.toIncomingCall"); }

/**
 * Maps a post event onto the outcome the pipeline records for `tool_use_id` (spec §6):
 * PostToolUse → { status: "ok" }; PostToolUseFailure → { status: "error", errorClass, durationMs: duration_ms }
 * where errorClass is "interrupt" when is_interrupt is true, else the `Exit code N` first line when present,
 * else "tool-error". The error text itself is not stored (it is display text and may carry secrets).
 */
export function toOutcome(ev: PostToolUseEvent | PostToolUseFailureEvent): Outcome { throw notImplemented("hooks.toOutcome"); }

/** Serialises a HookDecision as the PreToolUseOutput JSON (single line, printed to stdout with exit code 0). */
export function formatPreToolUseOutput(d: HookDecision): string { throw notImplemented("hooks.formatPreToolUseOutput"); }

// ---------- Fail-closed supervisor (spec §7) ----------
//
// Verified 2026-09-29 at https://code.claude.com/docs/en/hooks (#exit-code-output, #timeouts): for PreToolUse only
// exit 2 or a JSON `permissionDecision: "deny"` blocks. Exit 0 without a decision, exit 1 or any other code,
// unparseable stdout, a hook that reaches its `timeout`, and a hook that cannot start (exit 127) all let the tool
// call CONTINUE through the normal permission flow. So a crash inside our hook is an allow unless something catches
// it. The supervisor is that something.

/** What our settings snippet sets as the hook `timeout` (seconds). Claude Code's own default is 600 s, far too long to matter. */
export const HOOK_TIMEOUT_S = 30;
export const CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_S = 600;
/** Internal deadline: the hook timeout minus a margin, so our deny is written before Claude Code cancels us. */
export const DEFAULT_DEADLINE_MS = (HOOK_TIMEOUT_S - 5) * 1000;

export interface SupervisorOptions {
  /** Emit deny when the handler has not answered by then. Must be below the configured hook timeout. */
  deadlineMs: number;
}
export interface SupervisedOutput {
  /** Always a single-line PreToolUseOutput JSON: the handler's decision, or a deny. */
  stdout: string;
  /** The deny reason on the failure path, empty otherwise. Claude Code shows it as the blocking message on exit 2. */
  stderr: string;
  /** 0 with the handler's decision; 2 on every failure path, so the block holds even if stdout were lost. */
  exitCode: 0 | 2;
}
/**
 * Wraps one PreToolUse handler so that every internal failure is a deny. The supervised region covers reading and
 * parsing stdin, the handler, and serialisation. Outcomes:
 * - handler resolves → stdout = formatPreToolUseOutput(decision), exit 0;
 * - handler throws or rejects, stdin is malformed, or the output cannot be serialised → deny, exit 2;
 * - `deadlineMs` passes first → deny with reason `supervisor:deadline`, exit 2, before the hook timeout fires;
 * - unhandledRejection / uncaughtException inside the process → deny, exit 2.
 * It never throws and never lets the process exit 0 without a decision. Reasons are prefixed `supervisor:`.
 * Residual limits (documented in spec §7): a missing or non-executable hook binary, or a process killed by the OS,
 * produces no output at all and Claude Code continues; only managed settings + a health check cover that.
 */
export function runHookSupervised(handler: (stdin: string) => Promise<HookDecision>, opts: SupervisorOptions): Promise<SupervisedOutput> { throw notImplemented("hooks.runHookSupervised"); }
