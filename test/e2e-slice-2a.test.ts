import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LedgerRecord } from "../src/types/index.js";
import { PROXY_NO_CHANNEL_REASON } from "../src/types/index.js";
import { createLedger } from "../src/ledger/contract.js";
import { createRunner, parseCsv, pdfText, readJsonl, type Run } from "./helpers/e2e-demo.js";
import { startServerProcess, type ServerProcess } from "./helpers/e2e-server.js";
import { META_SERVER_INFO, mcpCall, mcpPost, toolText } from "./helpers/mcp-client.js";

/**
 * Slice 2a end to end (docs/slices/slice-2a-pins.md "Integration seams", steps 1-12). REAL processes from a private build
 * root (tsconfig.build.json into a tmp --outDir, plus policies, package.json and a node_modules symlink, as in 1b/1c):
 * the demo upstream (`dist/server/demo-upstream.js`, token T), the proxy (`dist/server/main.js`, API key K in
 * agents.yaml, the five pin 6 registry rows), the CLI (`dist/cli/main.js`), and `dist/server/smoke.js`; the 2026-07-28
 * client is test/helpers/mcp-client.ts. Ledger: jsonl behind a file:// URL, or `AGENT_LEDGER_E2E_LEDGER=<postgres url>`
 * (the coordinator's docker-less Postgres run after both reviews; `AGENT_LEDGER_E2E_LEDGER_PASSWORD` fills ledger.password,
 * PGPASSWORD reaches the CLI). Every server binds 127.0.0.1 on an ephemeral port (hard rule). Sequential: one sandbox.
 *
 * Seam made visible, not hidden: until B's pin 1 line (`APPROVAL_CHANNEL_KINDS` in src/ledger/validate.ts) is on the
 * branch under test, a `channel: "none"` record is refused by the ledger and the proxy fails closed with
 * "ledger unavailable" instead of the no-channel text; steps 5, 6 and the PASS half of 9 self-skip with that reason.
 */

const K = "e2e-proxy-key-canary-91f3c2d7a4"; const T = "e2e-upstream-token-canary-5b8e0a1c";
const CLEAR_CANARY = "e2e-clear-canary-2d7f"; const HASHED_CANARY = "e2e-hashed-canary-7a1e"; const NODE_OPTIONS_CANARY = "e2e-nodeopt-canary-c4b2";
const PG_URL = process.env["AGENT_LEDGER_E2E_LEDGER"];
const PG_PASSWORD = process.env["AGENT_LEDGER_E2E_LEDGER_PASSWORD"] ?? "e2e-unused-trust-auth-password";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const EXPECTED_NAMES = ["demo__add", "demo__echo", "demo__now", "demo__whoami", "demo__wipe"];
/** The five pin 6 rows, exactly as deploy/k8s/config/registry.yaml must ship them; that file is used when present (B's package). */
const PIN6_REGISTRY = `version: 1
servers:
  demo:
    trusted: true
    tools:
      echo: { class: read, reviewedBy: ryan, reviewedAt: 2026-10-03, storeArgs: [message] }
      now: { class: read, reviewedBy: ryan, reviewedAt: 2026-10-03 }
      add: { class: write, reviewedBy: ryan, reviewedAt: 2026-10-03, storeArgs: [a, b] }
      wipe: { class: risky, reviewedBy: ryan, reviewedAt: 2026-10-03, storeArgs: [] }
`;
const SHIPPED_REGISTRY = resolve("deploy/k8s/config/registry.yaml");

const transcript: string[] = [];
const run = createRunner(transcript);
const responses: string[] = [];                          // every proxy response body seen by the client (step 8, step 12)
let root: string; let sandbox: string; let configDir: string; let ledgerDir: string; let ledgerPath: string; let anchorsPath: string;
let cli: string; let smokeJs: string; let keyFile: string; let wrongKeyFile: string;
let demo: ServerProcess; let proxy: ServerProcess; let demoUrl = ""; let proxyUrl = ""; let proxyPort = 0;
let cliEnv: NodeJS.ProcessEnv; let serverEnv: NodeJS.ProcessEnv;
let startedAt: number; let noneOk = false; let registrySource = "";
let callIds: Record<string, string> = {};               // step → callId as the proxy log reported it
let packDir = ""; let anchorLine = "";

