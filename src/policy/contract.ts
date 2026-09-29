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
export interface ToolRegistry { version: 1; servers: Record<string, ServerEntry>; }

/** Verdict and risk for each effective class. Unknown server or tool -> require_approval / unreviewed. */
export const CLASS_DECISION: Record<ToolClass, Pick<PolicyDecision, "verdict" | "risk">> = {
  read: { verdict: "allow", risk: "read" },
  write: { verdict: "allow", risk: "write" },
  risky: { verdict: "require_approval", risk: "risky" },
};

/**
 * Parses and validates the YAML registry. Refuses to load (throws) on: unknown version, an unknown field, a class
 * outside TOOL_CLASSES, a missing reviewedBy/reviewedAt, or an escalation whose `to` does not rank above the row's class.
 */
export function loadRegistry(path: string): Promise<ToolRegistry> { throw notImplemented("policy.loadRegistry"); }

/**
 * ruleId is `registry:<server>/<tool>` for a plain row, `registry:<server>/<tool>#escalate:<index>` when an
 * escalation fired, and `unreviewed:<server>/<tool>` when the server or the tool is not in the registry.
 * Invariant: the effective class is max(row.class, every matching escalation.to). Nothing downgrades.
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
