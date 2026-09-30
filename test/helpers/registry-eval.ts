// TEST-ONLY validator + evaluator + hook name split, mirroring the contracts' documented semantics (spec §6, §8).
// The product functions (src/policy loadRegistry/evaluate, src/hooks toIncomingCall) stay stubs until Gate 2
// (ADR-002); when they land, the tables move onto them and this file is deleted (test/todo/policy.todo.md).
import { CLASS_DECISION, CLASS_RANK, TOOL_CLASSES, type ToolClass, type ToolEntry, type ToolRegistry } from "../../src/policy/contract.js";
import { APPROVAL_MIN_MARGIN_MS, MCP_TOOL_PREFIX, WATCHDOG_MIN_MARGIN_MS, type HookTiming } from "../../src/hooks/contract.js";
import {
  BUILTIN_SERVERS, BUILTIN_SERVER_KEYS, CODEX_MCP_NOT_PROXIED_REASON, CODEX_PROXY_SERVER_NAME_MIN_LENGTH, CODEX_PROXY_SERVER_NAME_RE,
  MCP_SERVER_NAME_RE, RESERVED_KEYS, RESERVED_SERVER_NAMES, type HookAgent, type HookDecisionKind, type PolicyDecision,
} from "../../src/types/index.js";

const isBuiltinKey = (server: string) => (BUILTIN_SERVER_KEYS as readonly string[]).includes(server);

export type Args = Record<string, unknown>;
const re = (p: string) => new RegExp(p, "i");
const argsMatch = (patterns: Record<string, string>, args: Args) =>
  Object.entries(patterns).every(([k, p]) => Object.hasOwn(args, k) && re(p).test(String(args[k])));
const isClass = (c: unknown): c is ToolClass => (TOOL_CLASSES as readonly unknown[]).includes(c);

/** Collision normalisation (types: RESERVED_SERVER_NAMES): lowercase, then strip everything outside [a-z0-9]. */
export const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
export const isReservedServerName = (name: string) => (RESERVED_SERVER_NAMES as readonly string[]).includes(normalise(name));
/** A key the loader refuses whatever it names: a prototype name, or anything that already lives on Object.prototype. */
export const isReservedKey = (key: string) => (RESERVED_KEYS as readonly string[]).includes(key) || key in Object.prototype;

/** Schema check: returns the problems a loader would refuse on (nothing downgrades, no reserved or ambiguous keys). */
export function validate(reg: ToolRegistry): string[] {
  const problems: string[] = [];
  if (reg.version !== 1) problems.push("version");
  const seenServers = new Map<string, string>();
  for (const [server, s] of Object.entries(reg.servers)) {
    if (isReservedKey(server)) problems.push(`${server}: reserved key`);
    if (!isBuiltinKey(server)) {
      if (!MCP_SERVER_NAME_RE.test(server)) problems.push(`${server}: not an MCP server name`);
      if (isReservedServerName(server)) problems.push(`${server}: collides with the builtin namespace`);
    }
    const lower = server.toLowerCase();
    if (seenServers.has(lower)) problems.push(`${server}: differs only by case from ${seenServers.get(lower)}`);
    seenServers.set(lower, server);
    if (typeof s.trusted !== "boolean") problems.push(`${server}: trusted`);
    const seenTools = new Map<string, string>();
    for (const [tool, t] of Object.entries(s.tools)) {
      const at = `${server}/${tool}`;
      if (isReservedKey(tool)) problems.push(`${at}: reserved key`);
      const tl = tool.toLowerCase();
      if (seenTools.has(tl)) problems.push(`${at}: differs only by case from ${seenTools.get(tl)}`);
      seenTools.set(tl, tool);
      if (!isClass(t.class)) problems.push(`${at}: class`);
      if (!t.reviewedBy || !t.reviewedAt) problems.push(`${at}: review`);
      for (const [i, e] of (t.escalateWhen ?? []).entries()) {
        if (!isClass(e.to) || !isClass(t.class) || CLASS_RANK[e.to] <= CLASS_RANK[t.class]) problems.push(`${at}#escalate:${i}: to must rank above ${t.class}`);
      }
    }
  }
  // ADR-006: the proxy's Codex server name, in Codex's hook-visible form, unguessable, and not an upstream key
  if (reg.proxy?.codex !== undefined) {
    const name = reg.proxy.codex.serverName;
    if (typeof name !== "string" || name.length === 0) problems.push("proxy.codex.serverName: missing");
    else {
      if (!CODEX_PROXY_SERVER_NAME_RE.test(name)) problems.push("proxy.codex.serverName: must be [A-Za-z0-9_] with no leading, trailing or internal __ (Codex trims the ends; the hook name splits at the first __)");
      if (name.length < CODEX_PROXY_SERVER_NAME_MIN_LENGTH) problems.push(`proxy.codex.serverName: shorter than ${CODEX_PROXY_SERVER_NAME_MIN_LENGTH}`);
      if (isReservedServerName(name)) problems.push("proxy.codex.serverName: collides with the builtin namespace");
      if (Object.keys(reg.servers).some((k) => k.toLowerCase() === name.toLowerCase())) problems.push("proxy.codex.serverName: equals a servers key (the proxy is not an upstream)");
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

export function decide(reg: ToolRegistry, server: string, tool: string, args: Args = {}): PolicyDecision {
  const row = lookup(reg, server, tool);
  if (!row) return { verdict: "require_approval", risk: "unreviewed", ruleId: `unreviewed:${server}/${tool}`, reason: "Tool not in the reviewed registry" };
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
