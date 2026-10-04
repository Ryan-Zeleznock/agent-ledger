// Slice 2a pin 6: the harmless demo upstream, second entrypoint of the same image (`node dist/server/demo-upstream.js`).
// It is the credential boundary of the demo: Claude Code holds the proxy key, only the proxy holds THIS token, and the
// NetworkPolicy (pin 10) makes this server unreachable from anything but the proxy. Built on the same front (naming
// "tool": raw names, so the proxy sees `echo`, not `demo__echo`).
import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallHandler, IncomingCall, ToolInfo, ToolResult } from "../types/index.js";
import { startFront, type RunningFront } from "../front/contract.js";
import { readPrivateFile } from "./files.js";

export const DEMO_SERVER_NAME = "demo" as const;
export const DEMO_DEFAULT_PORT = 3001;
export const DEMO_PORT_ENV = "AGENT_LEDGER_DEMO_PORT" as const;
export const DEMO_TOKEN_FILE_ENV = "AGENT_LEDGER_DEMO_TOKEN_FILE" as const;
/** Default `0.0.0.0` (pin 6); tests set `127.0.0.1` (hard rule). Additive to pin 6's two variables; flagged. */
export const DEMO_BIND_HOST_ENV = "AGENT_LEDGER_DEMO_BIND_HOST" as const;
export const DEMO_WIPE_TEXT = "nothing was wiped: demo tool" as const;
export const DEMO_WHOAMI_TEXT = "demo upstream" as const;
export const DEMO_UNAUTHORIZED_TEXT = "unauthorized" as const;

