import type { AgentCredential, HookAgent, HookDecision, IncomingCall, Outcome } from "../types/index.js";
import { BUILTIN_CODEX_SERVER, BUILTIN_NAMESPACE, BUILTIN_SERVER, BUILTIN_SERVERS, HOOK_AGENTS, RESERVED_SERVER_NAMES } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";

export { BUILTIN_CODEX_SERVER, BUILTIN_NAMESPACE, BUILTIN_SERVER, BUILTIN_SERVERS, HOOK_AGENTS, RESERVED_SERVER_NAMES };

// One module, two agents, one `agent` discriminator. Both agents send one JSON object on stdin with the same core
// fields (`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`) and accept the same
// `hookSpecificOutput.permissionDecision` block, so the collector is one code path with an `agent` argument and
// two sets of wire types; a separate codex.ts would duplicate the naming rule and the output shape and make the
// test tables diverge. Where the agents differ (Codex: `model`/`turn_id` required, `transcript_path` nullable,
// `tool_input` any JSON, no PostToolUseFailure, no `ask`), the difference lives in the Codex types and in the
// documented behaviour of the three functions below. Verified 2026-09-29; sources on each type.

// ---------- Claude Code wire format ----------

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

// ---------- Codex wire format (ADR-005) ----------

/**
 * Codex hook wire format, verified 2026-09-29 against https://learn.chatgpt.com/docs/hooks ("Common input fields",
 * "PreToolUse", "PostToolUse") and the generated JSON schemas at
 * https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated (pre-tool-use / post-tool-use
 * .command.input.schema.json, `additionalProperties: false`). Differences from Claude Code, all pinned by
 * test/fixtures/codex-*.json: `model` and `turn_id` are REQUIRED Codex extensions; `transcript_path` may be null;
 * `permission_mode` is required and has no `auto`; there is no `prompt_id`, `scratchpad_dir` or `mcp_server`;
 * `tool_input` is "any JSON value" in the schema; and there is NO PostToolUseFailure event (PostToolUse "also runs
 * after commands that exit with a non-zero status").
 */
export interface CodexHookCommon {
  session_id: string;
  transcript_path: string | null;
  cwd: string;
  hook_event_name: string;
  /** Codex-specific extension: the active model slug. */
  model: string;
  permission_mode: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";
  /** Codex-specific extension: the active turn id. Present on every tool event. */
  turn_id: string;
  /** Present when the hook fires inside a subagent. */
  agent_id?: string;
  agent_type?: string;
}
export interface CodexToolEventFields {
  /**
   * Canonical hook tool name: `Bash` (shell and unified `exec_command`), `apply_patch` (file edits; `Edit`/`Write` are
   * matcher aliases only, the input still says `apply_patch`), `spawn_agent` (alias `Agent`), other local function
   * tools by name (`update_plan`), or `mcp__<server>__<tool>` with both segments sanitised to `[A-Za-z0-9_]`.
   * Hosted tools such as `WebSearch` never reach hooks.
   */
  tool_name: string;
  /** "JSON value" in the schema. `Bash`/`apply_patch` send `{ command }`; MCP tools send their arguments object. */
  tool_input: unknown;
  tool_use_id: string;
}
export interface CodexPreToolUseEvent extends CodexHookCommon, CodexToolEventFields {
  hook_event_name: "PreToolUse";
}
export interface CodexPostToolUseEvent extends CodexHookCommon, CodexToolEventFields {
  hook_event_name: "PostToolUse";
  /** "JSON value": MCP tools send the MCP call result; other tools their model-facing output. Format not stable. */
  tool_response: unknown;
}
export type CodexHookEvent = CodexPreToolUseEvent | CodexPostToolUseEvent;
/** Codex has no failure event: a failed Bash command still arrives as PostToolUse (verified 2026-09-29). */
export const CODEX_HOOK_EVENT_NAMES = ["PreToolUse", "PostToolUse"] as const;
/** PermissionRequest exists in Codex too (allow/deny an approval prompt via a `decision` object) but it has no `tool_use_id`, so we do not consume it. */
export const CODEX_UNUSED_EVENTS = ["PermissionRequest"] as const;