const post = async (o: Omit<Parameters<typeof mcpPost>[0], "url">) => { const r = await mcpPost({ url: proxyUrl, ...o }); responses.push(r.text); return r; };
const call = async (name: string, args: Record<string, unknown>, key = K) => { const r = await mcpPost({ url: proxyUrl, token: key, method: "tools/call", params: { name, arguments: args } }); responses.push(r.text); expect(r.status, r.text).toBe(200); return (r.json as { result: Record<string, unknown> }).result; };
const rpcErr = (r: { json: unknown }) => (r.json as { error?: { code: number; message: string; data?: unknown } }).error;
async function records(): Promise<LedgerRecord[]> {
  if (!PG_URL) return existsSync(ledgerPath) ? readJsonl<LedgerRecord>(ledgerPath) : [];
  const out: LedgerRecord[] = [];
  for await (const r of createLedger("postgres", PG_URL).read({ from: new Date(startedAt - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() })) out.push(r);
  return out;
}
const byCall = (recs: LedgerRecord[], callId: string) => ({ intent: recs.find((r) => r.phase === "intent" && r.call.callId === callId), outcome: recs.find((r) => r.phase === "outcome" && r.call.callId === callId) });
const callLines = () => proxy.events().filter((e) => typeof e["callId"] === "string");
const lastCallLine = () => callLines().at(-1)!;
const demoCalls = () => demo.events().filter((e) => e["event"] === "call").map((e) => [e["tool"], e["status"]]);
const agentLedger = (args: string[]) => run(process.execPath, [cli, ...args], { cwd: sandbox, env: cliEnv });
const ledgerArgs = () => (PG_URL ? ["--ledger", PG_URL, "--dir", ledgerDir] : ["--dir", ledgerDir]);
const write = (p: string, s: string | Buffer, mode = 0o600) => { writeFileSync(p, s, { mode }); chmodSync(p, mode); };

async function startProxy(extraEnv: NodeJS.ProcessEnv = {}): Promise<ServerProcess> {
  const p = startServerProcess(join(root, "dist/server/main.js"), { ...serverEnv, ...extraEnv }, sandbox, transcript);
  const listening = await p.waitFor((e) => e["event"] === "listening");
  proxyPort = Number(listening["port"]); proxyUrl = `http://127.0.0.1:${proxyPort}/mcp`;
  return p;
}

beforeAll(async () => {
  startedAt = Date.now();
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-ledger-e2e2a-")));
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", join(root, "dist")], { stdio: "pipe" });
  cli = join(root, "dist/cli/main.js"); chmodSync(cli, 0o755);
  smokeJs = join(root, "dist/server/smoke.js");
  cpSync(resolve("policies"), join(root, "policies"), { recursive: true });
  copyFileSync(resolve("package.json"), join(root, "package.json"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"));
  sandbox = join(root, "sandbox"); mkdirSync(sandbox, { mode: 0o700 });
  configDir = join(sandbox, "config"); mkdirSync(configDir, { mode: 0o700 });
  ledgerDir = join(sandbox, "lab"); mkdirSync(join(ledgerDir, "ledger"), { recursive: true, mode: 0o700 });
  ledgerPath = join(ledgerDir, "ledger", "records.jsonl"); anchorsPath = join(ledgerDir, "anchors.jsonl");
  // config: the registry B ships when present (steps 2-6 run against the SAME file), the five pin 6 rows otherwise
  registrySource = existsSync(SHIPPED_REGISTRY) ? SHIPPED_REGISTRY : "pin 6 rows (deploy/k8s/config/registry.yaml not on this branch)";
  write(join(configDir, "registry.yaml"), existsSync(SHIPPED_REGISTRY) ? readFileSync(SHIPPED_REGISTRY) : PIN6_REGISTRY);
  write(join(configDir, "agents.yaml"), JSON.stringify({ version: 1, agents: [{ id: "claude-lab", credential: { kind: "api_key", sha256: sha256(K) } }] }));
  write(join(configDir, "hmac.key"), randomBytes(32));
  mkdirSync(join(configDir, "secrets"), { mode: 0o700 }); write(join(configDir, "secrets", "demo.bearerToken"), `${T}\n`);
  write(join(configDir, "ledger.password"), `${PG_PASSWORD}\n`);
  const tokenFile = join(sandbox, "demo-token"); write(tokenFile, `${T}\n`);
  keyFile = join(sandbox, "api-key"); write(keyFile, `${K}\n`);
  wrongKeyFile = join(sandbox, "wrong-key"); write(wrongKeyFile, "not-the-key\n");
  const base: NodeJS.ProcessEnv = { PATH: process.env["PATH"], HOME: process.env["HOME"], TMPDIR: process.env["TMPDIR"] };
  demo = startServerProcess(join(root, "dist/server/demo-upstream.js"), { ...base, AGENT_LEDGER_DEMO_PORT: "0", AGENT_LEDGER_DEMO_BIND_HOST: "127.0.0.1", AGENT_LEDGER_DEMO_TOKEN_FILE: tokenFile }, sandbox, transcript);
  const demoListening = await demo.waitFor((e) => e["event"] === "listening");
  demoUrl = `http://127.0.0.1:${String(demoListening["port"])}/mcp`;
  write(join(configDir, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${demoUrl}\n`);
  serverEnv = { ...base, AGENT_LEDGER_CONFIG_DIR: configDir, AGENT_LEDGER_LEDGER_URL: PG_URL ?? pathToFileURL(ledgerPath).toString(), AGENT_LEDGER_PORT: "0", AGENT_LEDGER_BIND_HOST: "127.0.0.1", AGENT_LEDGER_ALLOWED_ORIGINS: "", AGENT_LEDGER_APPROVALS: "none" };
  cliEnv = { ...base, NODE_OPTIONS: `--title=${NODE_OPTIONS_CANARY}`, ...(process.env["PGPASSWORD"] ? { PGPASSWORD: process.env["PGPASSWORD"] } : {}) };
  proxy = await startProxy();
  // the seam probe: does the ledger under test accept channel "none" yet?
  const probe = createLedger("jsonl", join(sandbox, "probe.jsonl"));
  noneOk = await probe.append({ id: "p", phase: "intent", call: { callId: "p", sessionId: "s", agentId: "a", server: "x", tool: "y", args: {}, receivedAt: new Date().toISOString() }, policy: { verdict: "require_approval", risk: "risky", ruleId: "registry:x/y", reason: "r" }, approval: { callId: "p", decision: "no-channel", reason: PROXY_NO_CHANNEL_REASON, decidedAt: new Date().toISOString(), channel: "none" } }).then(() => true, () => false);
}, 180_000);
afterAll(async () => {
  if (proxy) await proxy.stop(5_000).catch(() => undefined);
  if (demo) await demo.stop(5_000).catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.sequential("Slice 2a demo path: proxy → policy → ledger → demo upstream, real processes, built artifacts", () => {
  it("1. GET /healthz is 200 before any auth; the proxy stderr shows the ledger head line, the upstream line and the listening line, and no key, token or URL", async () => {
    const r = await fetch(`http://127.0.0.1:${proxyPort}/healthz`);
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ ok: true });
    const ev = proxy.events();
    expect(ev.map((e) => e["event"])).toEqual(["ledger", "upstreams", "listening"]);
    expect(ev[0]).toMatchObject({ backend: PG_URL ? "postgres" : "jsonl", head: expect.stringMatching(/^(0|[0-9a-f]{64})$/) });
    expect(ev[1]).toMatchObject({ servers: ["demo"], tools: 5 });
    expect(ev[2]).toMatchObject({ bindHost: "127.0.0.1", approvals: "none" });
    const text = proxy.stderr.join("\n");
    expect(text).not.toContain(K); expect(text).not.toContain(T); expect(text).not.toContain(serverEnv["AGENT_LEDGER_LEDGER_URL"]!); expect(text).not.toContain(PG_PASSWORD);
    expect(registrySource.length).toBeGreaterThan(0);
  });
  it("2. server/discover lists 2026-07-28; tools/list is demo__add, demo__echo, demo__now, demo__whoami, demo__wipe in that order with ttlMs, cacheScope, resultType and serverInfo", async () => {
    const d = await post({ token: K, method: "server/discover" });
    expect(d.status).toBe(200);
    const discover = (d.json as { result: Record<string, unknown> }).result;
    expect(discover).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 3_600_000, cacheScope: "private" });
    expect((discover["_meta"] as Record<string, unknown>)[META_SERVER_INFO]).toMatchObject({ name: "agent-ledger" });
    const l = await post({ token: K, method: "tools/list" });
    const list = (l.json as { result: Record<string, unknown> }).result;
    expect((list["tools"] as { name: string; description: string }[]).map((t) => t.name)).toEqual(EXPECTED_NAMES);
    expect((list["tools"] as { description: string }[]).every((t) => t.description.startsWith("[demo] "))).toBe(true);
    expect(list).toMatchObject({ resultType: "complete", ttlMs: 60_000, cacheScope: "private" });
    expect(Object.hasOwn(list, "nextCursor")).toBe(false);
  });
  it("3. demo__echo { message: '<clear canary>' } runs: ok; intent + outcome; message in the clear; no agentSessionId; no approval; ruleId registry:demo/echo; the per-call log line is pinned and value-free", async () => {
    const r = await call("demo__echo", { message: `hello ${CLEAR_CANARY}` });
    expect(r).toMatchObject({ resultType: "complete", isError: false }); expect(toolText(r)).toBe(`hello ${CLEAR_CANARY}`);
    const line = lastCallLine(); callIds["echo"] = line["callId"] as string;
    expect(Object.keys(line)).toEqual(["ts", "callId", "agentId", "server", "tool", "verdict", "ruleId", "status", "ms"]);
    expect(line).toMatchObject({ agentId: "claude-lab", server: "demo", tool: "echo", verdict: "allow", ruleId: "registry:demo/echo", status: "ok" });
    const { intent, outcome } = byCall(await records(), callIds["echo"]!);
    expect(intent).toBeDefined(); expect(outcome).toBeDefined();
    expect(intent!.call).toMatchObject({ agentId: "claude-lab", server: "demo", tool: "echo", args: { message: `hello ${CLEAR_CANARY}` } });
    expect(intent!.call.agentSessionId).toBeUndefined(); expect(intent!.approval).toBeUndefined();
    expect(intent!.policy).toEqual({ verdict: "allow", risk: "read", ruleId: "registry:demo/echo", reason: expect.any(String) });
    expect(outcome!.outcome).toMatchObject({ status: "ok", durationMs: expect.any(Number) });
    expect(outcome!.parentRecordId).toBe(intent!.id); expect(outcome!.prevHash).toBe(intent!.hash);
    expect(demoCalls()).toEqual([["echo", "ok"]]);
  });
  it("4. demo__add { a: 2, b: 3, note: '<hashed canary>' } runs: ok; a and b in the clear (storeArgs [a, b]), note stored as hmac-sha256:", async () => {
    const r = await call("demo__add", { a: 2, b: 3, note: HASHED_CANARY });
    expect(r["isError"]).toBe(false); expect(toolText(r)).toBe("5");
    callIds["add"] = lastCallLine()["callId"] as string;
    expect(lastCallLine()).toMatchObject({ tool: "add", verdict: "allow", ruleId: "registry:demo/add", status: "ok" });
    const { intent, outcome } = byCall(await records(), callIds["add"]!);
    expect(intent!.call.args).toMatchObject({ a: 2, b: 3 }); expect(intent!.call.args["note"]).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(intent!.policy.risk).toBe("write"); expect(outcome!.outcome!.status).toBe("ok");
    expect(demoCalls()).toEqual([["echo", "ok"], ["add", "ok"]]);
  });
  it("5. demo__wipe { target: 'prod' } is denied: isError with PROXY_NO_CHANNEL_REASON; intent carries approval { no-channel, channel none }; a blocked outcome follows; the upstream's own log shows NO call", async (ctx) => {
    const r = await call("demo__wipe", { target: "prod" });
    expect(r["isError"]).toBe(true); expect(toolText(r)).not.toContain("nothing was wiped");
    const line = lastCallLine(); callIds["wipe"] = line["callId"] as string;
    expect(line).toMatchObject({ tool: "wipe", verdict: "require_approval", ruleId: "registry:demo/wipe" });
    expect(demoCalls()).toEqual([["echo", "ok"], ["add", "ok"]]);
    if (!noneOk) { expect(toolText(r)).toMatch(/ledger unavailable/); ctx.skip(); return; } // B's validator line (pin 1) not on this branch: fails closed, see file header
    expect(toolText(r)).toBe(`agent-ledger: denied (risky; registry:demo/wipe): ${PROXY_NO_CHANNEL_REASON}`);
    expect(line["status"]).toBe("blocked");
    const { intent, outcome } = byCall(await records(), callIds["wipe"]!);
    expect(intent!.approval).toMatchObject({ callId: callIds["wipe"], decision: "no-channel", channel: "none", reason: PROXY_NO_CHANNEL_REASON });
    expect(intent!.policy).toMatchObject({ verdict: "require_approval", risk: "risky", ruleId: "registry:demo/wipe" });
    expect(intent!.call.args["target"]).toMatch(/^hmac-sha256:/); // storeArgs []
    expect(outcome!.outcome).toEqual({ status: "blocked" });
  });
  it("6. demo__whoami is denied as unreviewed: ruleId unreviewed:demo/whoami, risk unreviewed, no-channel, blocked; the upstream still saw no call", async (ctx) => {
    const r = await call("demo__whoami", {});
    expect(r["isError"]).toBe(true); expect(toolText(r)).not.toContain("demo upstream");
    const line = lastCallLine(); callIds["whoami"] = line["callId"] as string;
    expect(line).toMatchObject({ tool: "whoami", verdict: "require_approval", ruleId: "unreviewed:demo/whoami" });
    expect(demoCalls()).toEqual([["echo", "ok"], ["add", "ok"]]);
    if (!noneOk) { expect(toolText(r)).toMatch(/ledger unavailable/); ctx.skip(); return; }
    expect(toolText(r)).toBe(`agent-ledger: denied (unreviewed; unreviewed:demo/whoami): ${PROXY_NO_CHANNEL_REASON}`);
    const { intent, outcome } = byCall(await records(), callIds["whoami"]!);
    expect(intent!.policy).toMatchObject({ risk: "unreviewed", ruleId: "unreviewed:demo/whoami" });
    expect(intent!.approval).toMatchObject({ decision: "no-channel", channel: "none" });
    expect(outcome!.outcome).toEqual({ status: "blocked" });
  });
  it("7. protocol and auth rejections write no record: no bearer 401; wrong key denied by identity; missing Mcp-Name 400 -32020; 2025-11-25 400 -32022; evil Origin 403; GET 405; legacy initialize 400 -32020 naming 2026-07-28 (modern-framed: 404 -32601); notification 202; 2 MiB 413", async () => {
    const before = (await records()).length;
    const noBearer = await post({ method: "server/discover" });
    expect(noBearer.status).toBe(401); expect(noBearer.headers.get("www-authenticate")).toBe('Bearer realm="agent-ledger"');
    // the front does not authenticate (identity does, in the pipeline): a well-formed wrong key is an isError deny with no record; pin 8/step 7 says 401, flagged
    const wrong = await call("demo__echo", { message: "x" }, "e2e-wrong-key");
    expect(wrong["isError"]).toBe(true); expect(toolText(wrong)).toMatch(/unknown agent/);
    expect(lastCallLine()).toMatchObject({ tool: "echo", status: "denied" }); expect(lastCallLine()["agentId"]).toBeUndefined();
    const noName = await post({ token: K, method: "tools/call", params: { name: "demo__echo", arguments: { message: "x" } }, headers: { "mcp-name": null } });
    expect(noName.status).toBe(400); expect(rpcErr(noName)!.code).toBe(-32020);
    const old = await post({ token: K, method: "server/discover", protocolVersion: "2025-11-25" });
    expect(old.status).toBe(400); expect(rpcErr(old)).toMatchObject({ code: -32022, data: { supported: ["2026-07-28"], requested: "2025-11-25" } });
    const evil = await post({ token: K, method: "server/discover", headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403); expect(Object.hasOwn(evil.json as object, "id")).toBe(false);
    expect((await post({ token: K, method: "server/discover", httpMethod: "GET" })).status).toBe(405);
    // F6: a legacy initialize (no headers) fails HTTP validation first (400 -32020, versioning matrix) and the error still names 2026-07-28; a modern-framed initialize is the unknown method (404 -32601)
    const init = await post({ token: K, method: "initialize", meta: false, params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } }, headers: { "mcp-protocol-version": null, "mcp-method": null } });
    expect(init.status).toBe(400); expect(rpcErr(init)!.code).toBe(-32020); expect(rpcErr(init)!.message).toContain("2026-07-28"); expect(rpcErr(init)!.data).toEqual({ supported: ["2026-07-28"] });
    const initModern = await post({ token: K, method: "initialize" });
    expect(initModern.status).toBe(404); expect(rpcErr(initModern)!.code).toBe(-32601); expect(rpcErr(initModern)!.message).toContain("2026-07-28");
    const note = await post({ token: K, method: "notifications/initialized", notification: true });
    expect(note.status).toBe(202); expect(note.text).toBe("");
    const big = await post({ token: K, method: "server/discover", rawBody: "x".repeat(2 * 1024 * 1024) });
    expect(big.status).toBe(413);
    expect((await records()).length).toBe(before);
    expect(demoCalls()).toEqual([["echo", "ok"], ["add", "ok"]]);
  });
  it("8. the agent's key is not the upstream's credential: a direct tools/call to the demo upstream with K is unauthorized (isError), with no bearer 401; the upstream token never appears in any proxy response", async () => {
    const direct = await mcpCall(demoUrl, K, "tools/call", { name: "echo", arguments: { message: "x" } });
    expect(direct["isError"]).toBe(true); expect(toolText(direct)).toBe("unauthorized");
    expect((await mcpPost({ url: demoUrl, method: "server/discover" })).status).toBe(401);
    expect(toolText(await mcpCall(demoUrl, T, "tools/call", { name: "echo", arguments: { message: "direct" } }))).toBe("direct"); // the real credential works, so the refusal above was about the key
    expect(responses.join("\n")).not.toContain(T);
    expect(demoCalls()).toEqual([["echo", "ok"], ["add", "ok"], ["echo", "unauthorized"], ["echo", "ok"]]);
  });
  it("9. smoke.js against the same sandbox: SMOKE PASS exit 0 (fails exactly at demo__wipe until B's validator line lands); a wrong key file → SMOKE FAIL exit 1; the key is never printed", async () => {
    const ok = await run(process.execPath, [smokeJs, "--url", proxyUrl, "--key-file", keyFile, "--expect-upstream-401", demoUrl], { cwd: sandbox, env: cliEnv, timeoutMs: 60_000 });
    const lines = ok.stdout.trim().split("\n");
    if (noneOk) { expect(ok.code, ok.stdout + ok.stderr).toBe(0); expect(lines.at(-1)).toBe("SMOKE PASS"); expect(lines.filter((l) => l.startsWith("ok ")).length).toBe(13); }
    else { expect(ok.code).toBe(1); expect(lines.at(-1)).toBe("SMOKE FAIL demo__wipe denied: no channel"); expect(lines.slice(0, 5).every((l) => l.startsWith("ok "))).toBe(true); }
    const bad = await run(process.execPath, [smokeJs, "--url", proxyUrl, "--key-file", wrongKeyFile], { cwd: sandbox, env: cliEnv, timeoutMs: 60_000 });
    expect(bad.code).toBe(1); expect(bad.stdout.trim().split("\n").at(-1)).toMatch(/^SMOKE FAIL /);
    expect(ok.stdout + ok.stderr + bad.stdout + bad.stderr).not.toContain(K);
    expect(demoCalls().filter(([tool]) => tool === "wipe" || tool === "whoami")).toEqual([]);
  });
  it("10. evidence from the Mac side: anchor → head; verify exit 0 head; report renders executed (allowed) for 3-4 and denied: no channel for 5-6 (when recorded); the CC8.1 table has the non-read rows", async () => {
    const anchor = await agentLedger(["anchor", ...ledgerArgs()]);
    expect(anchor.code, anchor.stderr).toBe(0);
    const a = JSON.parse(anchor.stdout) as { anchored: boolean; entry: { hash: string }; line: string; path: string };
    expect(a.anchored).toBe(true); expect(a.path).toBe(anchorsPath); anchorLine = a.line;
    const verify = await agentLedger(["verify", ...ledgerArgs()]);
    expect(verify.code, verify.stderr).toBe(0);
    const v = JSON.parse(verify.stdout) as { chain: { ok: boolean; checked: number }; head: string; anchor: { status: string } };
    expect(v.chain.ok).toBe(true); expect(v.head).toBe(a.entry.hash); expect(v.anchor.status).toBe("head");
    expect(v.chain.checked).toBe((await records()).length); // steps 3-4 plus the smoke run of step 9
    packDir = join(sandbox, "pack");
    const report = await agentLedger(["report", ...ledgerArgs(), "--from", new Date(startedAt - 60_000).toISOString(), "--to", new Date(Date.now() + 60_000).toISOString(), "--out", packDir]);
    expect(report.code, report.stderr).toBe(0);
    const out = JSON.parse(report.stdout) as { htmlPath: string; pdfPath: string; csvPath: string; chain: { ok: boolean }; anchor: { status: string } };
    expect(out.chain.ok).toBe(true); expect(out.anchor.status).toBe("head");
    const csv = parseCsv(readFileSync(out.csvPath, "utf8"));
    const header = csv[0]!; const col = (n: string) => header.indexOf(n);
    expect([col("call_id"), col("phase"), col("evidence_class")].every((i) => i >= 0)).toBe(true);
    const cls = (id: string) => csv.slice(1).filter((r) => r[col("call_id")] === id && r[col("phase")] === "intent").map((r) => r[col("evidence_class")]);
    expect(cls(callIds["echo"]!)).toEqual(["executed (allowed)"]); expect(cls(callIds["add"]!)).toEqual(["executed (allowed)"]);
    const html = readFileSync(out.htmlPath, "utf8");
    const change = html.split('<section id="cc8-1">')[1]!.split("</section>")[0]!;
    const rows = [...change.split("<tbody>")[1]!.split("</tbody>")[0]!.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) => [...m[1]!.matchAll(/<td(?: colspan="\d+")?>(.*?)<\/td>/gs)].map((c) => c[1]!)).filter((r) => !(r.length === 1 && r[0] === "None"));
    // CC8.1 lists write/risky/unreviewed decisions; read rows (echo, now) are excluded by the renderer, so the pins' "four rows"
    // for steps 3-6 is three (add, wipe, whoami), each present TWICE here because step 9's smoke run repeats the sequence.
    const tally = new Map<string, number>();
    for (const r of rows) tally.set(JSON.stringify([r[2], r[3], r[6]]), (tally.get(JSON.stringify([r[2], r[3], r[6]])) ?? 0) + 1);
    const expectRows = (entries: [string[], number][]) => expect(Object.fromEntries(tally)).toEqual(Object.fromEntries(entries.map(([k, n]) => [JSON.stringify(k), n])));
    if (noneOk) {
      expect(cls(callIds["wipe"]!)).toEqual(["denied: no channel"]); expect(cls(callIds["whoami"]!)).toEqual(["denied: no channel"]);
      expectRows([[["demo/add", "write", "executed (allowed)"], 2], [["demo/wipe", "risky", "denied: no channel"], 2], [["demo/whoami", "unreviewed", "denied: no channel"], 2]]);
      expect(rows.find((r) => r[2] === "demo/wipe")![4]).toBe("no-channel, not recorded");
      expect(pdfText(readFileSync(out.pdfPath))).toContain("denied: no channel");
    } else {
      expectRows([[["demo/add", "write", "executed (allowed)"], 2]]);
    }
    expect(html).toContain("executed (allowed)");
  });
  it("11. SIGTERM with a call in flight against a deliberately PENDING upstream, twice: the proxy exits 0 within 10 s, the in-flight call's intent gets an `error` outcome (UpstreamClosed) persisted BEFORE exit, drained:true; NODE_OPTIONS set → it refuses to start", async () => {
    // a second config: the demo plus a `slow` upstream (in this process, loopback) whose tools/call is never answered
    const held: ServerResponse[] = [];
    const slow: Server = createServer((req, res) => {
      const chunks: Buffer[] = []; req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: unknown; method: string };
        const json = (result: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result })); };
        if (body.method === "server/discover") return json({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: {}, ttlMs: 1, cacheScope: "public" });
        if (body.method === "tools/list") return json({ resultType: "complete", tools: [{ name: "wait", description: "never answers", inputSchema: { type: "object" } }], ttlMs: 1, cacheScope: "public" });
        held.push(res); // tools/call: hold forever
      });
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/mcp`;
    const configDir2 = join(sandbox, "config-slow"); cpSync(configDir, configDir2, { recursive: true });
    write(join(configDir2, "registry.yaml"), `${PIN6_REGISTRY}  slow:\n    trusted: true\n    tools:\n      wait: { class: read, reviewedBy: ryan, reviewedAt: 2026-10-03 }\n`);
    write(join(configDir2, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${demoUrl}\n  - name: slow\n    transport: http\n    url: ${slowUrl}\n`);
    try {
      await proxy.stop(5_000);
      for (let round = 1; round <= 2; round++) {
        const before = (await records()).filter((r) => r.phase === "intent" && r.call.tool === "wait").length;
        proxy = await startProxy({ AGENT_LEDGER_CONFIG_DIR: configDir2 });
        const inflight = mcpPost({ url: proxyUrl, token: K, method: "tools/call", params: { name: "slow__wait", arguments: {} } }).then((r) => r.text, () => "connection closed");
        // latch on BOTH the upstream's receipt of this exact call and its durable intent record
        const t0 = Date.now();
        while (held.length < round) { if (Date.now() - t0 > 10_000) throw new Error("slow upstream never received the call"); await new Promise((r) => setTimeout(r, 25)); }
        let intent: LedgerRecord | undefined;
        while (!intent) { if (Date.now() - t0 > 10_000) throw new Error("no intent record for slow__wait"); intent = (await records()).filter((r) => r.phase === "intent" && r.call.tool === "wait")[before]; if (!intent) await new Promise((r) => setTimeout(r, 25)); }
        const stopped = await proxy.stop();
        expect(stopped.code, `round ${round}`).toBe(0); expect(stopped.signal).toBeNull(); expect(stopped.ms).toBeLessThan(10_000);
        expect(proxy.events().some((e) => e["event"] === "shutdown" && e["signal"] === "SIGTERM")).toBe(true);
        expect(proxy.events().at(-1)).toMatchObject({ event: "stopped", drained: true, inflight: 0 });
        responses.push(await inflight);
        const recs = await records();
        const outcome = recs.find((r) => r.phase === "outcome" && r.call.callId === intent!.call.callId);
        expect(outcome?.outcome, `round ${round}: the in-flight call's outcome was persisted before exit`).toMatchObject({ status: "error", errorClass: "UpstreamClosed" });
        expect(proxy.events().find((e) => e["callId"] === intent!.call.callId)).toMatchObject({ tool: "wait", status: "error" });
        const intents = recs.filter((r) => r.phase === "intent").map((r) => r.call.callId);
        const outcomes = new Set(recs.filter((r) => r.phase === "outcome").map((r) => r.call.callId));
        expect(intents.filter((id) => !outcomes.has(id))).toEqual([]); // never a missing outcome
        for (const r of recs.filter((r) => r.phase === "outcome")) expect(["ok", "error", "blocked"]).toContain(r.outcome!.status);
      }
    } finally { for (const r of held) r.destroy(); slow.closeAllConnections(); await new Promise<void>((r) => slow.close(() => r())); }
    const refused = startServerProcess(join(root, "dist/server/main.js"), { ...serverEnv, NODE_OPTIONS: `--title=${NODE_OPTIONS_CANARY}` }, sandbox, transcript);
    const exit = await refused.exited;
    expect(exit.code).toBe(1);
    expect(refused.events().at(-1)).toMatchObject({ event: "refused", reason: expect.stringMatching(/NODE_OPTIONS is set/) });
    expect(refused.stderr.join("\n")).not.toContain(NODE_OPTIONS_CANARY);
  }, 90_000);
  it("12. leak sweep: K, T, the hashed canary, the Postgres URL/password and the NODE_OPTIONS canary are absent from the ledger, both process outputs, the pack, the anchor and the smoke output; the clear canary is in the ledger by design", async () => {
    const ledgerDump = PG_URL ? JSON.stringify(await records()) : readFileSync(ledgerPath, "utf8");
    const pack = ["report.html", "report.pdf", "records.csv"].map((f) => readFileSync(join(packDir, f)).toString("latin1")).join("\n");
    const everything = [ledgerDump, transcript.join("\n"), responses.join("\n"), pack, anchorLine, readFileSync(anchorsPath, "utf8")].join("\n");
    for (const secret of [K, T, HASHED_CANARY, NODE_OPTIONS_CANARY, PG_PASSWORD, ...(PG_URL ? [PG_URL] : [])]) expect(everything, secret).not.toContain(secret);
    expect(ledgerDump).toContain(CLEAR_CANARY);
    expect(transcript.join("\n")).not.toMatch(/"args"|"arguments"/); // no process printed arguments
  });
});
