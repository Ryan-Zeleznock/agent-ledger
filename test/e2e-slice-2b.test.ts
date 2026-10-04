import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LedgerRecord } from "../src/types/index.js";
import * as upstreamModule from "../src/upstream/contract.js";
import * as frontModule from "../src/front/contract.js";
import { frontSupportsTls, slackSeamPresent } from "../src/server/seams.js";
import { createRunner, parseCsv, readJsonl } from "./helpers/e2e-demo.js";
import { startServerProcess, type ServerProcess } from "./helpers/e2e-server.js";
import { FakeSlack, type PostedMessage } from "./helpers/fake-slack.js";
import { LEGACY_ENV_TEXT, LegacyUpstream } from "./helpers/legacy-upstream.js";
import { LegacyClient, resultOf, textOf } from "./helpers/legacy-client.js";
import { mcpCall, mcpPost, toolText } from "./helpers/mcp-client.js";

/**
 * Slice 2b end to end (docs/slices/slice-2b-pins.md pin 8, steps 1-13). REAL processes from a private build root (as in
 * 2a): the demo upstream and the proxy (`dist/server/main.js`, AGENT_LEDGER_APPROVALS=slack, apiBaseUrl = the loopback
 * fake Slack), the CLI and smoke.js; in this process: the fake Slack (test/helpers/fake-slack.ts: Web API + Socket Mode
 * over a hand-rolled RFC 6455 server) and a hand-written 2025-11-25 upstream (test/helpers/legacy-upstream.ts); the
 * legacy client is test/helpers/legacy-client.ts. Every server binds 127.0.0.1 on an ephemeral port; no real Slack call.
 *
 * Integration seam made VISIBLE, not hidden: Package B (this root, deploy, helpers) is built in parallel with Package A
 * (Slack approvals, dual-era upstream and front, TLS front). Steps that need A's behaviour self-skip with a title naming
 * exactly which part of A is missing until the coordinator integrates both; the harness self-tests always run, so the
 * fakes themselves are proven now. Step 13 (real server-everything) is gated on AGENT_LEDGER_E2E_EVERYTHING_DIR.
 */
const A = {
  slack: slackSeamPresent(),
  "legacy upstream": "UPSTREAM_LEGACY_VERSIONS" in upstreamModule,
  "legacy front": "FRONT_LEGACY_VERSIONS" in frontModule,
  tls: frontSupportsTls(),
};
type Need = keyof typeof A;
const missing = (needs: Need[]) => needs.filter((n) => !A[n]);
if (Object.values(A).some((v) => !v)) process.stderr.write(`e2e-slice-2b: pre-integration, Package A parts missing: ${missing(Object.keys(A) as Need[]).join(", ")}; dependent steps are skipped by name\n`);
/** `it` when every needed part of A is present, else a visibly named skip. */
function step(name: string, needs: Need[], fn: () => Promise<void>, timeout = 60_000): void {
  const m = missing(needs);
  if (m.length > 0) it.skip(`${name} [SKIPPED pre-integration: needs Package A ${m.join(" + ")}]`, fn);
  else it(name, fn, timeout);
}
const MAIN: Need[] = ["slack", "legacy upstream"];

const K = "e2e2b-proxy-key-canary-5e0d1f"; const K2 = "e2e2b-second-agent-key-canary-a71c"; const T = "e2e2b-demo-token-canary-9b3e";
const BOT = "xoxb-e2e2b-bot-token-canary-31d7"; const APP = "xapp-e2e2b-app-token-canary-c84a";
const CLEAR = "e2e2b-clear-canary-4f2a"; const HASHED = "e2e2b-hashed-canary-0d6b";
const CHANNEL = "C0E2E2BCHAN"; const APPROVER = "U0E2E2BAPPR"; const OTHER = "U0E2E2BOTHR";
const TIMEOUT_MS = 2000;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const REGISTRY = `version: 1
servers:
  demo:
    trusted: true
    tools:
      echo: { class: read, reviewedBy: ryan, reviewedAt: 2026-10-04, storeArgs: [message] }
      now: { class: read, reviewedBy: ryan, reviewedAt: 2026-10-04 }
      add: { class: write, reviewedBy: ryan, reviewedAt: 2026-10-04, storeArgs: [a, b] }
      wipe: { class: risky, reviewedBy: ryan, reviewedAt: 2026-10-04, storeArgs: [] }
  legacy:
    trusted: false
    tools:
      echo: { class: read, reviewedBy: ryan, reviewedAt: 2026-10-04, storeArgs: [message] }
      env: { class: risky, reviewedBy: ryan, reviewedAt: 2026-10-04, storeArgs: [] }
  everything:
    trusted: false
    tools:
      echo: { class: read, reviewedBy: ryan, reviewedAt: 2026-10-04, storeArgs: [message] }
      get-env: { class: risky, reviewedBy: ryan, reviewedAt: 2026-10-04, storeArgs: [] }
`;

