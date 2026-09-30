// Test-only independent decision oracle and schema checks; product policy is implemented.
// Retained for generated policy parity and unfinished hook contracts (ADR-008).
import { compileRegex } from "../../src/policy/schema.js";
import { CLASS_DECISION, CLASS_RANK, TOOL_CLASSES, type ToolClass, type ToolEntry, type ToolRegistry } from "../../src/policy/contract.js";
import { APPROVAL_MIN_MARGIN_MS, MCP_TOOL_PREFIX, WATCHDOG_MIN_MARGIN_MS, type HookTiming } from "../../src/hooks/contract.js";
import {
  BUILTIN_SERVERS, BUILTIN_SERVER_KEYS, CODEX_MCP_NOT_PROXIED_REASON, CODEX_PROXY_SERVER_NAME_MIN_LENGTH, CODEX_PROXY_SERVER_NAME_RE,
  MCP_SERVER_NAME_RE, RESERVED_KEYS, RESERVED_SERVER_NAMES, type HookAgent, type HookDecisionKind, type PolicyDecision,
} from "../../src/types/index.js";

const isBuiltinKey = (server: string) => (BUILTIN_SERVER_KEYS as readonly string[]).includes(server);

export type Args = Record<string, unknown>;
const re = (p: string) => compileRegex(p, "oracle argPattern");
const argsMatch = (patterns: Record<string, string>, args: Args) =>
  Object.entries(patterns).map(([k, p]): [string, RegExp] => [k, re(p)]).every(([k, pattern]) => {
    if (typeof args !== "object" || args === null || !Object.hasOwn(args, k)) return false;
    const value = args[k];
    if ((typeof value === "object" && value !== null) || typeof value === "function") return true;
    const text = String(value);
    return text.length > 1024 || pattern.test(text);
  });
const isClass = (c: unknown): c is ToolClass => (TOOL_CLASSES as readonly unknown[]).includes(c);

/** Collision normalisation (types: RESERVED_SERVER_NAMES): lowercase, then strip everything outside [a-z0-9]. */
export const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
export const isReservedServerName = (name: string) => (RESERVED_SERVER_NAMES as readonly string[]).includes(normalise(name));
/** A key the loader refuses whatever it names: a prototype name, or anything that already lives on Object.prototype. */
export const isReservedKey = (key: string) => (RESERVED_KEYS as readonly string[]).includes(key) || key in Object.prototype;