export type AnyHookEvent = HookEvent | CodexHookEvent;
export type AnyPreToolUseEvent = PreToolUseEvent | CodexPreToolUseEvent;
export type AnyPostEvent = PostToolUseEvent | PostToolUseFailureEvent | CodexPostToolUseEvent;

/** Both agents name MCP tools `mcp__<server>__<tool>`; Claude Code plugin servers appear as `mcp__plugin_<plugin>_<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Exact output shape for a PreToolUse decision, identical for both agents (Claude Code docs; Codex
 * pre-tool-use.command.output.schema.json, where `hookSpecificOutput` has `additionalProperties: false`). `defer`
 * exists in Claude Code but we never emit it (types: HookDecision). `ask` is emitted for Claude Code only: Codex
 * documents `permissionDecision: "ask"` as "parsed but not supported yet. Codex marks the hook run as failed,
 * reports the error, and continues the tool call", i.e. an `ask` sent to Codex is an ALLOW. See formatPreToolUseOutput.
 */
export interface PreToolUseOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

/**
 * Parses stdin for the given agent. Throws (→ watchdog deny) on invalid JSON, a non-object, a missing required field
 * for that agent (Codex adds `model`, `turn_id`, `permission_mode`; `transcript_path` may be null there and only there),
 * or a `hook_event_name` outside HOOK_EVENT_NAMES / CODEX_HOOK_EVENT_NAMES. Never accepts one agent's event for the other.
 */
export function parseHookInput(raw: string, agent: "claude-code"): HookEvent;
export function parseHookInput(raw: string, agent: "codex"): CodexHookEvent;
export function parseHookInput(raw: string, agent: HookAgent): AnyHookEvent;
export function parseHookInput(raw: string, agent: HookAgent): AnyHookEvent { throw notImplemented("hooks.parseHookInput"); }

/**
 * callId = tool_use_id (so the post events can find the intent record). args = tool_input (copied). receivedAt = now
 * (ISO 8601). The credential comes from the hook's own config (local mode), never from the event. server/tool:
 * - `mcp__...`: split at the FIRST `__` after the prefix into server and tool (the server part is kept verbatim,
 *   plugin form included). If the server segment, lowercased and stripped of everything outside [a-z0-9], is in
 *   RESERVED_SERVER_NAMES, throw: an MCP server is impersonating a built-in namespace (either agent's).
 * - Claude Code only: no prefix but `mcp_server` present → throw (MCP provenance with a non-MCP name is malformed).
 * - anything else is a built-in tool on BUILTIN_SERVERS[agent]: `builtin:claude-code` or `builtin:codex`. Neither
 *   agent can produce a `:` in an MCP server segment (see types), so these keys are unreachable from MCP.
 * - Codex only: `tool_input` that is not a plain object (null, array, string, number) → throw. Every documented Codex
 *   tool sends an object; anything else is unknown ground and a deny is the fail-closed answer.
 */
export function toIncomingCall(ev: AnyPreToolUseEvent, credential: AgentCredential, agent: HookAgent): IncomingCall { throw notImplemented("hooks.toIncomingCall"); }

/**
 * Maps a post event onto the outcome the pipeline records for `tool_use_id` (spec §6).
 * Claude Code: PostToolUse → { status: "ok" }; PostToolUseFailure → { status: "error", errorClass, durationMs: duration_ms }
 * where errorClass is "interrupt" when is_interrupt is true, else the `Exit code N` first line when present, else
 * "tool-error". The error text itself is not stored (it is display text and may carry secrets).
 * Codex: PostToolUse → { status: "ok" } ALWAYS, and "ok" there means "the tool ran and returned", not "succeeded":
 * Codex has no failure event and `tool_response` has no stable shape to read an exit code from. Deriving an
 * errorClass from `tool_response` is future work and is recorded as such in spec §6.
 */