const transcript: string[] = [];
const run = createRunner(transcript);
const responses: string[] = [];
let root = ""; let sandbox = ""; let configDir = ""; let ledgerDir = ""; let ledgerPath = ""; let cli = ""; let smokeJs = ""; let keyFile = "";
let demo: ServerProcess | undefined; let proxy: ServerProcess | undefined; let demoUrl = ""; let proxyUrl = "";
let base: NodeJS.ProcessEnv = {}; let serverEnv: NodeJS.ProcessEnv = {};
let slack: FakeSlack; let legacy: LegacyUpstream;
let tlsKeyText = ""; let packDir = "";
const legacySessionIds: string[] = [];
const callIds: Record<string, string> = {};
const write = (p: string, s: string | Buffer, mode = 0o600) => { writeFileSync(p, s, { mode }); chmodSync(p, mode); };
const records = (): LedgerRecord[] => (existsSync(ledgerPath) ? readJsonl<LedgerRecord>(ledgerPath) : []);
const intentOf = (callId: string) => records().find((r) => r.phase === "intent" && r.call.callId === callId);
const outcomeOf = (callId: string) => records().find((r) => r.phase === "outcome" && r.call.callId === callId);
const callFromBlock = (m: PostedMessage) => {
  const actions = ((m.body["blocks"] ?? []) as { type?: string; block_id?: string }[]).find((b) => b.type === "actions");
  return String(actions?.block_id ?? "").replace(/^agent-ledger:call:/, "");
};
async function callTool(name: string, args: Record<string, unknown>, key = K): Promise<Record<string, unknown>> {
  const r = await mcpPost({ url: proxyUrl, token: key, method: "tools/call", params: { name, arguments: args } });
  responses.push(r.text);
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  return (r.json as { result: Record<string, unknown> }).result;
}
/**
 * Launches one request and pairs it with the Slack message it causes: the oldest message nobody has claimed yet.
 * Pairing is only unambiguous if each launch is captured before the next one starts (Astra F1: three concurrent
 * captures all picked the first message), so callers that want several approvals pending at once capture them ONE BY
 * ONE and keep the `pending` promises open; the request stays in flight while its approval waits.
 */
