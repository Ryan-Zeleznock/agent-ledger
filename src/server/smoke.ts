// Slice 2a pin 8: the smoke client. `node dist/server/smoke.js --url <proxy mcp url> --key-file <path>
// [--expect-upstream-401 <upstream url>]`. One line per check, then `SMOKE PASS` / `SMOKE FAIL <check>`, exit 0/1.
// Used by B's integration Job (pin 12) and by Ryan from the Mac. The key is read from a file and never printed.
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROXY_NO_CHANNEL_REASON } from "../types/index.js";
import { JSONRPC_HEADER_MISMATCH } from "../front/contract.js";
import { mcpCall, mcpPost, toolText } from "./client.js";

export const SMOKE_EXPECTED_TOOLS = ["demo__add", "demo__echo", "demo__now", "demo__whoami", "demo__wipe"] as const;
export interface SmokeOptions { url: string; key: string; upstreamUrl?: string; }

/** Runs every check in order, stops at the first failure, prints through `out`, returns the exit code. */
export async function runSmoke(o: SmokeOptions, out: (line: string) => void): Promise<number> {
  const checks: [name: string, run: () => Promise<void>][] = [
    ["discover lists 2026-07-28", async () => {
      const r = await mcpCall(o.url, o.key, "server/discover");
      const versions = Array.isArray(r["supportedVersions"]) ? (r["supportedVersions"] as unknown[]) : [];
      must(versions.includes("2026-07-28"), `supportedVersions ${JSON.stringify(versions.filter((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)))} (${versions.length} entries)`);
    }],
    ["tools/list is exactly the five demo tools, sorted", async () => {
      const r = await mcpCall(o.url, o.key, "tools/list");
      const names = Array.isArray(r["tools"]) ? (r["tools"] as { name?: unknown }[]).map((t) => String(t.name)) : [];
      must(JSON.stringify(names) === JSON.stringify(SMOKE_EXPECTED_TOOLS), `got ${JSON.stringify(names.map((n) => (/^[A-Za-z0-9_.-]{1,128}$/.test(n) ? n : "<unprintable>")))}`);
    }],
    ["demo__echo ok", async () => { const r = await call("demo__echo", { message: "hello" }); must(r["isError"] === false && toolText(r) === "hello", describe(r)); }],
    ["demo__now ok", async () => { const r = await call("demo__now", {}); must(r["isError"] === false && Number.isFinite(Date.parse(toolText(r))), describe(r)); }],
    ["demo__add ok", async () => { const r = await call("demo__add", { a: 2, b: 3 }); must(r["isError"] === false && toolText(r) === "5", describe(r)); }],
    ["demo__wipe denied: no channel", async () => { const r = await call("demo__wipe", { target: "smoke" }); must(r["isError"] === true && toolText(r).includes(PROXY_NO_CHANNEL_REASON), describe(r)); }],
    ["demo__whoami denied: unreviewed", async () => { const r = await call("demo__whoami", {}); must(r["isError"] === true && /unreviewed/.test(toolText(r)), describe(r)); }],
    ["no bearer → 401", async () => { const r = await mcpPost({ url: o.url, method: "server/discover" }); must(r.status === 401 && (r.headers.get("www-authenticate") ?? "").startsWith("Bearer"), `HTTP ${r.status}`); }],
    ["wrong key → denied (unknown agent), not executed", async () => {
      const r = await mcpCall(o.url, `${o.key}-wrong`, "tools/call", { name: "demo__echo", arguments: { message: "hello" } });
      must(r["isError"] === true && /unknown agent/.test(toolText(r)), describe(r));
    }],
    ["missing Mcp-Name → 400 -32020", async () => {
      const r = await mcpPost({ url: o.url, token: o.key, method: "tools/call", params: { name: "demo__echo", arguments: { message: "x" } }, headers: { "mcp-name": null } });
      const code = (r.json as { error?: { code?: number } } | undefined)?.error?.code;
      must(r.status === 400 && code === JSONRPC_HEADER_MISMATCH, `HTTP ${r.status} code ${String(code)}`);
    }],
    ["GET /mcp → 405", async () => { const r = await mcpPost({ url: o.url, token: o.key, method: "server/discover", httpMethod: "GET" }); must(r.status === 405, `HTTP ${r.status}`); }],
  ];
  if (o.upstreamUrl !== undefined) {
    const upstream = o.upstreamUrl;
    checks.push(["upstream direct, no token → 401", async () => { const r = await mcpPost({ url: upstream, method: "server/discover" }); must(r.status === 401, `HTTP ${r.status}`); }]);
    checks.push(["upstream direct, the agent's key → unauthorized (the proxy key is not the upstream's credential)", async () => {
      const r = await mcpCall(upstream, o.key, "tools/call", { name: "echo", arguments: { message: "x" } });
      must(r["isError"] === true && toolText(r) === "unauthorized", describe(r));
    }]);
  }
  for (const [name, run] of checks) {
    try { await run(); out(`ok ${name}`); }
    catch (e) { out(`FAIL ${name}: ${e instanceof Error ? `${e.name}: ${e.message}` : "error"}`); out(`SMOKE FAIL ${name}`); return 1; }
  }
  out("SMOKE PASS");
  return 0;

  function call(name: string, args: Record<string, unknown>) { return mcpCall(o.url, o.key, "tools/call", { name, arguments: args }); }
}
function must(ok: boolean, detail: string): void { if (!ok) throw new Error(detail); }
/** Value-free (F1): the smoke output is pod-log evidence, so a failing check reports shape, never remote text. */
function describe(r: Record<string, unknown>): string { return `isError=${String(r["isError"])} blocks=${Array.isArray(r["content"]) ? r["content"].length : "none"} textBytes=${Buffer.byteLength(toolText(r))}`; }

export function parseSmokeArgs(argv: string[]): SmokeOptions {
  const { values } = parseArgs({ args: argv, options: { url: { type: "string" }, "key-file": { type: "string" }, "expect-upstream-401": { type: "string" } }, strict: true, allowPositionals: false });
  if (!values.url || !values["key-file"]) throw new Error("usage: smoke --url <proxy mcp url> --key-file <path> [--expect-upstream-401 <upstream mcp url>]");
  const key = readFileSync(values["key-file"], "utf8").trim();
  if (key.length === 0) throw new Error("key file is empty");
  const o: SmokeOptions = { url: values.url, key };
  if (values["expect-upstream-401"]) o.upstreamUrl = values["expect-upstream-401"];
  return o;
}

let invokedDirectly = false;
try { invokedDirectly = !!process.argv[1] && realpathSync.native(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { /* imported */ }
if (invokedDirectly) {
  let opts: SmokeOptions;
  try { opts = parseSmokeArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 2; opts = undefined as never; }
  if (opts!) process.exitCode = await runSmoke(opts, (line) => process.stdout.write(`${line}\n`));
}
