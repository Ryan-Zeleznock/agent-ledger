import type { PolicyDecision, ToolCall, ToolInfo } from "../types/index.js";
import {
  BUILTIN_SERVER_KEYS, MCP_SERVER_NAME_RE, RESERVED_KEYS, RESERVED_SERVER_NAMES,
  CODEX_PROXY_SERVER_NAME_RE, CODEX_PROXY_SERVER_NAME_MIN_LENGTH,
} from "../types/index.js";
import { compileRegex, mapping, readYaml, regex, sequence, string, version } from "./schema.js";

// ---------- Registry: the authority (ADR-004) ----------

/** The three reviewed classes, in rank order. `unreviewed` is not a class a reviewer can assign; it is the absence of a row. */
export const TOOL_CLASSES = ["read", "write", "risky"] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];
export const CLASS_RANK: Record<ToolClass, number> = { read: 0, write: 1, risky: 2 };

/**
 * Raises the class when EVERY argPattern matches (case-insensitive regex over primitives; missing args never
 * match). Structured values and text over 1024 UTF-16 code units count as matched without coercion. `to` must rank strictly above the row's base class: the loader refuses a registry where it does not,
 * and evaluate() takes max(base, to) anyway, so an escalation can never lower a class.
 */
export interface Escalation { argPattern: Record<string, string>; to: "write" | "risky"; }

export interface ToolEntry {
  class: ToolClass;
  reviewedBy: string;
  reviewedAt: string;          // YYYY-MM-DD
  note?: string;
  /** ADR-009: exact top-level argument names permitted in cleartext; absent means none. No dotted paths. */
  storeArgs?: string[];
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
 * - storeArgs that is not a sequence of unique, non-reserved names matching [A-Za-z0-9_-]{1,64}; dots are refused;
 * - a server or tool key in RESERVED_KEYS (`__proto__`, `constructor`, `prototype`) or `in Object.prototype`;
 * - a server key that is neither in BUILTIN_SERVER_KEYS nor a match for MCP_SERVER_NAME_RE (so any other `:` is refused);
 * - a server key that is not in BUILTIN_SERVER_KEYS but normalises (lowercase, strip non-[a-z0-9]) to a name in
 *   RESERVED_SERVER_NAMES: `claude-code`, `Claude_Code`, `builtin_claude-code`, `codex`, `builtin_codex` are all
 *   impersonations, whichever agent the registry serves;
 * - two server keys, or two tool keys under one server, that are equal case-insensitively (`github` + `GitHub`).
 *   Lookups stay case-sensitive; the refusal exists so a case twin can never be mistaken for a reviewed row.
 */
export async function loadRegistry(path: string): Promise<ToolRegistry> {
  const root = mapping(await readYaml(path), "registry", ["version", "servers", "proxy"]);
  version(root.get("version"));
  const serversMap = mapping(root.get("servers"), "servers");
  checkKeys(serversMap, "servers");
  const servers: ToolRegistry["servers"] = Object.fromEntries([...serversMap].map(([name, value]) => {
    if (!(BUILTIN_SERVER_KEYS as readonly string[]).includes(name)) {
      if (!MCP_SERVER_NAME_RE.test(name)) throw new Error(`${name}: not an MCP server name`);
      if (reservedServer(name)) throw new Error(`${name}: impersonates a builtin namespace`);
    }
    const s = mapping(value, name, ["trusted", "tools"]);
    const trusted = s.get("trusted");
    if (typeof trusted !== "boolean") throw new Error(`${name}: trusted must be boolean`);
    const toolsMap = mapping(s.get("tools"), `${name}.tools`);
    checkKeys(toolsMap, `${name}.tools`);
    for (const tool of toolsMap.keys()) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool)) throw new Error(`${name}: invalid ASCII tool key`);
    }
    const tools = Object.fromEntries([...toolsMap].map(([tool, entry]) => [tool, toolEntry(entry, `${name}/${tool}`)]));
    return [name, { trusted, tools }];
  }));
  const result: ToolRegistry = { version: 1, servers };
  if (root.has("proxy")) {
    const proxy = mapping(root.get("proxy"), "proxy", ["codex"]);
    result.proxy = {};
    if (proxy.has("codex")) {
      const codex = mapping(proxy.get("codex"), "proxy.codex", ["serverName"]);
      const name = string(codex.get("serverName"), "proxy.codex.serverName");
      if (!CODEX_PROXY_SERVER_NAME_RE.test(name) || name.length < CODEX_PROXY_SERVER_NAME_MIN_LENGTH || reservedServer(name)) {
        throw new Error("proxy.codex.serverName: invalid or reserved name (minimum 16 characters; no leading/trailing underscore or internal __)");
      }
      // Hooks split at the first __, including separators introduced by sanitisation.
      if (Object.keys(servers).some(k => k.replace(/[^A-Za-z0-9_]/g, "_").split("__")[0]!.replace(/_+$/, "").toLowerCase() === name.toLowerCase())) {
        throw new Error("proxy.codex.serverName: proxy cannot also be an upstream");
      }
      result.proxy.codex = { serverName: name };
    }
  }
  return result;
}