async function captureApproval<R>(launch: () => Promise<R>, what: string): Promise<{ pending: Promise<R>; message: PostedMessage; callId: string }> {
  const pending = launch();
  pending.catch(() => undefined);
  const message = await slack.claimNext(10_000, `chat.postMessage for ${what}`);
  return { pending, message, callId: callFromBlock(message) };
}
const riskyCall = (name: string, args: Record<string, unknown>) => captureApproval(() => callTool(name, args), name);
async function freePort(): Promise<number> {
  const s = createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return port;
}
async function startProxy(env: NodeJS.ProcessEnv, scheme: "http" | "https" = "http"): Promise<ServerProcess> {
  const p = startServerProcess(join(root, "dist/server/main.js"), env, sandbox, transcript);
  const listening = await p.waitFor((e) => e["event"] === "listening", 30_000);
  proxyUrl = `${scheme}://127.0.0.1:${String(listening["port"])}/mcp`;
  return p;
}
function labCa(dir: string): { ca: string; cert: string; key: string } {
  const p = (n: string) => join(dir, n); const ossl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", p("ca.key")]);
  ossl(["req", "-x509", "-new", "-key", p("ca.key"), "-sha256", "-days", "1", "-subj", "/CN=agent-ledger e2e CA", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", p("ca.crt")]);
  ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", p("tls.key")]);
  ossl(["req", "-new", "-key", p("tls.key"), "-subj", "/CN=127.0.0.1", "-out", p("tls.csr")]);
  write(p("server.ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n", 0o644);
  ossl(["x509", "-req", "-in", p("tls.csr"), "-CA", p("ca.crt"), "-CAkey", p("ca.key"), "-CAcreateserial", "-days", "1", "-sha256", "-extfile", p("server.ext"), "-out", p("tls.crt")]);
  chmodSync(p("tls.key"), 0o600); chmodSync(p("tls.crt"), 0o644);
  return { ca: p("ca.crt"), cert: p("tls.crt"), key: p("tls.key") };
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-ledger-e2e2b-")));
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", join(root, "dist")], { stdio: "pipe" });
  cli = join(root, "dist/cli/main.js"); chmodSync(cli, 0o755); smokeJs = join(root, "dist/server/smoke.js");
  cpSync(resolve("policies"), join(root, "policies"), { recursive: true });
  copyFileSync(resolve("package.json"), join(root, "package.json"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"));
  sandbox = join(root, "sandbox"); mkdirSync(sandbox, { mode: 0o700 });
  configDir = join(sandbox, "config"); mkdirSync(configDir, { mode: 0o700 });
  ledgerDir = join(sandbox, "lab"); mkdirSync(join(ledgerDir, "ledger"), { recursive: true, mode: 0o700 });
  ledgerPath = join(ledgerDir, "ledger", "records.jsonl");
  slack = new FakeSlack({ botToken: BOT, appToken: APP }); await slack.start();
  legacy = new LegacyUpstream({ mode: "alternate" }); await legacy.start();
  write(join(configDir, "registry.yaml"), REGISTRY);
  write(join(configDir, "agents.yaml"), JSON.stringify({ version: 1, agents: [{ id: "claude-lab", credential: { kind: "api_key", sha256: sha256(K) } }, { id: "other-agent", credential: { kind: "api_key", sha256: sha256(K2) } }] }));
  write(join(configDir, "hmac.key"), randomBytes(32));
  mkdirSync(join(configDir, "secrets"), { mode: 0o700 });
  write(join(configDir, "secrets", "demo.bearerToken"), `${T}\n`);
  write(join(configDir, "secrets", "approvals.botToken"), `${BOT}\n`); write(join(configDir, "secrets", "approvals.appToken"), `${APP}\n`);
  write(join(configDir, "approvals.yaml"), `version: 1\nslack:\n  channelId: ${CHANNEL}\n  approvers: [${APPROVER}]\n  timeoutMs: ${TIMEOUT_MS}\n  apiBaseUrl: ${slack.apiBaseUrl}\n`);
  const tokenFile = join(sandbox, "demo-token"); write(tokenFile, `${T}\n`);
  keyFile = join(sandbox, "api-key"); write(keyFile, `${K}\n`);
  base = { PATH: process.env["PATH"], HOME: process.env["HOME"], TMPDIR: process.env["TMPDIR"] };
  demo = startServerProcess(join(root, "dist/server/demo-upstream.js"), { ...base, AGENT_LEDGER_DEMO_PORT: "0", AGENT_LEDGER_DEMO_BIND_HOST: "127.0.0.1", AGENT_LEDGER_DEMO_TOKEN_FILE: tokenFile }, sandbox, transcript);
  demoUrl = `http://127.0.0.1:${String((await demo.waitFor((e) => e["event"] === "listening"))["port"])}/mcp`;
  write(join(configDir, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${demoUrl}\n  - name: legacy\n    transport: http\n    url: ${legacy.url}\n`);
  serverEnv = { ...base, AGENT_LEDGER_CONFIG_DIR: configDir, AGENT_LEDGER_LEDGER_URL: pathToFileURL(ledgerPath).toString(), AGENT_LEDGER_PORT: "0", AGENT_LEDGER_BIND_HOST: "127.0.0.1",
    AGENT_LEDGER_ALLOWED_ORIGINS: "", AGENT_LEDGER_APPROVALS: "slack", AGENT_LEDGER_TLS: "off", AGENT_LEDGER_UPSTREAM_CONNECT_BUDGET_MS: "10000" };
}, 180_000);
afterAll(async () => {
  if (proxy) await proxy.stop(5_000).catch(() => undefined);
  if (demo) await demo.stop(5_000).catch(() => undefined);
  await slack?.stop().catch(() => undefined); await legacy?.stop().catch(() => undefined);
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.sequential("Slice 2b harness self-tests (always run: the fakes are proven before A integrates)", () => {
  it("fake Slack Web API: token checked then dropped (wrong/missing/wrong-type → ok:false), auth.test ids, chat.postMessage ts; no token in any recorded body", async () => {
    const api = (m: string, token: string | undefined, body: unknown = {}) => fetch(`${slack.apiBaseUrl}${m}`, { method: "POST", headers: { "content-type": "application/json; charset=utf-8", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect(await api("auth.test", BOT)).toMatchObject({ ok: true, team_id: slack.teamId, user_id: slack.botUserId });
    expect(await api("auth.test", "xoxb-wrong")).toEqual({ ok: false, error: "invalid_auth" });
    expect(await api("apps.connections.open", BOT)).toEqual({ ok: false, error: "not_allowed_token_type" });
    expect(await api("chat.postMessage", undefined, { channel: CHANNEL, text: "x" })).toEqual({ ok: false, error: "invalid_auth" });
    const posted = await api("chat.postMessage", BOT, { channel: CHANNEL, text: "x", blocks: [] });
    expect(posted).toMatchObject({ ok: true, channel: CHANNEL, ts: expect.stringMatching(/^\d+\.\d{6}$/) });
    slack.failures.set("chat.update", "message_not_found");
    expect(await api("chat.update", BOT, { channel: CHANNEL, ts: posted["ts"] })).toEqual({ ok: false, error: "message_not_found" });
    slack.failures.delete("chat.update");
    const dump = JSON.stringify(slack.calls); expect(dump).not.toContain(BOT); expect(dump).not.toContain(APP); expect(dump).not.toContain("xoxb-wrong");
    expect(slack.authFailures).toEqual(["auth.test", "apps.connections.open", "chat.postMessage"]);
  });
  it("fake Socket Mode: Node's WebSocket connects to the connections.open URL (single-use ticket), gets hello with the app id, its masked acks are counted per envelope, injected block_actions carry the posted button value / ts / channel, disconnect frames arrive", async () => {
    const opened = await fetch(`${slack.apiBaseUrl}apps.connections.open`, { method: "POST", headers: { authorization: `Bearer ${APP}` } }).then((r) => r.json() as Promise<{ ok: boolean; url: string }>);
    expect(opened.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/link\?ticket=[0-9a-f]{24}$/);
    const frames: Record<string, unknown>[] = [];
    const ws = new WebSocket(opened.url);
    ws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)) as Record<string, unknown>; frames.push(m); if (typeof m["envelope_id"] === "string") ws.send(JSON.stringify({ envelope_id: m["envelope_id"] })); });
    await slack.waitFor(() => frames.length >= 1, 5_000, "hello");
    expect(frames[0]).toMatchObject({ type: "hello", connection_info: { app_id: slack.appId } });
    const message: PostedMessage = { ts: "1790000000.000999", channel: CHANNEL, body: { text: "t", blocks: [{ type: "section" }, { type: "actions", block_id: "agent-ledger:call:c-1", elements: [
      { type: "button", action_id: "agent-ledger:approve", value: `c-1:${"a".repeat(32)}` }, { type: "button", action_id: "agent-ledger:deny", value: `c-1:${"a".repeat(32)}` }] }] } };
    const e1 = slack.click(message, { action: "deny", userId: APPROVER });
    const e2 = slack.click(message, { userId: APPROVER, forge: { nonce: "b".repeat(32), appId: "A0OTHERAPP1" } });
    const e3 = slack.sendEvent();
    await slack.waitFor(() => [e1, e2, e3].every((e) => slack.acks.get(e) === 1), 5_000, "three acks");
    const p1 = frames[1]!["payload"] as Record<string, any>; const p2 = frames[2]!["payload"] as Record<string, any>;
    expect(p1).toMatchObject({ type: "block_actions", api_app_id: slack.appId, user: { id: APPROVER, team_id: slack.teamId }, container: { message_ts: message.ts, channel_id: CHANNEL }, channel: { id: CHANNEL }, message: { ts: message.ts } });
    expect(p1["actions"]).toEqual([expect.objectContaining({ action_id: "agent-ledger:deny", block_id: "agent-ledger:call:c-1", value: `c-1:${"a".repeat(32)}` })]);
    expect(p2).toMatchObject({ api_app_id: "A0OTHERAPP1" }); expect(p2["actions"][0].value).toBe(`c-1:${"b".repeat(32)}`);
    slack.disconnect("warning");
    await slack.waitFor(() => frames.some((f) => f["type"] === "disconnect"), 5_000, "disconnect frame");
    expect(slack.conns.at(-1)!.violations).toBe(0);
    const reuse = new WebSocket(opened.url); const failed = await new Promise<boolean>((r) => { reuse.addEventListener("error", () => r(true)); reuse.addEventListener("open", () => r(false)); });
    expect(failed).toBe(true);
    ws.close(1000);
    await slack.waitFor(() => slack.openConns().length === 0, 5_000, "close");
    // reset what the self-test produced so the product steps count from zero
    slack.calls.length = 0; slack.posted.length = 0; slack.conns.length = 0; slack.acks.clear(); slack.sentEnvelopes.length = 0; slack.authFailures.length = 0;
  });
  it("approval capture (Astra F1): three requests captured one by one while all stay pending are paired with three DISTINCT messages, each its own; a concurrent burst never hands one message to two captures", async () => {
    const post = (marker: string, delayMs: number) => new Promise((r) => setTimeout(r, delayMs)).then(() => fetch(`${slack.apiBaseUrl}chat.postMessage`, { method: "POST", headers: { authorization: `Bearer ${BOT}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: CHANNEL, text: marker, blocks: [{ type: "actions", block_id: `agent-ledger:call:${marker}`, elements: [] }] }) }).then(() => marker));
    let resolveAll: () => void = () => undefined; const gate = new Promise<void>((r) => { resolveAll = r; });
    const caps = [];
    for (const [i, marker] of ["call-a", "call-b", "call-c"].entries()) caps.push(await captureApproval(() => post(marker, 30 - i * 10).then(async (m) => { await gate; return m; }), marker));
    expect(caps.map((c) => c.callId)).toEqual(["call-a", "call-b", "call-c"]);
    expect(new Set(caps.map((c) => c.message.ts)).size).toBe(3);
    resolveAll(); expect(await Promise.all(caps.map((c) => c.pending))).toEqual(["call-a", "call-b", "call-c"]);
    const burst = await Promise.all(["x", "y", "z"].map((m, i) => captureApproval(() => post(`burst-${m}`, 10 * i), m)));
    expect(new Set(burst.map((c) => c.message.ts)).size).toBe(3);
    slack.calls.length = 0; slack.posted.length = 0; slack.claimed.clear();
  });
  it("legacy client ↔ legacy upstream: initialize (session id, negotiated version), initialized 202, tools/list and echo over JSON and SSE; no session → 400 -32000; wrong version header → 400; DELETE → 204 then 404; GET → 405", async () => {
    const c = new LegacyClient(legacy.url);
    const init = await c.initialize("2025-06-18");
    expect(init.status).toBe(200); expect(c.protocolVersion).toBe("2025-06-18"); expect(c.sessionId).toMatch(/^[\x21-\x7e]{1,256}$/);
    expect((await c.initialized()).status).toBe(202);
    const list = await c.listTools(); expect((resultOf(list)["tools"] as { name: string }[]).map((t) => t.name)).toEqual(["echo", "env"]);
    expect(textOf(await c.callTool("echo", { message: "hi" }))).toBe("Echo: hi");
    expect(textOf(await c.callTool("env", {}))).toBe(LEGACY_ENV_TEXT);
    const bare = new LegacyClient(legacy.url);
    const noSession = await bare.request("tools/list", {});
    expect(noSession.status).toBe(400); expect((noSession.json?.["error"] as { code: number }).code).toBe(-32000);
    const wrongVersion = new LegacyClient(legacy.url); wrongVersion.sessionId = c.sessionId; wrongVersion.protocolVersion = "2025-11-25";
    expect((await wrongVersion.listTools()).status).toBe(400);
    expect((await c.terminate()).status).toBe(204); expect((await c.listTools()).status).toBe(404);
    expect((await fetch(legacy.url)).status).toBe(405);
    legacy.log.length = 0;
  });
});

