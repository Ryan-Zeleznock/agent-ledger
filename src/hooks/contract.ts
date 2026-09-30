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
 * - Codex only (ADR-006): the `<server>` segment of an `mcp__` name is NOT an identity. Verified 2026-09-29 in
 *   openai/codex `codex-rs/core/src/tools/handlers/mcp.rs`: `join_tool_name` trims trailing `_` from the sanitised,
 *   collision-hashed namespace and leading `_` from the tool, so `github_`/`list_repos` and `github`/`_list_repos`
 *   both arrive as `mcp__github__list_repos`. This function still splits the name (so the pipeline can name the
 *   attempt), but `pipeline.decide` under `hookAgent: "codex"` never consults the registry for an MCP server: it
 *   answers `allow` + `kind: "governed-by-proxy"` when `<server> === registry.proxy.codex.serverName` (the proxy
 *   decides and records with raw identity), and a RECORDED deny (CODEX_MCP_NOT_PROXIED_REASON) for any other server.
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
 * 2026-09-29). Since ADR-006 the pipeline never produces `ask` under Codex: with `hook-ask` it resolves the channel
 * BEFORE persisting and records `approval.decision = "no-channel"` (a final, reasoned deny), so this rewrite is a
 * belt-and-braces guard, not the normal path. A Slack channel is the only way to get a real approval under Codex.
 */
export function formatPreToolUseOutput(d: HookDecision, agent: HookAgent): string { throw notImplemented("hooks.formatPreToolUseOutput"); }

// ---------- Two-process fail-closed watchdog (spec §7) ----------
//
// Verified 2026-09-29. Claude Code (https://code.claude.com/docs/en/hooks #exit-code-2, #other-exit-codes,
// #timeouts, #json-output): "exit 2 blocks whether or not you print JSON: even a JSON permissionDecision of
// "allow" can't override it"; the blocking message is the JSON deny reason when there is one, else stderr, and
// Claude sees it; exit 0 without a decision, exit 1 or any other non-2 code WITHOUT valid decision JSON, unparseable
// or schema-failing stdout, a hook that reaches its `timeout`, and a hook that cannot start (exit 127) all let the
// tool call CONTINUE. With valid decision JSON on a non-2 exit, "Claude Code ignores the exit code and the JSON alone
// decides" (re-read 2026-09-29), so exit 1 + a valid deny does block there; we never rely on it and stay exit 2 on
// every deny (spec §7 table). Stdout is
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
/** A Slack answer must be back, recorded and formatted at least this long before the watchdog's deadline kills the handler. */
export const APPROVAL_MIN_MARGIN_MS = 5_000;
/**
 * The three clocks of one hook call (ADR-006). Invariant, validated at init (`validateHookTiming`):
 *   approvalTimeoutMs + APPROVAL_MIN_MARGIN_MS ≤ deadlineMs   and   deadlineMs + WATCHDOG_MIN_MARGIN_MS ≤ hookTimeoutS × 1000.
 * The agents' `timeout` is in seconds for both (Claude Code: "Seconds before canceling", default 600 for command hooks;
 * Codex: "`timeout` is in seconds. If `timeout` is omitted, Codex uses `600` seconds for most hooks", and in source
 * `timeout_sec.unwrap_or(600).max(1)` with NO upper clamp for PreToolUse; only SessionEnd/Interrupt are clamped to 3 s.
 * Both verified 2026-09-29). So a 320 s PreToolUse hook is legal in both agents.
 */