export function toOutcome(ev: AnyPostEvent, agent: HookAgent): Outcome { throw notImplemented("hooks.toOutcome"); }

/** Reason text the Codex formatter substitutes when the pipeline answers `ask` (see formatPreToolUseOutput). */
export const CODEX_ASK_UNSUPPORTED_REASON =
  "agent-ledger: this tool requires human approval, and Codex hooks cannot prompt (permissionDecision \"ask\" is unsupported and would let the call through). Approve it out of band (Slack channel) or have a reviewer add the tool to the registry, then retry." as const;

/**
 * Serialises a HookDecision as one line of PreToolUseOutput JSON (the watchdog prints it with exit 0 for allow/ask and
 * exit 2 for deny, §7). Claude Code: decision copied as is. Codex: `ask` becomes `deny` with
 * CODEX_ASK_UNSUPPORTED_REASON, because Codex treats `ask` as a failed hook and CONTINUES the tool call (verified
 * 2026-09-29). The pipeline still writes the intent record with `approval.decision = "delegated"` before this
 * runs, so the ledger shows "asked, denied by adapter"; a Slack channel is the way to get a real approval under Codex.
 */
export function formatPreToolUseOutput(d: HookDecision, agent: HookAgent): string { throw notImplemented("hooks.formatPreToolUseOutput"); }

// ---------- Two-process fail-closed watchdog (spec §7) ----------
//
// Verified 2026-09-29. Claude Code (https://code.claude.com/docs/en/hooks #exit-code-2, #other-exit-codes,
// #timeouts, #json-output): "exit 2 blocks whether or not you print JSON: even a JSON permissionDecision of
// "allow" can't override it"; the blocking message is the JSON deny reason when there is one, else stderr, and
// Claude sees it; exit 0 without a decision, exit 1 or any other code, unparseable or schema-failing stdout, a hook
// that reaches its `timeout`, and a hook that cannot start (exit 127) all let the tool call CONTINUE. Stdout is
// read as JSON only when it starts with `{` and ends with `}`; two JSON lines are a parse failure; plain stdout is
// capped at 10,000 characters and spilled to a file above that. Codex (https://learn.chatgpt.com/docs/hooks
// #pretooluse): "You can also use exit code 2 and write the blocking reason to stderr"; unsupported output fields
// mark the hook failed and the call continues; a non-zero exit is "a hook failure" [H: not stated for PreToolUse,
// inferred]; a timed-out hook renders no decision [H]. Whether Codex reads JSON on exit 2 is not documented, so
// every deny we emit carries BOTH the deny JSON and exit 2, which blocks under either reading.
//
// So a crash, stall, or stray write inside our handler is an allow unless something outside the handler's event
// loop catches it. That something is a second process.

/** What our settings snippet sets as the hook `timeout` (seconds) for both agents. Their own default is 600 s, far too long to matter. */
export const HOOK_TIMEOUT_S = 30;
export const CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_S = 600;
export const CODEX_DEFAULT_HOOK_TIMEOUT_S = 600;
/** The watchdog must have emitted its verdict at least this long before the agent's timeout cancels it. */
export const WATCHDOG_MIN_MARGIN_MS = 2_000;
/** Internal deadline: the hook timeout minus a margin, so the deny is written before the agent cancels us. */
export const DEFAULT_DEADLINE_MS = (HOOK_TIMEOUT_S - 5) * 1000;
/** Cap on the handler's stdout. Anything above it is a deny. Sits well below Claude Code's 10,000-character spill limit. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8_192;
export const MIN_MAX_OUTPUT_BYTES = 512;
export const MAX_MAX_OUTPUT_BYTES = 65_536;
/** Cap on the handler's stderr the watchdog keeps (appended to its own stderr after the reason line; excess is dropped). */
export const MAX_HANDLER_STDERR_BYTES = 16_384;
/** Cap on the hook event the watchdog reads from its own stdin before forwarding it. Above it: deny `watchdog:stdin-too-large`. */
export const MAX_STDIN_BYTES = 4 * 1024 * 1024;
/** Cap on `permissionDecisionReason` in a validated payload; longer reasons are a deny, not a truncation. */
export const MAX_REASON_CHARS = 1_000;