describe.sequential("Slice 2b end to end: Slack approvals + the legacy-era bridge + TLS, real processes", () => {
  if (!A.slack) it("0. pre-integration only: AGENT_LEDGER_APPROVALS=slack without A's Slack module refuses to start (fail closed, exit 1), naming the missing piece and no token", async () => {
    const dir0 = join(sandbox, "config-pre"); cpSync(configDir, dir0, { recursive: true });
    write(join(dir0, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${demoUrl}\n`);
    const p = startServerProcess(join(root, "dist/server/main.js"), { ...serverEnv, AGENT_LEDGER_CONFIG_DIR: dir0, AGENT_LEDGER_UPSTREAM_CONNECT_BUDGET_MS: "0", AGENT_LEDGER_LEDGER_URL: pathToFileURL(join(sandbox, "pre-ledger", "r.jsonl")).toString() }, sandbox, transcript);
    const exit = await p.exited;
    expect(exit.code).toBe(1);
    expect(p.events().at(-1)).toMatchObject({ event: "refused", reason: expect.stringMatching(/^approvals: (validateSlackChannel failed|configureSlackApprovals failed)/) });
    for (const s of [BOT, APP]) expect(p.stderr.join("\n")).not.toContain(s);
  }, 30_000);
  step("1. start: approvals line (slack, approver count, no token), upstreams eras { demo: modern, legacy: legacy }; the fake saw exactly one auth.test and one probe connection", MAIN, async () => {
    proxy = await startProxy(serverEnv);
    const ev = proxy.events();
    expect(ev.map((e) => e["event"])).toEqual(["warning", "ledger", "upstreams", "approvals", "listening"]);
    expect(ev[2]).toMatchObject({ servers: ["demo", "legacy"], eras: { demo: "modern", legacy: "legacy" } });
    expect(ev[3]).toEqual({ ts: expect.any(String), event: "approvals", kind: "slack", channelId: CHANNEL, approvers: 1, timeoutMs: TIMEOUT_MS, teamId: slack.teamId });
    expect(ev[4]).toMatchObject({ approvals: "slack", tls: "off" });
    expect(slack.callsOf("auth.test")).toHaveLength(1); expect(slack.callsOf("apps.connections.open")).toHaveLength(1);
    expect(slack.conns).toHaveLength(1);
    await slack.waitFor(() => slack.openConns().length === 0, 5_000, "the probe connection to close");
    const text = proxy.stderr.join("\n"); for (const s of [BOT, APP, K, T, APPROVER]) expect(text).not.toContain(s);
    expect(slack.authFailures).toEqual([]);
  });
  step("2. tools/list (modern client) contains the demo__* names and legacy__echo, legacy__env", MAIN, async () => {
    const names = ((await mcpCall(proxyUrl, K, "tools/list"))["tools"] as { name: string }[]).map((t) => t.name);
    expect(names).toEqual(["demo__add", "demo__echo", "demo__now", "demo__whoami", "demo__wipe", "legacy__echo", "legacy__env"]);
  });
  step("3. legacy__echo → ok through the legacy upstream SESSION (Mcp-Session-Id + MCP-Protocol-Version on the call); intent + ok outcome, clear arg stored", MAIN, async () => {
    const r = await callTool("legacy__echo", { message: CLEAR });
    expect(r["isError"]).toBe(false); expect(toolText(r)).toBe(`Echo: ${CLEAR}`);
    const call = legacy.log.find((l) => l.method === "tools/call" && l.tool === "echo")!;
    expect(call.session).toBeDefined(); expect(legacy.sessions.has(call.session!)).toBe(true); expect(call.protocolVersion).toBe(legacy.sessions.get(call.session!));
    legacySessionIds.push(...legacy.minted);
    const id = String(proxy!.events().filter((e) => e["tool"] === "echo" && e["server"] === "legacy").at(-1)!["callId"]); callIds["legacyEcho"] = id;
    expect(intentOf(id)).toMatchObject({ call: { server: "legacy", tool: "echo", args: { message: CLEAR } }, policy: { verdict: "allow" } });
    expect(outcomeOf(id)?.outcome).toMatchObject({ status: "ok" });
  });
  step("4. demo__wipe → one chat.postMessage (two buttons, block_id = callId, values <callId>:<nonce>, no raw arg) → Approve from an approver → ok from the demo upstream; intent approval approved by <U>; chat.update once with the same ts", MAIN, async () => {
    const { pending, message, callId } = await riskyCall("demo__wipe", { target: HASHED });
    callIds["approved"] = callId;
    expect(message.channel).toBe(CHANNEL);
    const actions = ((message.body["blocks"] as { type: string; block_id?: string; elements?: { action_id: string; value: string; style?: string }[] }[]).find((b) => b.type === "actions"))!;
    expect(actions.block_id).toBe(`agent-ledger:call:${callId}`);
    expect(actions.elements!.map((e) => [e.action_id, e.style])).toEqual([["agent-ledger:approve", "primary"], ["agent-ledger:deny", "danger"]]);
    for (const e of actions.elements!) expect(e.value).toMatch(new RegExp(`^${callId}:[0-9a-f]{32}$`));
    expect(JSON.stringify(message.body)).not.toContain(HASHED);
    expect(String(message.body["text"])).toContain("demo/wipe");
    slack.click(message, { action: "approve", userId: APPROVER });
    const r = await pending;
    expect(r["isError"]).toBe(false); expect(toolText(r)).toBe("nothing was wiped: demo tool");
    expect(intentOf(callId)?.approval).toMatchObject({ callId, decision: "approved", approver: APPROVER, channel: "slack", reason: `slack: Approve clicked by ${APPROVER}` });
    expect(outcomeOf(callId)?.outcome).toMatchObject({ status: "ok" });
    await slack.waitFor(() => slack.callsOf("chat.update").length === 1, 5_000, "chat.update");
    expect(slack.callsOf("chat.update")[0]!.body).toMatchObject({ channel: CHANNEL, ts: message.ts });
  });
  step("5. legacy__env → Deny → isError, approval denied, blocked outcome; the legacy upstream saw NO env call", MAIN, async () => {
    const { pending, message, callId } = await riskyCall("legacy__env", {});
    callIds["denied"] = callId;
    slack.click(message, { action: "deny", userId: APPROVER });
    const r = await pending;
    expect(r["isError"]).toBe(true);
    expect(intentOf(callId)?.approval).toMatchObject({ decision: "denied", approver: APPROVER, channel: "slack", reason: `slack: Deny clicked by ${APPROVER}` });
    expect(outcomeOf(callId)?.outcome).toMatchObject({ status: "blocked" });
    expect(legacy.toolCalls()).not.toContain("env");
  });
  step("6. a non-approver click is ignored (one ephemeral), then nobody answers → timeout recorded", MAIN, async () => {
    const ephemerals = slack.callsOf("chat.postEphemeral").length;
    const { pending, message, callId } = await riskyCall("demo__wipe", { target: "timeout" });
    callIds["timeout"] = callId;
    const env = slack.click(message, { action: "approve", userId: OTHER });
    await slack.waitFor(() => slack.acks.get(env) === 1 && slack.callsOf("chat.postEphemeral").length === ephemerals + 1, 5_000, "ack + ephemeral");
    expect(slack.callsOf("chat.postEphemeral").at(-1)!.body).toMatchObject({ channel: CHANNEL, user: OTHER });
    const r = await pending;
    expect(r["isError"]).toBe(true);
    expect(intentOf(callId)?.approval).toMatchObject({ decision: "timeout", channel: "slack", reason: `no approver answered within ${TIMEOUT_MS} ms` });
    expect(intentOf(callId)?.approval?.approver).toBeUndefined();
  });
  step("7. forged clicks (wrong nonce, wrong ts, wrong channel, other app id, other team, two actions) are acked and ignored; a later valid click settles; every envelope acked exactly once", MAIN, async () => {
    const { pending, message, callId } = await riskyCall("demo__wipe", { target: "forged" });
    callIds["forged"] = callId;
    const forged = [
      slack.click(message, { userId: APPROVER, forge: { nonce: "0".repeat(32) } }),
      slack.click(message, { userId: APPROVER, forge: { ts: "1790000000.999999" } }),
      slack.click(message, { userId: APPROVER, forge: { channel: "C0OTHERCHAN" } }),
      slack.click(message, { userId: APPROVER, forge: { appId: "A0OTHERAPP1" } }),
      slack.click(message, { userId: APPROVER, teamId: "T0OTHERTEAM" }),
      slack.click(message, { userId: APPROVER, forge: { extraAction: true } }),
    ];
    await slack.waitFor(() => forged.every((e) => slack.acks.get(e) === 1), 1_500, "acks for the forged clicks");
    expect(intentOf(callId)).toBeUndefined();                    // nothing settled: the intent is written after the decision
    const valid = slack.click(message, { action: "deny", userId: APPROVER });
    const r = await pending;
    expect(r["isError"]).toBe(true);
    expect(intentOf(callId)?.approval).toMatchObject({ decision: "denied", approver: APPROVER });
    await slack.waitFor(() => slack.acks.get(valid) === 1, 2_000, "ack for the valid click");
    for (const e of slack.sentEnvelopes) expect(slack.acks.get(e), e).toBe(1);
  });
  step("8. three concurrent risky calls share ONE WebSocket; a disconnect warning mid-wait → the new connection opens before the old closes; each click settles its own call; no unavailable", MAIN, async () => {
    const connsBefore = slack.conns.length;
    const calls: Awaited<ReturnType<typeof riskyCall>>[] = [];
    for (const i of [1, 2, 3]) calls.push(await riskyCall("demo__wipe", { target: `concurrent-${i}` })); // all three stay pending
    expect(new Set(calls.map((c) => c.message.ts)).size).toBe(3);
    expect(new Set(calls.map((c) => c.callId)).size).toBe(3);
    for (const c of calls) expect(c.callId).toMatch(/\S/);
    expect(slack.openConns()).toHaveLength(1); expect(slack.conns.length).toBe(connsBefore + 1);
    const old = slack.openConns()[0]!;
    slack.disconnect("warning", old.id);
    await slack.waitFor(() => slack.conns.length === connsBefore + 2, 5_000, "the replacement connection");
    const fresh = slack.conns.at(-1)!;
    expect(old.closedAt === undefined || old.closedAt >= fresh.openedAt).toBe(true);
    const decisions = ["approve", "deny", "approve"] as const;
    calls.forEach((c, i) => slack.click(c.message, { action: decisions[i], userId: APPROVER, connId: fresh.id }));
    const results = await Promise.all(calls.map((c) => c.pending));
    expect(results.map((r) => r["isError"])).toEqual([false, true, false]);
    expect(calls.map((c) => intentOf(c.callId)?.approval?.decision)).toEqual(["approved", "denied", "approved"]);
    await slack.waitFor(() => !old.open, 5_000, "the old connection to close");
  });
  step("9. TLS: a proxy with AGENT_LEDGER_TLS=on and a lab-CA cert; smoke.js --ca-file → SMOKE PASS; plain HTTP to the TLS port fails; a client without the CA fails verification", ["tls"], async () => {
    const pki = labCa(mkdtempSync(join(sandbox, "pki-")));
    tlsKeyText = readFileSync(pki.key, "utf8");
    const dir2 = join(sandbox, "config-tls"); cpSync(configDir, dir2, { recursive: true });
    write(join(dir2, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${demoUrl}\n`);
    copyFileSync(pki.cert, join(dir2, "tls.crt")); chmodSync(join(dir2, "tls.crt"), 0o644); write(join(dir2, "tls.key"), readFileSync(pki.key));
    const mainUrl = proxyUrl;
    const p = await startProxy({ ...serverEnv, AGENT_LEDGER_CONFIG_DIR: dir2, AGENT_LEDGER_APPROVALS: "none", AGENT_LEDGER_TLS: "on", AGENT_LEDGER_LEDGER_URL: pathToFileURL(join(sandbox, "tls-ledger", "r.jsonl")).toString() }, "https");
    const tlsUrl = proxyUrl;
    try {
      expect(p.events().some((e) => e["event"] === "warning")).toBe(false);
      expect(p.events().find((e) => e["event"] === "listening")).toMatchObject({ tls: "on", approvals: "none" });
      const smoke = await run(process.execPath, [smokeJs, "--url", tlsUrl, "--key-file", keyFile, "--ca-file", pki.ca], { cwd: sandbox, env: base });
      expect(smoke.code, smoke.stdout + smoke.stderr).toBe(0); expect(smoke.stdout.trim().split("\n").at(-1)).toBe("SMOKE PASS");
      await expect(fetch(tlsUrl.replace("https:", "http:").replace("/mcp", "/healthz"), { signal: AbortSignal.timeout(3_000) }).then((r) => r.status)).rejects.toThrow();
      await expect(fetch(tlsUrl.replace("/mcp", "/healthz"))).rejects.toThrow();
    } finally { await p.stop(5_000); proxyUrl = mainUrl; }
  });
  step("10. legacy client → front: initialize, notifications/initialized, tools/list, legacy__echo ok; its session reused with another agent's key → 404; DELETE → 204, then 404", [...MAIN, "legacy front"], async () => {
    const c = new LegacyClient(proxyUrl, K);
    const init = await c.initialize();
    expect(init.status).toBe(200); expect(resultOf(init)).toMatchObject({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "agent-ledger" } });
    expect(c.sessionId).toMatch(/^[\x21-\x7e]+$/); legacySessionIds.push(c.sessionId!);
    expect((await c.initialized()).status).toBe(202);
    const names = ((resultOf(await c.listTools())["tools"] ?? []) as { name: string }[]).map((t) => t.name);
    expect(names).toContain("legacy__echo"); expect(names).toContain("demo__echo");
    const echo = await c.callTool("legacy__echo", { message: "from a legacy client" });
    expect(resultOf(echo)["isError"]).toBe(false); expect(textOf(echo)).toBe("Echo: from a legacy client");
    const thief = new LegacyClient(proxyUrl, K2); thief.sessionId = c.sessionId; thief.protocolVersion = c.protocolVersion;
    expect((await thief.listTools()).status).toBe(404);
    expect((await c.terminate()).status).toBe(204);
    expect((await c.listTools()).status).toBe(404);
    responses.push(...c.replies, ...thief.replies);
  });
  step("11. Slack unavailable (apps.connections.open → invalid_auth after start) → unavailable recorded and denied; SIGTERM with a pending approval → unavailable (proxy shutting down) recorded, exit 0", MAIN, async () => {
    slack.failures.set("apps.connections.open", "invalid_auth");
    const r = await callTool("demo__wipe", { target: "unavailable" });
    slack.failures.delete("apps.connections.open");
    expect(r["isError"]).toBe(true);
    const id = String(proxy!.events().filter((e) => e["tool"] === "wipe").at(-1)!["callId"]); callIds["unavailable"] = id;
    expect(intentOf(id)?.approval).toMatchObject({ decision: "unavailable", channel: "slack", reason: "Slack unreachable: apps.connections.open: invalid_auth" });
    expect(outcomeOf(id)?.outcome).toMatchObject({ status: "blocked" });
    const { pending, callId } = await riskyCall("demo__wipe", { target: "shutdown" });
    callIds["shutdown"] = callId;
    const stopped = await proxy!.stop();
    expect(stopped.code).toBe(0); expect(stopped.ms).toBeLessThan(10_000);
    expect(proxy!.events().at(-1)).toMatchObject({ event: "stopped", drained: true });
    await pending.catch(() => undefined);
    expect(intentOf(callId)?.approval).toMatchObject({ decision: "unavailable", reason: "Slack unreachable: proxy shutting down" });
    expect(outcomeOf(callId)?.outcome).toMatchObject({ status: "blocked" });
  });
  step("12. verify exit 0; the CC8.1 table shows approved, <U> + executed after ask (4), denied: Slack denied (5), denied: Slack timeout (6), denied: Slack unavailable (11); leak sweep over ledger, outputs, the fake's bodies and the pack", MAIN, async () => {
    const env = { ...base };
    const verify = await run(process.execPath, [cli, "verify", "--dir", ledgerDir], { cwd: sandbox, env });
    expect(verify.code, verify.stderr).toBe(0);
    expect((JSON.parse(verify.stdout) as { chain: { ok: boolean } }).chain.ok).toBe(true);
    packDir = join(sandbox, "pack");
    const report = await run(process.execPath, [cli, "report", "--dir", ledgerDir, "--from", new Date(Date.now() - 3_600_000).toISOString(), "--to", new Date(Date.now() + 60_000).toISOString(), "--out", packDir], { cwd: sandbox, env });
    expect(report.code, report.stderr).toBe(0);
    const out = JSON.parse(report.stdout) as { htmlPath: string; csvPath: string };
    const csv = parseCsv(readFileSync(out.csvPath, "utf8")); const col = (n: string) => csv[0]!.indexOf(n);
    const cls = (id: string) => csv.slice(1).filter((r) => r[col("call_id")] === id && r[col("phase")] === "intent").map((r) => r[col("evidence_class")]);
    expect(cls(callIds["approved"]!)).toEqual(["executed after ask"]);
    expect(cls(callIds["denied"]!)).toEqual(["denied: Slack denied"]);
    expect(cls(callIds["timeout"]!)).toEqual(["denied: Slack timeout"]);
    expect(cls(callIds["unavailable"]!)).toEqual(["denied: Slack unavailable"]);
    const html = readFileSync(out.htmlPath, "utf8");
    const cc81 = html.split('<section id="cc8-1">')[1]!.split("</section>")[0]!;
    expect(cc81).toContain(`approved, ${APPROVER}`); expect(cc81).toContain("executed after ask");
    // leak sweep
    const nonces = slack.posted.flatMap((m) => JSON.stringify(m.body).match(/:[0-9a-f]{32}"/g) ?? []).map((s) => s.slice(1, -1));
    expect(nonces.length).toBeGreaterThan(0);
    const ledgerDump = readFileSync(ledgerPath, "utf8");
    const pack = ["report.html", "report.pdf", "records.csv"].map((f) => readFileSync(join(packDir, f)).toString("latin1")).join("\n");
    const outputs = [transcript.join("\n"), responses.join("\n")].join("\n");
    const secrets = [BOT, APP, K, K2, T, HASHED, ...nonces, ...legacySessionIds, ...(tlsKeyText ? tlsKeyText.split("\n").filter((l) => l.length > 20) : [])];
    for (const s of secrets) { expect(ledgerDump, "ledger").not.toContain(s); expect(outputs, "process outputs").not.toContain(s); expect(pack, "pack").not.toContain(s); }
    const slackBodies = JSON.stringify(slack.calls);
    for (const s of [BOT, APP, K, K2, T, HASHED]) expect(slackBodies, "fake Slack bodies").not.toContain(s);
    expect(ledgerDump).toContain(CLEAR);
  });
  const everythingDir = process.env["AGENT_LEDGER_E2E_EVERYTHING_DIR"];
  const step13 = "13. real server-everything 2026.8.31 (npm ci of deploy/upstreams/everything) on loopback: discovered as legacy; everything__echo ok; everything__get-env → Slack → approve → ok";
  if (!everythingDir) it.skip(`${step13} [SKIPPED: set AGENT_LEDGER_E2E_EVERYTHING_DIR; the coordinator runs it]`, () => undefined);
  else step(step13, MAIN, async () => {
    const entry = join(everythingDir, "node_modules/@modelcontextprotocol/server-everything/dist/index.js");
    expect(existsSync(entry), entry).toBe(true);
    // server-everything calls app.listen(PORT) with no host (all interfaces). The hard rule is loopback only, so this
    // child-only preload pins every listen() without a host to 127.0.0.1 (passed as --import, never NODE_OPTIONS).
    const preload = join(sandbox, "force-loopback.mjs");
    write(preload, `import net from "node:net";\nconst listen = net.Server.prototype.listen;\nnet.Server.prototype.listen = function (...a) {\n  if (typeof a[0] === "number" || (typeof a[0] === "string" && /^\\d+$/.test(a[0]))) { if (typeof a[1] !== "string") a.splice(1, 0, "127.0.0.1"); }\n  else if (a[0] && typeof a[0] === "object" && a[0].host === undefined && a[0].path === undefined) a[0] = { ...a[0], host: "127.0.0.1" };\n  return listen.apply(this, a);\n};\n`, 0o644);
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, entry, "streamableHttp"], { cwd: everythingDir, env: { ...base, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = []; child.stdout.on("data", (d: Buffer) => lines.push(d.toString())); child.stderr.on("data", (d: Buffer) => lines.push(d.toString()));
    try {
      const t0 = Date.now();
      while (!lines.join("").includes(`listening on port ${port}`)) { if (Date.now() - t0 > 15_000) throw new Error(`server-everything did not start: ${lines.join("")}`); await new Promise((r) => setTimeout(r, 100)); }
      const dir3 = join(sandbox, "config-everything"); cpSync(configDir, dir3, { recursive: true });
      write(join(dir3, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${demoUrl}\n  - name: everything\n    transport: http\n    url: http://127.0.0.1:${port}/mcp\n`);
      const mainUrl = proxyUrl;
      const p = await startProxy({ ...serverEnv, AGENT_LEDGER_CONFIG_DIR: dir3, AGENT_LEDGER_LEDGER_URL: pathToFileURL(join(sandbox, "everything-ledger", "r.jsonl")).toString() });
      try {
        expect(p.events().find((e) => e["event"] === "upstreams")).toMatchObject({ eras: { demo: "modern", everything: "legacy" } });
        const echo = await callTool("everything__echo", { message: "hello" });
        expect(echo["isError"]).toBe(false); expect(toolText(echo)).toContain("hello");
        const { pending, message } = await riskyCall("everything__get-env", {});
        slack.click(message, { action: "approve", userId: APPROVER });
        const r = await pending;
        expect(r["isError"]).toBe(false); expect(toolText(r)).toMatch(new RegExp(`"PORT":\\s*"${port}"`)); // get-env pretty-prints JSON.stringify(process.env) (live check 2026-10-04)
      } finally { await p.stop(5_000); proxyUrl = mainUrl; }
    } finally { child.kill("SIGTERM"); }
  }, 90_000);
});