/** Schema check: returns the problems a loader would refuse on (nothing downgrades, no reserved or ambiguous keys). */
export function validate(reg: ToolRegistry): string[] {
  const problems: string[] = [];
  const fields = (value: unknown, at: string, allowed?: string[]): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) { problems.push(`${at}: mapping`); return false; }
    if (allowed && Object.keys(value).some(k => !allowed.includes(k))) problems.push(`${at}: unknown field`);
    return true;
  };
  if (!fields(reg, "registry", ["version", "servers", "proxy"])) return problems;
  if (!fields(reg.servers, "servers")) return problems;
  if (reg.version !== 1) problems.push("version");
  const seenServers = new Map<string, string>();
  for (const [server, s] of Object.entries(reg.servers)) {
    if (isReservedKey(server)) problems.push(`${server}: reserved key`);
    if (!isBuiltinKey(server)) {
      if (!MCP_SERVER_NAME_RE.test(server)) problems.push(`${server}: not an MCP server name`);
      if (isReservedServerName(server)) problems.push(`${server}: collides with the builtin namespace`);
    }
    const lower = server.normalize("NFKC").toLowerCase();
    if (seenServers.has(lower)) problems.push(`${server}: differs only by case from ${seenServers.get(lower)}`);
    seenServers.set(lower, server);
    if (!fields(s, server, ["trusted", "tools"])) continue;
    if (typeof s.trusted !== "boolean") problems.push(`${server}: trusted`);
    if (!fields(s.tools, `${server}.tools`)) continue;
    const seenTools = new Map<string, string>();
    for (const [tool, t] of Object.entries(s.tools)) {
      const at = `${server}/${tool}`;
      if (isReservedKey(tool)) problems.push(`${at}: reserved key`);
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool)) problems.push(`${at}: invalid ASCII tool key`);
      const tl = tool.normalize("NFKC").toLowerCase();
      if (seenTools.has(tl)) problems.push(`${at}: differs only by case from ${seenTools.get(tl)}`);
      seenTools.set(tl, tool);
      if (!fields(t, at, ["class", "reviewedBy", "reviewedAt", "note", "storeArgs", "escalateWhen"])) continue;
      if (!isClass(t.class)) problems.push(`${at}: class`);
      const date = t.reviewedAt;
      if (typeof t.reviewedBy !== "string" || !t.reviewedBy.trim() || typeof date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) problems.push(`${at}: review`);
      if (Object.hasOwn(t, "note") && typeof t.note !== "string") problems.push(`${at}: note`);
      if (Object.hasOwn(t, "storeArgs")) {
        const names = t.storeArgs;
        if (!Array.isArray(names) || names.some(name => typeof name !== "string" || name.length < 1 || name.length > 64 ||
          /[^A-Za-z0-9_-]/.test(name) || isReservedKey(name)) || new Set(names).size !== names.length) {
          problems.push(`${at}: storeArgs must contain unique, non-reserved top-level ASCII names (1-64 characters; no dots)`);
        }
      }
      if (Object.hasOwn(t, "escalateWhen") && !Array.isArray(t.escalateWhen)) { problems.push(`${at}: escalateWhen`); continue; }
      for (const [i, e] of (t.escalateWhen ?? []).entries()) {
        if (!fields(e, `${at}#escalate:${i}`, ["to", "argPattern"])) continue;
        if (fields(e.argPattern, `${at}#escalate:${i}.argPattern`)) {
          if (Object.keys(e.argPattern).length === 0) problems.push(`${at}#escalate:${i}.argPattern: expected a non-empty mapping`);
          for (const pattern of Object.values(e.argPattern)) {
            try { compileRegex(pattern, at); } catch { problems.push(`${at}#escalate:${i}: regex`); }
          }
        }
        if (!isClass(e.to) || !isClass(t.class) || CLASS_RANK[e.to] <= CLASS_RANK[t.class]) problems.push(`${at}#escalate:${i}: to must rank above ${t.class}`);
      }
    }
  }
  // ADR-006: the proxy's Codex server name, in Codex's hook-visible form, unguessable, and not an upstream key
  if (Object.hasOwn(reg, "proxy")) {
    if (!fields(reg.proxy, "proxy", ["codex"])) return problems;
    if (Object.hasOwn(reg.proxy!, "codex") && !fields(reg.proxy!.codex, "proxy.codex", ["serverName"])) return problems;
  }
  if (reg.proxy?.codex !== undefined) {
    const name = reg.proxy.codex.serverName;
    if (typeof name !== "string" || name.length === 0) problems.push("proxy.codex.serverName: missing");
    else {
      if (!CODEX_PROXY_SERVER_NAME_RE.test(name)) problems.push("proxy.codex.serverName: must be [A-Za-z0-9_] with no leading, trailing or internal __ (Codex trims the ends; the hook name splits at the first __)");
      if (name.length < CODEX_PROXY_SERVER_NAME_MIN_LENGTH) problems.push(`proxy.codex.serverName: shorter than ${CODEX_PROXY_SERVER_NAME_MIN_LENGTH}`);
      if (isReservedServerName(name)) problems.push("proxy.codex.serverName: collides with the builtin namespace");
      if (Object.keys(reg.servers).some((k) => codexSanitize(k).split("__")[0]!.replace(/_+$/, "").toLowerCase() === codexSanitize(name).toLowerCase())) problems.push("proxy.codex.serverName: equals a servers key (the proxy is not an upstream)");
    }
  }
  return problems;
}

// ---------- Codex MCP naming, as openai/codex does it (read 2026-09-29) ----------

/** codex-rs/codex-mcp/src/mcp/mod.rs `sanitize_responses_api_tool_name`: keep ASCII alphanumerics and `_`, everything else → `_`; empty → `_`. */
export const codexSanitize = (s: string) => { const out = s.replace(/[^A-Za-z0-9_]/g, "_"); return out.length ? out : "_"; };
/**
 * codex-rs/core/src/tools/handlers/mcp.rs `hook_tool_name` = ensure_mcp_prefix(join_tool_name(namespaced(callable_namespace, callable_name))),
 * where join_tool_name does `namespace.trim_end_matches('_')` + "__" + `name.trim_start_matches('_')`, AFTER sanitising
 * (and, on a collision, hash-suffixing) both parts in codex-mcp/src/tools.rs. This helper models the no-collision case.
 */
export function codexHookToolName(rawServer: string, rawTool: string): string {
  const ns = ("mcp__" + codexSanitize(rawServer)).replace(/_+$/, "");
  const tool = codexSanitize(rawTool).replace(/^_+/, "");
  return `${ns}__${tool}`;
}

