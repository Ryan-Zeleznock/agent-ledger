// TEST-ONLY validator + evaluator + hook name split, mirroring the contracts' documented semantics (spec §6, §8).
// The product functions (src/policy loadRegistry/evaluate, src/hooks toIncomingCall) stay stubs until Gate 2
// (ADR-002); when they land, the tables move onto them and this file is deleted (test/todo/policy.todo.md).
import { CLASS_DECISION, CLASS_RANK, TOOL_CLASSES, type ToolClass, type ToolEntry, type ToolRegistry } from "../../src/policy/contract.js";
import { MCP_TOOL_PREFIX } from "../../src/hooks/contract.js";
import { BUILTIN_SERVER, MCP_SERVER_NAME_RE, RESERVED_KEYS, RESERVED_SERVER_NAMES, type PolicyDecision } from "../../src/types/index.js";

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
    if (server !== BUILTIN_SERVER) {
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
 * segment that normalises to a reserved name throws; `mcp_server` without the prefix throws; anything else is
 * a built-in on BUILTIN_SERVER.
 */
export function splitToolName(toolName: string, hasMcpProvenance = false): { server: string; tool: string } {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) {
    const rest = toolName.slice(MCP_TOOL_PREFIX.length);
    const i = rest.indexOf("__");
    if (i <= 0 || i === rest.length - 2) throw new Error(`malformed MCP tool name: ${toolName}`);
    const server = rest.slice(0, i), tool = rest.slice(i + 2);
    if (isReservedServerName(server)) throw new Error(`MCP server "${server}" impersonates the builtin namespace`);
    return { server, tool };
  }
  if (hasMcpProvenance) throw new Error(`mcp_server present on a non-MCP tool name: ${toolName}`);
  return { server: BUILTIN_SERVER, tool: toolName };
}
