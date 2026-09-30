import type { PolicyDecision, ToolCall, ToolInfo } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";

// ---------- Registry: the authority (ADR-004) ----------

/** The three reviewed classes, in rank order. `unreviewed` is not a class a reviewer can assign; it is the absence of a row. */
export const TOOL_CLASSES = ["read", "write", "risky"] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];
export const CLASS_RANK: Record<ToolClass, number> = { read: 0, write: 1, risky: 2 };

/**
 * Raises the class when EVERY argPattern matches (case-insensitive regex over String(args[key]); a missing arg never
 * matches). `to` must rank strictly above the row's base class: the loader refuses a registry where it does not,
 * and evaluate() takes max(base, to) anyway, so an escalation can never lower a class.
 */
export interface Escalation { argPattern: Record<string, string>; to: "write" | "risky"; }

export interface ToolEntry {
  class: ToolClass;
  reviewedBy: string;
  reviewedAt: string;          // YYYY-MM-DD
  note?: string;
  escalateWhen?: Escalation[];
}
export interface ServerEntry {
  /** May this server's MCP annotations feed suggestClass? Has no effect on evaluate(). */
  trusted: boolean;
  tools: Record<string, ToolEntry>;
}
/**
 * Server keys are matched CASE-SENSITIVELY and by own property only (`Object.hasOwn`, or a Map built by the loader).
 * A key is either exactly one of BUILTIN_SERVER_KEYS (`builtin:claude-code`, `builtin:codex`: the only legal keys with
 * a `:`) or an MCP server name matching MCP_SERVER_NAME_RE. See loadRegistry for what is refused.
 */
/**
 * How the Agent Ledger proxy is known to each agent's hook (ADR-006). `codex.serverName` is the name the proxy is
 * registered under in Codex's `mcp_servers` (hook-visible form: `[A-Za-z0-9_]`, no leading/trailing `_`, ≥
 * CODEX_PROXY_SERVER_NAME_MIN_LENGTH chars, unguessable suffix). A Codex hook call named `mcp__<serverName>__<tool>`
 * is `governed-by-proxy`; any other Codex `mcp__*` call is denied (CODEX_MCP_NOT_PROXIED_REASON). Absent → every
 * Codex MCP call is denied, which is the safe default for a registry that has not been set up for Codex.
 */
export interface ProxyIdentity { codex?: { serverName: string } }
export interface ToolRegistry { version: 1; servers: Record<string, ServerEntry>; proxy?: ProxyIdentity; }

/** Key normalisation used only for collision checks: lowercase, then drop every character outside [a-z0-9]. */
export const NORMALISE_FOR_COLLISION = "lowercase; strip /[^a-z0-9]/g" as const;

/** Verdict and risk for each effective class. Unknown server or tool -> require_approval / unreviewed. */
export const CLASS_DECISION: Record<ToolClass, Pick<PolicyDecision, "verdict" | "risk">> = {
  read: { verdict: "allow", risk: "read" },
  write: { verdict: "allow", risk: "write" },
  risky: { verdict: "require_approval", risk: "risky" },
};

/**
 * Parses and validates the YAML registry (parsed with the yaml library's `mapAsMap` so no key ever lands on an
 * object prototype; duplicate YAML keys are already a parse error). Refuses to load (throws) on:
 * - unknown version, an unknown field, a class outside TOOL_CLASSES, a missing reviewedBy/reviewedAt;
 * - an escalation whose `to` does not rank above the row's class;
 * - a server or tool key in RESERVED_KEYS (`__proto__`, `constructor`, `prototype`) or `in Object.prototype`;
 * - a server key that is neither in BUILTIN_SERVER_KEYS nor a match for MCP_SERVER_NAME_RE (so any other `:` is refused);
 * - a server key that is not in BUILTIN_SERVER_KEYS but normalises (lowercase, strip non-[a-z0-9]) to a name in
 *   RESERVED_SERVER_NAMES: `claude-code`, `Claude_Code`, `builtin_claude-code`, `codex`, `builtin_codex` are all
 *   impersonations, whichever agent the registry serves;
 * - two server keys, or two tool keys under one server, that are equal case-insensitively (`github` + `GitHub`).
 *   Lookups stay case-sensitive; the refusal exists so a case twin can never be mistaken for a reviewed row.
 */
export function loadRegistry(path: string): Promise<ToolRegistry> { throw notImplemented("policy.loadRegistry"); }

/**
 * ruleId is `registry:<server>/<tool>` for a plain row, `registry:<server>/<tool>#escalate:<index>` when an
 * escalation fired, and `unreviewed:<server>/<tool>` when the server or the tool is not in the registry.
 * Lookups are exact, case-sensitive, own-property only (`Object.hasOwn`): a `server` or `tool` of `constructor`,
 * `__proto__`, or `toString` is unreviewed, and `claude-code/Read` (an MCP server named claude-code) never sees the
 * `builtin:claude-code` rows. Invariant: the effective class is max(row.class, every matching escalation.to).
 */
export function evaluate(registry: ToolRegistry, call: ToolCall): PolicyDecision { throw notImplemented("policy.evaluate"); }

// ---------- Suggestions: never authority (ADR-004) ----------

export interface SuggestionRule { id: string; tool: string; class: ToolClass; reason: string; }
export interface SuggestionRules { version: 1; default: { class: ToolClass; reason: string }; rules: SuggestionRule[]; }
export function loadSuggestions(path: string): Promise<SuggestionRules> { throw notImplemented("policy.loadSuggestions"); }

export type SuggestionSource = "name-pattern" | "annotation";
export interface ClassSuggestion { class: ToolClass; sources: SuggestionSource[]; reason: string; }
export interface SuggestOptions {
  rules: SuggestionRules;
  /** From ServerEntry.trusted. When false, tool.annotations are ignored entirely (MCP: annotations are untrusted unless the server is). */
  serverTrusted: boolean;
}
/**
 * Proposes a class for a tool during registry review. Combines the first matching name pattern with, for trusted
 * servers only, the annotation hints (readOnlyHint true -> read; destructiveHint true -> risky; otherwise write).
 * When the sources disagree, the higher class wins and both sources are listed. Output is advice for a reviewer;
 * it is never written to the registry without a human's reviewedBy/reviewedAt.
 */
export function suggestClass(tool: ToolInfo, opts: SuggestOptions): ClassSuggestion { throw notImplemented("policy.suggestClass"); }