export interface WatchdogOptions {
  /** argv of the handler, e.g. ["node", "/opt/agent-ledger/hook-handler.js"]. Spawned directly, no shell. */
  handlerCommand: string[];
  /** SIGKILL the handler and deny when it has not exited by then. Must be a finite integer, > 0, and ≤ timeoutS*1000 − WATCHDOG_MIN_MARGIN_MS. */
  deadlineMs: number;
  /** Handler stdout above this many bytes is a deny. Finite integer in [MIN_MAX_OUTPUT_BYTES, MAX_MAX_OUTPUT_BYTES]. */
  maxOutputBytes: number;
  /** Selects the output validator (Codex: `ask` is invalid) and the deny text. */
  agent: HookAgent;
  /** The hook `timeout` configured in the agent's settings, in seconds. Defaults to HOOK_TIMEOUT_S. */
  timeoutS?: number;
}
/** What the watchdog process writes and how it exits. The watchdog is the ONLY process whose stdout the agent reads. */
export interface WatchdogResult {
  /** Exactly one line of PreToolUseOutput JSON: the validated allow/ask, or a deny with reason `watchdog:<class>`. Never the handler's raw bytes. */
  stdout: string;
  /** Empty on allow/ask. On every deny: the reason line, then up to MAX_HANDLER_STDERR_BYTES of the handler's stderr. */
  stderr: string;
  /** 0 only for a validated allow or ask. 2 for EVERY deny and EVERY failure path. Never 1. */
  exitCode: 0 | 2;
}
/**
 * Deny reasons the watchdog can emit, as `watchdog:<class>[:<detail>]`. Every one of them is exit 2.
 * config:<field> = bad options (non-finite/non-integer/≤0 deadline, deadline too close to the timeout, output cap out of
 * range, unknown agent, empty command); init = the handler's own startup failure reported on its stderr before any stdout;
 * spawn:<code> = the handler could not be started (ENOENT, EACCES); stdin-too-large; deadline; handler-exit:<code>;
 * handler-signal:<sig>; output:empty | output:too-large | output:not-json | output:not-object | output:multiple |
 * output:extra-key:<key> | output:missing-key:<key> | output:bad-value:<key>; handler-deny (a valid deny payload,
 * re-emitted with the handler's reason and exit 2); internal (uncaughtException/unhandledRejection in the watchdog itself).
 */
export const WATCHDOG_REASON_PREFIX = "watchdog:" as const;
export const WATCHDOG_REASONS = [
  "config", "init", "spawn", "stdin-too-large", "deadline", "handler-exit", "handler-signal",
  "output:empty", "output:too-large", "output:not-json", "output:not-object", "output:multiple",
  "output:extra-key", "output:missing-key", "output:bad-value", "handler-deny", "internal",
] as const;

/** A handler payload the watchdog has accepted: exact key set, known decision, bounded reason. Nothing else passes. */
export type ValidatedHandlerOutput =
  | { ok: true; payload: PreToolUseOutput }
  | { ok: false; reason: `${typeof WATCHDOG_REASON_PREFIX}output:${string}` };