export interface HookTiming { approvalTimeoutMs?: number; deadlineMs: number; hookTimeoutS: number; }
/** No Slack channel (Claude Code hook-ask, or Codex with every require_approval a recorded deny): fast. */
export const DEFAULT_HOOK_TIMING: HookTiming = { deadlineMs: DEFAULT_DEADLINE_MS, hookTimeoutS: HOOK_TIMEOUT_S };
/** Slack approvals (required under Codex): a human gets 5 minutes; the watchdog and the agent wait a little longer, in that order. */
export const SLACK_HOOK_TIMING: HookTiming = { approvalTimeoutMs: 300_000, deadlineMs: 310_000, hookTimeoutS: 320 };
/** The watchdog hands its configured deadline DURATION to the handler through this env var, for the static three-clock check at init (`validateHookTiming`). */
export const WATCHDOG_DEADLINE_ENV = "AGENT_LEDGER_WATCHDOG_DEADLINE_MS" as const;
/**
 * The watchdog also hands the handler its ABSOLUTE deadline: `Date.now() + deadlineMs`, taken when the watchdog's timer
 * starts (BEFORE stdin is read or the child spawned), as epoch milliseconds. The handler budgets everything, above all
 * the Slack wait, from `deadlineAt - Date.now()` at the moment it needs the budget, never from the duration: the
 * watchdog may have spent seconds of the duration on stdin and spawn before the handler ran, and a handler that waited
 * the full `approvalTimeoutMs` after a late start would be killed mid-wait with an unrecorded approval (Astra P2,
 * 2026-09-30). Missing, non-integer, or already-past value → handler init failure → watchdog deny, exit 2.
 */
export const WATCHDOG_DEADLINE_AT_ENV = "AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS" as const;
/** Always SIGKILL, always the whole process group (`process.kill(-pid)`): a stalled handler or its grandchild may ignore SIGTERM. */
export const WATCHDOG_KILL_SIGNAL = "SIGKILL" as const;
/**
 * Output writes are TIME-bounded, not only count-bounded (Astra P1, 2026-09-30): a blocking `fs.writeSync` to a pipe
 * whose reader has stopped draining (a full 64 KiB pipe buffer) never returns and would stall the watchdog past its
 * own deadline. So fds 1 and 2 are put into non-blocking mode before the first write, every `writeSync` can then return
 * EAGAIN instead of blocking, and `writeAllSync` retries within this budget. Zero progress (no byte accepted) for the
 * whole budget is a write failure → exit 2, whatever was flushed. The budget is small: the agent reads at most one line.
 */
export const WATCHDOG_WRITE_BUDGET_MS = 1_000;
/** Retry back-off inside the write budget; keeps the retry loop from spinning while the reader catches up. */
export const WATCHDOG_WRITE_RETRY_SLEEP_MS = 5;
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
  /**
   * SIGKILL the handler's whole process group and deny when the handler has not exited AND closed its pipes by then.
   * Finite integer, > 0, ≤ timeoutS*1000 − WATCHDOG_MIN_MARGIN_MS. Configurable per deployment (DEFAULT_HOOK_TIMING
   * without Slack, SLACK_HOOK_TIMING with it); the same value is exported to the handler as WATCHDOG_DEADLINE_ENV.
   */
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
  "output:extra-key", "output:missing-key", "output:bad-value", "handler-deny", "write", "internal",
] as const;
/**
 * `deadline` carries a detail saying which wait the clock ran out on: `stdin` (the agent never closed our stdin: a
 * never-EOF regression), `handler` (the handler is still running), `pipes-open` (the handler exited 0 but its stdout/
 * stderr pipes are still held, usually by a grandchild). `write` = a write to fd 1 or 2 failed or could not be
 * completed; the exit code is still 2 (the reporter itself may fail; exit 2 is what the agent sees either way).
 */