function reservedServer(name: string): boolean {
  return (RESERVED_SERVER_NAMES as readonly string[]).includes(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
}
function checkKeys(entries: Map<string, unknown>, at: string): void {
  const seen = new Set<string>();
  for (const key of entries.keys()) {
    if ((RESERVED_KEYS as readonly string[]).includes(key) || key in Object.prototype) throw new Error(`${at}: reserved key ${key}`);
    string(key, at);
    if (seen.has(key.normalize("NFKC").toLowerCase())) throw new Error(`${at}: keys are NFKC/case twins`);
    seen.add(key.normalize("NFKC").toLowerCase());
  }
}
function toolClass(value: unknown, at: string): ToolClass {
  if (!(TOOL_CLASSES as readonly unknown[]).includes(value)) throw new Error(`${at}: invalid class`);
  return value as ToolClass;
}
function toolEntry(value: unknown, at: string): ToolEntry {
  const m = mapping(value, at, ["class", "reviewedBy", "reviewedAt", "note", "storeArgs", "escalateWhen"]);
  const cls = toolClass(m.get("class"), at);
  const reviewedAt = string(m.get("reviewedAt"), `${at}.reviewedAt`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt) || !Number.isFinite(Date.parse(reviewedAt)) || new Date(reviewedAt).toISOString().slice(0, 10) !== reviewedAt) {
    throw new Error(`${at}: reviewedAt must be a calendar date YYYY-MM-DD`);
  }
  const row: ToolEntry = { class: cls, reviewedBy: string(m.get("reviewedBy"), `${at}.reviewedBy`), reviewedAt };
  if (m.has("note")) {
    const note = m.get("note");
    if (typeof note !== "string") throw new Error(`${at}: note must be a string`);
    row.note = note;
  }
  if (m.has("storeArgs")) {
    const seen = new Set<string>();
    row.storeArgs = sequence(m.get("storeArgs"), `${at}.storeArgs`).map((value, i) => {
      const where = `${at}.storeArgs[${i}]`;
      const field = string(value, where);
      if (field.length > 64 || /[^A-Za-z0-9_-]/.test(field)) throw new Error(`${where}: expected a top-level ASCII argument name (1-64 characters; no dots)`);
      if ((RESERVED_KEYS as readonly string[]).includes(field) || field in Object.prototype) throw new Error(`${where}: reserved key ${field}`);
      if (seen.has(field)) throw new Error(`${where}: duplicate argument name ${field}`);
      seen.add(field);
      return field;
    });
  }
  if (m.has("escalateWhen")) row.escalateWhen = sequence(m.get("escalateWhen"), `${at}.escalateWhen`).map((value, i) => {
    const where = `${at}#escalate:${i}`;
    const e = mapping(value, where, ["to", "argPattern"]);
    const to = toolClass(e.get("to"), where);
    if (to === "read" || CLASS_RANK[to] <= CLASS_RANK[cls]) throw new Error(`${where}: to must rank above ${cls}`);
    const patterns = mapping(e.get("argPattern"), `${where}.argPattern`);
    if (patterns.size === 0) throw new Error(`${where}.argPattern: expected a non-empty mapping`);
    // Prototype names are legal argument names; fromEntries defines own data properties, even __proto__.
    const argPattern = Object.fromEntries(patterns) as Record<string, string>;
    return { to, argPattern };
  });
  compiledPatterns(row);
  return row;
}

/** ADR-009: case-sensitive, own-property lookup; unreviewed tools or absent allowlists permit no clear args. */
export function clearArgFields(registry: ToolRegistry, server: string, tool: string): readonly string[] {
  const s = Object.hasOwn(registry.servers, server) ? registry.servers[server] : undefined;
  const row = s && Object.hasOwn(s.tools, tool) ? s.tools[tool] : undefined;
  if (!row || !Object.hasOwn(CLASS_DECISION, row.class) || !Object.hasOwn(row, "storeArgs")) return [];
  return row.storeArgs ?? [];
}

// Keep compiled state out of the frozen public shapes. A changed row invalidates its cache.
const compiled = new WeakMap<ToolEntry, { source: string; patterns: [string, RegExp][][] }>();
function compiledPatterns(row: ToolEntry): [string, RegExp][][] {
  const source = JSON.stringify(row.escalateWhen ?? []);
  const cached = compiled.get(row);
  if (cached?.source === source) return cached.patterns;
  const patterns = (row.escalateWhen ?? []).map((e, i) => Object.entries(e.argPattern)
    .map(([key, pattern]): [string, RegExp] => [key, compileRegex(pattern, `escalate:${i}.${key}`)]));
  compiled.set(row, { source, patterns });
  return patterns;
}
function matchesValue(pattern: RegExp, value: unknown): boolean {
  if ((typeof value === "object" && value !== null) || typeof value === "function") return true;
  const text = String(value);
  return text.length > 1024 || pattern.test(text);
}