/**
 * Validates the handler's captured stdout before anything reaches the agent. Rules, in order:
 * byte length ≤ maxOutputBytes (else output:too-large); non-empty after trimming whitespace (else output:empty);
 * parses as JSON (else output:not-json) into a plain object (else output:not-object; arrays and strings included);
 * exactly one top-level key `hookSpecificOutput` whose value is a plain object with EXACTLY the keys `hookEventName`
 * (= "PreToolUse"), `permissionDecision` (allow | deny, plus ask for claude-code only) and `permissionDecisionReason`
 * (string, ≤ MAX_REASON_CHARS); any other key anywhere → output:extra-key:<key>; a second JSON value after the first
 * (a stray console.log) → output:multiple. No prototype-key trick applies: lookups are own-property only and the key
 * set is compared exactly. On ok the watchdog RE-SERIALISES the payload; the handler's raw bytes are never forwarded.
 */
export function validateHandlerOutput(raw: string, agent: HookAgent): ValidatedHandlerOutput { throw notImplemented("hooks.validateHandlerOutput"); }

/**
 * The watchdog. This is the only thing Claude Code or Codex executes (settings: `command: "node .../watchdog.js"`).
 * It imports only node:child_process, node:fs and node:process; never the registry, the pipeline, or a YAML parser,
 * so it has nothing to crash on and nothing to block its event loop. Behaviour:
 * 1. Install uncaughtException/unhandledRejection handlers first: either → deny `watchdog:internal`, exit 2.
 * 2. Validate opts (deadlineMs finite integer > 0 and ≤ (timeoutS ?? HOOK_TIMEOUT_S)*1000 − WATCHDOG_MIN_MARGIN_MS;
 *    maxOutputBytes finite integer within [MIN_MAX_OUTPUT_BYTES, MAX_MAX_OUTPUT_BYTES]; agent in HOOK_AGENTS;
 *    handlerCommand a non-empty string array). Any failure → deny `watchdog:config:<field>`, exit 2. A plain exit 1
 *    is never used: the agents treat it as "continue".
 * 3. Start the deadline timer BEFORE reading stdin or spawning. It runs on the watchdog's own event loop, which nothing
 *    else uses, so a handler spinning in a synchronous loop cannot delay it.
 * 4. Read own stdin up to MAX_STDIN_BYTES (more → deny `watchdog:stdin-too-large`); spawn the handler with
 *    stdio ["pipe","pipe","pipe"] and no shell; write the event to its stdin and close it (EPIPE ignored: the handler
 *    then decides on what it read, or fails, and either way the watchdog decides). Spawn error → deny `watchdog:spawn:<code>`.
 * 5. Capture handler stdout into a buffer of maxOutputBytes + 1 (overflow noted, further bytes dropped) and stderr into
 *    MAX_HANDLER_STDERR_BYTES. The handler's stdout is never connected to the agent.
 * 6. At the deadline: SIGKILL the handler (not SIGTERM, which a stalled process may ignore), emit deny `watchdog:deadline`,
 *    exit 2 immediately. Do NOT await the child's exit or close events; unfinished handler work is abandoned.
 * 7. On handler exit: code ≠ 0 → deny `watchdog:handler-exit:<code>`; killed by signal → `watchdog:handler-signal:<sig>`;
 *    code 0 → validateHandlerOutput. Invalid → that deny. Valid deny → deny `watchdog:handler-deny` with the handler's
 *    reason as permissionDecisionReason, exit 2. Valid allow, or ask under claude-code → re-serialised payload, exit 0.
 * 8. Every write to fds 1 and 2 is synchronous (fs.writeSync) and followed by process.exit, so no verdict is lost to an
 *    unflushed stream. Every deny writes BOTH the deny JSON on stdout (one line) and the reason on stderr.
 * It never throws, never exits 0 without a validated payload, and never exits with any code but 0 or 2.
 * Residual limits (spec §7): a missing watchdog binary, a watchdog killed by the OS, or a user-edited hook entry produce
 * no output at all, and both agents continue. Those are closed by managed configuration and a heartbeat, not by code.
 */
export function runWatchdog(opts: WatchdogOptions): Promise<WatchdogResult> { throw notImplemented("hooks.runWatchdog"); }