export const WATCHDOG_DEADLINE_DETAILS = ["stdin", "handler", "pipes-open"] as const;

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
 *    else uses, so a handler spinning in a synchronous loop cannot delay it. Qualification: the one synchronous step
 *    the watchdog itself takes is `spawn()` (fork/exec inside libuv); a slow spawn cannot be interrupted, and the timer
 *    fires as soon as it returns. Nothing else in the watchdog blocks.
 * 4. Read own stdin ASYNCHRONOUSLY (`process.stdin.on("data" | "end")`), never `fs.readFileSync(0)`: a synchronous read
 *    of a stdin the agent never closes would hang past every timer. Bound it at MAX_STDIN_BYTES (more → deny
 *    `watchdog:stdin-too-large`, handler never spawned). EOF → spawn the handler `detached: true` (Node: "the child
 *    process will be made the leader of a new process group and session"), stdio ["pipe","pipe","pipe"], no shell, env
 *    carrying WATCHDOG_DEADLINE_ENV = deadlineMs (the duration, for the static clock check) AND WATCHDOG_DEADLINE_AT_ENV
 *    = the epoch-ms instant the timer of step 3 fires (the handler budgets its Slack wait from THIS, so time the
 *    watchdog spent on stdin never extends the handler's real deadline); write the event to its stdin and close it (EPIPE ignored: the handler
 *    then decides on what it read, or fails, and either way the watchdog decides). Spawn error → deny `watchdog:spawn:<code>`.
 *    No EOF before the deadline → deny `watchdog:deadline:stdin`.
 * 5. Capture handler stdout into a buffer of maxOutputBytes + 1 (overflow noted, further bytes dropped) and stderr into
 *    MAX_HANDLER_STDERR_BYTES. The handler's stdout is never connected to the agent.
 * 6. Accept an allow/ask ONLY after BOTH the child's `exit` (code 0) AND its `close` event. Node (child_process docs,
 *    verified 2026-09-29): "When the 'exit' event is triggered, child process stdio streams might still be open"; "The
 *    'close' event is emitted after a process has ended and the stdio streams of a child process have been closed ...
 *    since multiple processes might share the same stdio streams." So a grandchild that inherited the pipes can keep
 *    writing after the handler exits 0; validating on `exit` would accept an incomplete or later-polluted buffer. The
 *    deadline keeps running while the pipes are open: `exit` 0 but no `close` by the deadline → group kill + deny
 *    `watchdog:deadline:pipes-open`, exit 2. Whatever a grandchild appended before `close` is part of the validated
 *    buffer (→ `output:multiple` / `output:too-large` when it is junk).
 * 7. At the deadline (any of stdin, handler, pipes-open): `process.kill(-child.pid, "SIGKILL")`, the WHOLE process group
 *    (kill(2): "If pid is less than -1, then sig is sent to every process in the process group whose ID is -pid"), not
 *    SIGTERM, which a stalled process may ignore; then deny, exit 2 immediately. Do NOT await `exit` or `close` after
 *    the kill; unfinished work is abandoned. Every other failure path that follows a spawn (non-zero exit, signal,
 *    invalid output, write failure, internal error) also group-kills before exiting, so no descendant survives a deny.
 *    Kill semantics (Astra P2, 2026-09-30): `process.kill(-pid)` throwing ESRCH means the group is already gone; that
 *    is NOT an error, the deny proceeds unchanged. The group id is `child.pid`, kept from spawn, and it is used for
 *    exactly ONE kill attempt per failure path: after the group has disappeared the watchdog never kills by that id
 *    again, because the kernel may reuse a PGID for an unrelated process. A descendant that calls `setsid()` leaves
 *    the handler's group and the group kill cannot reach it: that is a stated residual of local mode (spec §7), not a
 *    covered case; the watchdog does not walk the process tree.
 * 8. On `exit`: code ≠ 0 → group kill, deny `watchdog:handler-exit:<code>` at once (no wait for `close`); killed by
 *    signal → `watchdog:handler-signal:<sig>`; code 0 → wait for `close` (step 6), then validateHandlerOutput. Invalid
 *    → that deny. Valid deny → deny `watchdog:handler-deny` with the handler's reason, exit 2. Valid allow, or ask
 *    under claude-code → re-serialised payload, exit 0.
 * 9. Every write to fds 1 and 2 goes through `writeAllSync`, and both fds are switched to NON-BLOCKING mode before the
 *    first write (Astra P1, 2026-09-30: a blocking `writeSync` to a pipe the reader has stopped draining never returns
 *    and would stall the watchdog past its own deadline). `writeAllSync` loops on `fs.writeSync`'s return value
 *    ("Returns: <number> The number of bytes written", so a short write is legal) until every byte is out, retrying
 *    EAGAIN with a short sleep, bounded by TIME (WATCHDOG_WRITE_BUDGET_MS), not only by a count. Zero progress for the
 *    whole budget, running out of budget, or any other error is a write failure: the watchdog still exits 2
 *    (`watchdog:write` on whichever fd still works, best effort, within the same budget), even when the failure happens
 *    inside the failure reporter itself. Writes are followed by `process.exit`, so no verdict is lost to an unflushed
 *    stream. Every deny writes BOTH the deny JSON on stdout (one line) and the reason on stderr.
 * It never throws, never exits 0 without a validated payload, and never exits with any code but 0 or 2.
 * Trust boundary (spec §3, §7): all of this is best-effort gating on a machine the user controls. A user who owns the
 * machine can remove the hook entry, kill the watchdog, or preload code into the "approved" proxy through the launch
 * environment (`NODE_OPTIONS=--import=…`, which Codex's managed `mcp_servers` matcher does not inspect). Local mode is
 * visibility + tamper-evident logging + best-effort gating; the enforcement boundary is SERVER mode, where the proxy
 * holds the credentials. Residual limits (spec §7): a missing watchdog binary, a watchdog killed by the OS, or a
 * user-edited hook entry produce no output at all, and both agents continue; a `setsid()` descendant escapes the group
 * kill. Those are narrowed by managed configuration, a protected launch environment and a heartbeat, not closed by code.
 * Orphaning: if the WATCHDOG itself is SIGKILLed (OOM, or the agent's own timeout after a deadline misconfiguration),
 * nobody group-kills the detached handler and it runs on as an orphan. Codex kills the hook's own process group at its
 * timeout (verified 2026-09-29: `process_mode(NewSession)` + `kill_process_group` in codex-rs hooks
 * `command_runner.rs`), and the detached handler is in a different group, so Codex's kill does not reach it either;
 * Claude Code's process-tree behaviour at timeout is undocumented [H]. Hence the deadline must sit below the hook
 * timeout (validated, step 2), and the orphan is a documented residual, not a covered case.
 */
export function runWatchdog(opts: WatchdogOptions): Promise<WatchdogResult> { throw notImplemented("hooks.runWatchdog"); }

/**
 * Writes every byte of `data` to `fd` with `fs.writeSync`, looping on the returned byte count and retrying EAGAIN
 * (sleeping WATCHDOG_WRITE_RETRY_SLEEP_MS between attempts) until the bytes are out or `budgetMs` (default
 * WATCHDOG_WRITE_BUDGET_MS) has elapsed since the first attempt. The caller has put `fd` into non-blocking mode first
 * (`setNonBlocking`), so a full pipe surfaces as EAGAIN instead of a blocking call that outlives the deadline. Throws
 * on any other error, when the budget runs out, or when no byte at all was accepted within the budget (zero
 * progress); the watchdog turns every throw into exit 2. `now` is injectable for the runtime tests.
 */
export function writeAllSync(fd: 1 | 2, data: Uint8Array, budgetMs?: number, now?: () => number): void { throw notImplemented("hooks.writeAllSync"); }

/**
 * Puts fd 1 or 2 into O_NONBLOCK mode (a small native-free step: on POSIX Node exposes it through the stream's handle;
 * the implementation may fall back to `net.Socket`/`tty.WriteStream` with `setBlocking(false)`). Idempotent. A failure
 * to switch is itself a write failure → exit 2, because a blocking fd cannot be written within a time bound.
 */
export function setNonBlocking(fd: 1 | 2): void { throw notImplemented("hooks.setNonBlocking"); }

/**
 * Validates the three clocks (ADR-006) and returns the violations, one string each; empty = valid. Called by the
 * watchdog on its own options (hook timeout vs deadline → `watchdog:config:deadlineMs`) and by the handler at init on
 * `approvals.timeoutMs` vs the deadline DURATION it received through WATCHDOG_DEADLINE_ENV (a violation is an init
 * failure, so the watchdog denies with exit 2). This is the static check. The RUNTIME budget is separate: the handler
 * reads WATCHDOG_DEADLINE_AT_ENV and, when it is about to wait on Slack, uses
 * `min(approvalTimeoutMs, deadlineAt - Date.now() - APPROVAL_MIN_MARGIN_MS)`; if that is ≤ 0 the approval is
 * `timeout` without a Slack round trip (recorded, then deny). Rules: every present value a finite integer > 0;
 * `approvalTimeoutMs + APPROVAL_MIN_MARGIN_MS ≤ deadlineMs` (`approval-not-below-deadline`);
 * `deadlineMs + WATCHDOG_MIN_MARGIN_MS ≤ hookTimeoutS * 1000` (`deadline-not-below-hook-timeout`).
 * Claude Code's hook-ask path has no approvalTimeoutMs and keeps DEFAULT_HOOK_TIMING; Slack is optional there.
 */
export function validateHookTiming(t: HookTiming): string[] { throw notImplemented("hooks.validateHookTiming"); }