/** The five tools, server `demo`. `wipe` is reviewed as RISKY and `whoami` is deliberately NOT in the registry (pin 6). */
export const DEMO_TOOLS: ToolInfo[] = [
  { server: DEMO_SERVER_NAME, name: "echo", description: "Returns the message you send.", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false }, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { server: DEMO_SERVER_NAME, name: "now", description: "Returns the current time as an ISO 8601 string.", inputSchema: { type: "object", additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { server: DEMO_SERVER_NAME, name: "add", description: "Adds two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { server: DEMO_SERVER_NAME, name: "wipe", description: "Pretends to wipe a target. Wipes nothing. Reviewed as risky so a no-channel denial can be demonstrated.", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] }, annotations: { destructiveHint: true, openWorldHint: false } },
  { server: DEMO_SERVER_NAME, name: "whoami", description: "Says who answered. Deliberately absent from the registry (unreviewed).", inputSchema: { type: "object", additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
];

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });
/** Constant-time equality over equal-length buffers; different lengths compare against self and answer false. */
export function tokenMatches(presented: string, expected: Buffer): boolean {
  const p = Buffer.from(presented, "utf8");
  const same = p.length === expected.length;
  return timingSafeEqual(same ? p : expected, expected) && same;
}

/** The demo handler: token check first (wrong → isError "unauthorized"), then the five tools. Never echoes the token. */
export function createDemoHandler(token: Buffer, log: (line: Record<string, unknown>) => void = () => undefined): CallHandler {
  return async (incoming: IncomingCall): Promise<ToolResult> => {
    const ok = incoming.credential?.kind === "api_key" && typeof incoming.credential.value === "string" && tokenMatches(incoming.credential.value, token);
    if (!ok) { log({ ts: new Date().toISOString(), event: "call", tool: incoming.tool, status: "unauthorized" }); return text(DEMO_UNAUTHORIZED_TEXT, true); }
    const result = run(incoming);
    log({ ts: new Date().toISOString(), event: "call", tool: incoming.tool, status: result.isError ? "error" : "ok" });
    return result;
  };
}
/**
 * F9: the demo enforces its own published `inputSchema` before a tool runs (tools page: servers MUST validate all tool
 * inputs). A deliberately small validator for the subset those five schemas use: `type` (object/string/number/integer/
 * boolean/array), `properties`, `required`, `additionalProperties: false`, `enum`; any other keyword (`$ref`, composition,
 * `items`, …) is "unsupported schema" and fails closed. Nothing is ever fetched. Returns a value-free problem or undefined.
 */
export function validateArgs(value: unknown, schema: unknown, at = "arguments", depth = 0): string | undefined {
  if (depth > 16) return `${at}: schema too deep`;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return `${at}: unsupported schema`;
  const s = schema as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!["type", "properties", "required", "additionalProperties", "enum", "description", "title", "$schema", "default", "examples"].includes(k)) return `${at}: unsupported schema keyword`;
  const type = s["type"];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (type !== undefined) {
    if (type === "integer" ? !Number.isInteger(value) : type === "number" ? typeof value !== "number" || !Number.isFinite(value) : actual !== type) return `${at}: expected ${String(type)}`;
  }
  if (Array.isArray(s["enum"]) && !s["enum"].some((e) => e === value)) return `${at}: not one of the allowed values`;
  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    const props = typeof s["properties"] === "object" && s["properties"] !== null ? (s["properties"] as Record<string, unknown>) : {};
    for (const r of Array.isArray(s["required"]) ? s["required"] : []) if (typeof r !== "string" || !Object.hasOwn(obj, r)) return `${at}: missing required property ${String(r).slice(0, 64)}`;
    for (const [k, v] of Object.entries(obj)) {
      if (Object.hasOwn(props, k)) { const problem = validateArgs(v, props[k], `${at}.${k}`, depth + 1); if (problem) return problem; }
      else if (s["additionalProperties"] === false) return `${at}: unexpected property ${k.slice(0, 64)}`;
    }
  }
  return undefined;
}
const schemaOf = new Map(DEMO_TOOLS.map((t) => [t.name, t.inputSchema] as const));
function run(incoming: IncomingCall): ToolResult {
  const a = incoming.args ?? {};
  const schema = schemaOf.get(incoming.tool);
  if (schema !== undefined) { const problem = validateArgs(a, schema); if (problem !== undefined) return text(`invalid arguments for ${incoming.tool}: ${problem}`, true); }
  switch (incoming.tool) {
    case "echo": return typeof a["message"] === "string" ? text(a["message"]) : text("echo: message must be a string", true);
    case "now": return text(new Date().toISOString());
    case "add": {
      const x = a["a"], y = a["b"];
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return text("add: a and b must be finite numbers", true);
      return text(String(x + y));
    }
    case "wipe": return typeof a["target"] === "string" ? text(DEMO_WIPE_TEXT) : text("wipe: target must be a string", true);
    case "whoami": return text(DEMO_WHOAMI_TEXT);
    default: return text(`unknown tool: ${incoming.tool}`, true);
  }
}

export interface DemoUpstreamOptions { port: number; bindHost: string; token: Buffer; log?: (line: Record<string, unknown>) => void; }
/** In-process start (tests and the entrypoint below share it). */
export async function startDemoUpstream(o: DemoUpstreamOptions): Promise<RunningFront> {
  if (!(o.token instanceof Buffer) || o.token.length === 0) throw new Error("demo-upstream: token must be a non-empty Buffer");
  return startFront(createDemoHandler(o.token, o.log), { mode: "http", port: o.port, bindHost: o.bindHost, allowedOrigins: [], naming: "tool", tools: async () => DEMO_TOOLS });
}

/** Entry point: env → token file → listen; one JSON line per event on stderr; SIGTERM/SIGINT → stop → exit 0. */
export async function demoMain(env: NodeJS.ProcessEnv = process.env, stderr: (s: string) => void = (s) => process.stderr.write(s)): Promise<RunningFront> {
  const log = (line: Record<string, unknown>) => stderr(`${JSON.stringify(line)}\n`);
  const refuse = (reason: string): never => { log({ ts: new Date().toISOString(), event: "refused", reason }); throw new Error(reason); };
  if (env["NODE_OPTIONS"] !== undefined) refuse("NODE_OPTIONS is set; the demo upstream refuses to start (spec §7 launch-environment residual)");
  const portRaw = env[DEMO_PORT_ENV] ?? String(DEMO_DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(portRaw) || Number(portRaw) > 65535) refuse(`${DEMO_PORT_ENV} must be an integer 0-65535`);
  const tokenFile = env[DEMO_TOKEN_FILE_ENV];
  if (typeof tokenFile !== "string" || tokenFile.length === 0) refuse(`${DEMO_TOKEN_FILE_ENV} is required (the token is never taken from argv)`);
  let token: Buffer;
  try { token = Buffer.from(readPrivateFile(tokenFile!, 4096).toString("utf8").trim(), "utf8"); } catch (e) { return refuse(`token file unreadable: ${e instanceof Error ? e.message : "error"}`); }
  if (token.length === 0) refuse("token file is empty");
  const bindHost = env[DEMO_BIND_HOST_ENV] ?? "0.0.0.0";
  const front = await startDemoUpstream({ port: Number(portRaw), bindHost, token, log });
  log({ ts: new Date().toISOString(), event: "listening", port: front.port, bindHost, tools: DEMO_TOOLS.map((t) => t.name) });
  return front;
}

let invokedDirectly = false;
try { invokedDirectly = !!process.argv[1] && realpathSync.native(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { /* imported */ }
if (invokedDirectly) {
  demoMain().then((front) => {
    const stop = () => { void front.stop().then(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  }, () => { process.exitCode = 1; });
}