/** What `pipeline.decide` does with a Codex hook call before the registry is consulted (ADR-006). */
export type CodexRoute =
  | { kind: "builtin"; server: string; tool: string }
  | { kind: Extract<HookDecisionKind, "governed-by-proxy">; decision: "allow" }
  | { kind: "deny-not-proxied"; decision: "deny"; reason: string; ruleId: string };
export function routeCodexHookCall(toolName: string, proxyServerName: string | undefined): CodexRoute {
  const { server, tool } = splitToolName(toolName, false, "codex");
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) return { kind: "builtin", server, tool };
  if (proxyServerName !== undefined && server === proxyServerName) return { kind: "governed-by-proxy", decision: "allow" };
  return { kind: "deny-not-proxied", decision: "deny", reason: CODEX_MCP_NOT_PROXIED_REASON, ruleId: `codex-mcp-not-proxied:${server}/${tool}` };
}

/** hooks.validateHookTiming as documented: every present value a finite integer > 0, and the two margins hold. */
export function checkHookTiming(t: HookTiming): string[] {
  const problems: string[] = [];
  const bad = (n: unknown) => typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n <= 0;
  if (t.approvalTimeoutMs !== undefined && bad(t.approvalTimeoutMs)) problems.push("approvalTimeoutMs");
  if (bad(t.deadlineMs)) problems.push("deadlineMs");
  if (bad(t.hookTimeoutS)) problems.push("hookTimeoutS");
  if (problems.length) return problems;
  if (t.approvalTimeoutMs !== undefined && t.approvalTimeoutMs + APPROVAL_MIN_MARGIN_MS > t.deadlineMs) problems.push("approval-not-below-deadline");
  if (t.deadlineMs + WATCHDOG_MIN_MARGIN_MS > t.hookTimeoutS * 1000) problems.push("deadline-not-below-hook-timeout");
  return problems;
}

/** Own-property, case-sensitive lookup: `constructor`, `__proto__`, `toString` are unreviewed, not hits. */
function lookup(reg: ToolRegistry, server: string, tool: string): ToolEntry | undefined {
  if (!Object.hasOwn(reg.servers, server)) return undefined;
  const s = reg.servers[server]!;
  return Object.hasOwn(s.tools, tool) ? s.tools[tool] : undefined;
}

export function clearArgFields(reg: ToolRegistry, server: string, tool: string): readonly string[] {
  const row = lookup(reg, server, tool);
  if (!row || !isClass(row.class) || !Object.hasOwn(row, "storeArgs")) return [];
  return row.storeArgs ?? [];
}

export function decide(reg: ToolRegistry, server: string, tool: string, args: Args = {}): PolicyDecision {
  const row = lookup(reg, server, tool);
  if (!row || !isClass(row.class)) return { verdict: "require_approval", risk: "unreviewed", ruleId: `unreviewed:${server}/${tool}`, reason: "Tool not in the reviewed registry" };
  let cls: ToolClass = row.class;
  let ruleId = `registry:${server}/${tool}`;
  for (const [i, e] of (row.escalateWhen ?? []).entries()) {
    if (argsMatch(e.argPattern, args) && CLASS_RANK[e.to] > CLASS_RANK[cls]) { cls = e.to; ruleId = `registry:${server}/${tool}#escalate:${i}`; }
  }
  return { ...CLASS_DECISION[cls], ruleId, reason: row.note ?? `Reviewed ${cls} by ${row.reviewedBy}` };
}

/**
 * hooks.toIncomingCall naming rule: `mcp__<server>__<tool>` splits at the first `__` after the prefix; a server
 * segment that normalises to a reserved name throws (either agent's reserved names, under either agent);
 * `mcp_server` without the prefix throws (Claude Code only); anything else is a built-in on BUILTIN_SERVERS[agent].
 */
export function splitToolName(toolName: string, hasMcpProvenance = false, agent: HookAgent = "claude-code"): { server: string; tool: string } {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    const rest = toolName.slice(MCP_TOOL_PREFIX.length);
    const i = rest.indexOf("__");
    if (i <= 0 || i === rest.length - 2) throw new Error(`malformed MCP tool name: ${toolName}`);
    const server = rest.slice(0, i), tool = rest.slice(i + 2);
    if (isReservedServerName(server)) throw new Error(`MCP server "${server}" impersonates the builtin namespace`);
    return { server, tool };
  }
  if (hasMcpProvenance) throw new Error(`mcp_server present on a non-MCP tool name: ${toolName}`);
  return { server: BUILTIN_SERVERS[agent], tool: toolName };
}
