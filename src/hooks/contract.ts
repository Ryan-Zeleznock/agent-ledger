import type { AgentCredential, HookDecision, IncomingCall } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";

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
export interface PreToolUseEvent extends HookCommon {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}
export interface PostToolUseEvent extends HookCommon {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  /** "object or string" in the docs; the Bash example is a plain string. */
  tool_response: unknown;
  tool_use_id: string;
}
export type HookEvent = PreToolUseEvent | PostToolUseEvent;

/** Server name we assign to Claude Code's built-in tools (Read, Edit, Bash, ...), which never touch MCP. */
export const BUILTIN_SERVER = "claude-code";
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

/** Parses stdin. Throws on invalid JSON, a missing common field, or an unsupported hook_event_name. */
export function parseHookInput(raw: string): HookEvent { throw notImplemented("hooks.parseHookInput"); }

/**
 * callId = tool_use_id (so PostToolUse can find the intent record). server/tool: a name starting with `mcp__` is
 * split at the FIRST `__` after the prefix into server and tool (the server part is kept verbatim, plugin form
 * included); any other name is a built-in tool on BUILTIN_SERVER. args = tool_input. receivedAt = now (ISO 8601).
 * The credential comes from the hook's own config (local mode), never from the event.
 */
export function toIncomingCall(ev: PreToolUseEvent, credential: AgentCredential): IncomingCall { throw notImplemented("hooks.toIncomingCall"); }

/** Serialises a HookDecision as the PreToolUseOutput JSON (single line, printed to stdout with exit code 0). */
export function formatPreToolUseOutput(d: HookDecision): string { throw notImplemented("hooks.formatPreToolUseOutput"); }