/**
 * ruleId is `registry:<server>/<tool>` for a plain row, `registry:<server>/<tool>#escalate:<index>` when an
 * escalation fired, and `unreviewed:<server>/<tool>` when the server or the tool is not in the registry.
 * Lookups are exact, case-sensitive, own-property only (`Object.hasOwn`): a `server` or `tool` of `constructor`,
 * `__proto__`, or `toString` is unreviewed, and `claude-code/Read` (an MCP server named claude-code) never sees the
 * `builtin:claude-code` rows. Invariant: the effective class is max(row.class, every matching escalation.to).
 */
export function evaluate(registry: ToolRegistry, call: ToolCall): PolicyDecision {
  const { server, tool } = call;
  const args = typeof call.args === "object" && call.args !== null ? call.args : {};
  const s = Object.hasOwn(registry.servers, server) ? registry.servers[server] : undefined;
  const row = s && Object.hasOwn(s.tools, tool) ? s.tools[tool] : undefined;
  if (!row || !Object.hasOwn(CLASS_DECISION, row.class)) return { verdict: "require_approval", risk: "unreviewed", ruleId: `unreviewed:${server}/${tool}`, reason: "Tool not in the reviewed registry" };
  let cls = row.class;
  let ruleId = `registry:${server}/${tool}`;
  const patterns = compiledPatterns(row);
  for (const [i, escalation] of (row.escalateWhen ?? []).entries()) {
    const matches = patterns[i]!.every(([key, pattern]) =>
      Object.hasOwn(args, key) && matchesValue(pattern, args[key]));
    if (matches && CLASS_RANK[escalation.to] > CLASS_RANK[cls]) {
      cls = escalation.to;
      ruleId = `registry:${server}/${tool}#escalate:${i}`;
    }
  }
  return { ...CLASS_DECISION[cls], ruleId, reason: row.note ?? `Reviewed ${cls} by ${row.reviewedBy}` };
}

// ---------- Suggestions: never authority (ADR-004) ----------

export interface SuggestionRule { id: string; tool: string; class: ToolClass; reason: string; }
export interface SuggestionRules { version: 1; default: { class: ToolClass; reason: string }; rules: SuggestionRule[]; }
export async function loadSuggestions(path: string): Promise<SuggestionRules> {
  const m = mapping(await readYaml(path), "suggestions", ["version", "default", "rules"]);
  version(m.get("version"));
  const d = mapping(m.get("default"), "default", ["class", "reason"]);
  const fallback = { class: toolClass(d.get("class"), "default"), reason: string(d.get("reason"), "default.reason") };
  const ids = new Set<string>();
  const rules = sequence(m.get("rules"), "rules").map((value, i) => {
    const at = `rules[${i}]`;
    const r = mapping(value, at, ["id", "tool", "class", "reason"]);
    const id = string(r.get("id"), `${at}.id`);
    if (ids.has(id)) throw new Error(`${at}: duplicate rule id`);
    ids.add(id);
    return { id, tool: regex(r.get("tool"), `${at}.tool`), class: toolClass(r.get("class"), at), reason: string(r.get("reason"), `${at}.reason`) };
  });
  return { version: 1, default: fallback, rules };
}

export type SuggestionSource = "name-pattern" | "annotation";
export interface ClassSuggestion { class: ToolClass; sources: SuggestionSource[]; reason: string; }
export interface SuggestOptions {
  rules: SuggestionRules;
  /** From ServerEntry.trusted. When false, tool.annotations are ignored entirely (MCP: annotations are untrusted unless the server is). */
  serverTrusted: boolean;
}
/**
 * Proposes a class for a tool during registry review. Combines the first matching name pattern with, for trusted
 * servers only, annotation hints (explicit destructive -> risky; readOnly -> read; explicit nondestructive -> write;
 * otherwise risky per MCP's destructiveHint default).
 * When the sources disagree, the higher class wins and both sources are listed. Output is advice for a reviewer;
 * it is never written to the registry without a human's reviewedBy/reviewedAt.
 */
export function suggestClass(tool: ToolInfo, opts: SuggestOptions): ClassSuggestion {
  const pattern = opts.rules.rules.find(r => new RegExp(r.tool, "i").test(tool.name));
  const hints = opts.serverTrusted ? tool.annotations : undefined;
  const sources: SuggestionSource[] = [];
  const reasons: string[] = [];
  let cls: ToolClass | undefined;
  if (pattern) { cls = pattern.class; sources.push("name-pattern"); reasons.push(pattern.reason); }
  if (hints) {
    // Conflicting hints take the higher risk, just as conflicting name/annotation sources do.
    const annotation: ToolClass = hints.destructiveHint === true ? "risky" : hints.readOnlyHint === true ? "read" : hints.destructiveHint === false ? "write" : "risky";
    if (cls === undefined || CLASS_RANK[annotation] > CLASS_RANK[cls]) cls = annotation;
    sources.push("annotation");
    reasons.push(`Annotation: ${annotation === "risky" ? "destructiveHint" : annotation === "read" ? "readOnlyHint" : "destructiveHint false"}`);
  }
  if (cls === undefined) return { ...opts.rules.default, sources: [] };
  return { class: cls, sources, reason: reasons.join("; ") };
}
