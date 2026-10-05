import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LedgerRecord, UnsealedRecord } from "../src/types/index.js";
import { PROXY_NO_CHANNEL_REASON } from "../src/types/index.js";
import { createLedger, type LedgerStore } from "../src/ledger/contract.js";
import { ENV, StartupRefused, startServer, type LogLine, type RunningServer } from "../src/server/main.js";
import { DEMO_TOOLS, DEMO_UNAUTHORIZED_TEXT, DEMO_WHOAMI_TEXT, DEMO_WIPE_TEXT, createDemoHandler, demoMain, startDemoUpstream, tokenMatches, validateArgs } from "../src/server/demo-upstream.js";
import { JSONRPC_OVERLOADED } from "../src/front/contract.js";
import type { RunningFront } from "../src/front/contract.js";
import { parseSmokeArgs, runSmoke } from "../src/server/smoke.js";
import { mcpCall, mcpPost, toolText } from "./helpers/mcp-client.js";

// Slice 2a pins 6 and 8, in process: the real demo upstream on 127.0.0.1:0, the real composition root on 127.0.0.1:0, a
// jsonl ledger behind a file:// URL, the real identity/registry/secrets files in a tmp config dir.
const KEY = "proxy-api-key-canary-8c1d2e"; const T = "demo-upstream-token-canary-4b7a";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const REGISTRY = { version: 1, servers: { demo: { trusted: true, tools: {
  echo: { class: "read", reviewedBy: "ryan", reviewedAt: "2026-10-03", storeArgs: ["message"] },
  now: { class: "read", reviewedBy: "ryan", reviewedAt: "2026-10-03" },
  add: { class: "write", reviewedBy: "ryan", reviewedAt: "2026-10-03", storeArgs: ["a", "b"] },
  wipe: { class: "risky", reviewedBy: "ryan", reviewedAt: "2026-10-03", storeArgs: [] },
} } } };
const dirs: string[] = []; const fronts: RunningFront[] = []; const servers: RunningServer[] = []; const rawServers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop().catch(() => undefined);
  for (const f of fronts.splice(0)) await f.stop().catch(() => undefined);
  for (const r of rawServers.splice(0)) { r.closeAllConnections(); await new Promise<void>((done) => r.close(() => done())); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agent-ledger-server-")); dirs.push(d); return d; };
const write = (p: string, s: string | Buffer, mode = 0o600) => { writeFileSync(p, s, { mode }); chmodSync(p, mode); };
interface Lab { dir: string; env: NodeJS.ProcessEnv; demoUrl: string; demoLog: LogLine[]; ledgerPath: string; }
async function lab(mut: (l: Lab) => void = () => undefined): Promise<Lab> {
  const demoLog: LogLine[] = [];
  const demo = await startDemoUpstream({ port: 0, bindHost: "127.0.0.1", token: Buffer.from(T), log: (l) => demoLog.push(l) });
  fronts.push(demo);
  const dir = tmp();
  const demoUrl = `http://127.0.0.1:${demo.port}/mcp`;
  write(join(dir, "registry.yaml"), JSON.stringify(REGISTRY));
  write(join(dir, "agents.yaml"), JSON.stringify({ version: 1, agents: [{ id: "claude-lab", credential: { kind: "api_key", sha256: sha256(KEY) } }] }));
  write(join(dir, "hmac.key"), randomBytes(32));
  mkdirSync(join(dir, "secrets")); write(join(dir, "secrets", "demo.bearerToken"), `${T}\n`);
  write(join(dir, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${demoUrl}\n`);
  const ledgerPath = join(dir, "ledger", "records.jsonl");
  const env: NodeJS.ProcessEnv = { [ENV.configDir]: dir, [ENV.ledgerUrl]: pathToFileURL(ledgerPath).toString(), [ENV.port]: "0", [ENV.bindHost]: "127.0.0.1", [ENV.allowedOrigins]: "", [ENV.approvals]: "none", [ENV.tls]: "off", [ENV.connectBudget]: "0" };
  const l = { dir, env, demoUrl, demoLog, ledgerPath };
  mut(l);
  return l;
}
async function up(l: Lab, log: LogLine[] = []): Promise<{ server: RunningServer; url: string; log: LogLine[] }> {
  const server = await startServer(l.env, { log: (line) => log.push(line) });
  servers.push(server);
  return { server, url: `http://127.0.0.1:${server.port}/mcp`, log };
}
const up2 = up;
const records = (l: Lab): LedgerRecord[] => { try { return readFileSync(l.ledgerPath, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x) as LedgerRecord); } catch { return []; } };
/** Whether the ledger validator on this branch accepts channel "none" yet (B's pin 1 line); the proxy's no-channel text depends on it. */
async function validatorAcceptsNone(): Promise<boolean> {
  const d = tmp(); const probe = createLedger("jsonl", join(d, "probe.jsonl"));
  return probe.append({ id: "p", phase: "intent", call: { callId: "p", sessionId: "s", agentId: "a", server: "x", tool: "y", args: {}, receivedAt: new Date().toISOString() }, policy: { verdict: "require_approval", risk: "risky", ruleId: "registry:x/y", reason: "r" }, approval: { callId: "p", decision: "no-channel", reason: PROXY_NO_CHANNEL_REASON, decidedAt: new Date().toISOString(), channel: "none" } }).then(() => true, () => false);
}
const leakFree = (text: string, l: Lab) => { expect(text).not.toContain(KEY); expect(text).not.toContain(T); expect(text).not.toContain(l.env[ENV.ledgerUrl]!); expect(text).not.toContain("NODE_OPTIONS_CANARY"); };

describe("server root: start, serve, record, log, stop (pin 8)", () => {
  it("starts in the pinned order and logs ledger head, upstreams and listening without the URL, key or token; discover and the five demo__ names", async () => {
    const l = await lab();
    const { server, url, log } = await up(l);
    expect(server.head).toBe("0");
    expect(log.map((x) => x["event"])).toEqual(["warning", "ledger", "upstreams", "listening"]); expect(log[0]).toMatchObject({ tls: "off" }); log.shift();
    expect(log[0]).toMatchObject({ backend: "jsonl", head: "0" }); expect(log[1]).toMatchObject({ servers: ["demo"], tools: 5 }); expect(log[2]).toMatchObject({ port: server.port, bindHost: "127.0.0.1", approvals: "none" });
    leakFree(JSON.stringify(log), l);
    expect((await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json())).toEqual({ ok: true });
    expect((await mcpCall(url, KEY, "server/discover"))["supportedVersions"]).toEqual(["2026-07-28"]);
    const list = await mcpCall(url, KEY, "tools/list");
    expect((list["tools"] as { name: string }[]).map((t) => t.name)).toEqual(["demo__add", "demo__echo", "demo__now", "demo__whoami", "demo__wipe"]);
    expect(list).toMatchObject({ resultType: "complete", ttlMs: 60_000, cacheScope: "private" });
  });
  it("demo__echo and demo__add run through policy → ledger → upstream: clear vs hashed args, no agentSessionId, no approval; one pinned log line per call; the upstream saw both", async () => {
    const l = await lab();
    const { url, log } = await up(l);
    const echo = await mcpCall(url, KEY, "tools/call", { name: "demo__echo", arguments: { message: "hello clear-canary" } });
    expect(echo).toMatchObject({ resultType: "complete", isError: false }); expect(toolText(echo)).toBe("hello clear-canary");
    const add = await mcpCall(url, KEY, "tools/call", { name: "demo__add", arguments: { a: 2, b: 3, note: "hashed-canary-note" } });
    expect(toolText(add)).toBe("5");
    const recs = records(l);
    expect(recs.map((r) => [r.phase, r.call.tool, r.outcome?.status ?? "-"])).toEqual([["intent", "echo", "-"], ["outcome", "echo", "ok"], ["intent", "add", "-"], ["outcome", "add", "ok"]]);
    expect(recs[0]!.call).toMatchObject({ agentId: "claude-lab", server: "demo", tool: "echo", args: { message: "hello clear-canary" } });
    expect(recs[0]!.call.agentSessionId).toBeUndefined(); expect(recs[0]!.approval).toBeUndefined();
    expect(recs[0]!.policy).toMatchObject({ verdict: "allow", risk: "read", ruleId: "registry:demo/echo" });
    expect(recs[2]!.call.args).toMatchObject({ a: 2, b: 3 }); expect(recs[2]!.call.args["note"]).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    const calls = log.filter((x) => x["callId"] !== undefined);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0]!)).toEqual(["ts", "callId", "agentId", "server", "tool", "verdict", "ruleId", "status", "ms"]);
    expect(calls[0]).toMatchObject({ agentId: "claude-lab", server: "demo", tool: "echo", verdict: "allow", ruleId: "registry:demo/echo", status: "ok" });
    expect(calls[1]).toMatchObject({ tool: "add", verdict: "allow", ruleId: "registry:demo/add", status: "ok" });
    const all = JSON.stringify(log) + readFileSync(l.ledgerPath, "utf8");
    leakFree(all, l); expect(all).not.toContain("hashed-canary-note"); expect(JSON.stringify(log)).not.toContain("clear-canary");
    expect(l.demoLog.filter((x) => x["event"] === "call").map((x) => [x["tool"], x["status"]])).toEqual([["echo", "ok"], ["add", "ok"]]);
  });
  it("demo__wipe (risky) and demo__whoami (unreviewed) are denied with no approval channel and NEVER reach the upstream; record shapes once B's validator accepts channel none", async () => {
    const l = await lab();
    const { url, log } = await up(l);
    const accepts = await validatorAcceptsNone();
    const wipe = await mcpCall(url, KEY, "tools/call", { name: "demo__wipe", arguments: { target: "prod" } });
    const who = await mcpCall(url, KEY, "tools/call", { name: "demo__whoami", arguments: {} });
    expect(wipe["isError"]).toBe(true); expect(who["isError"]).toBe(true);
    expect(toolText(wipe)).not.toContain(DEMO_WIPE_TEXT); expect(toolText(who)).not.toContain(DEMO_WHOAMI_TEXT);
    expect(l.demoLog.filter((x) => x["event"] === "call")).toEqual([]); // the upstream's own log shows NO call
    const calls = log.filter((x) => x["callId"] !== undefined);
    expect(calls.map((x) => [x["tool"], x["verdict"], x["ruleId"]])).toEqual([["wipe", "require_approval", "registry:demo/wipe"], ["whoami", "require_approval", "unreviewed:demo/whoami"]]);
    if (!accepts) {
      // src/ledger/validate.ts still lists ["slack", "hook-ask"] (B's pin 1 line is not on this branch): the append is refused and the proxy fails closed
      expect(toolText(wipe)).toMatch(/ledger unavailable/); expect(records(l)).toEqual([]);
      expect(calls.map((x) => x["status"])).toEqual(["denied", "denied"]);
      return;
    }
    expect(toolText(wipe)).toBe(`agent-ledger: denied (risky; registry:demo/wipe): ${PROXY_NO_CHANNEL_REASON}`);
    expect(toolText(who)).toBe(`agent-ledger: denied (unreviewed; unreviewed:demo/whoami): ${PROXY_NO_CHANNEL_REASON}`);
    const recs = records(l);
    expect(recs.map((r) => [r.phase, r.call.tool, r.outcome?.status ?? "-"])).toEqual([["intent", "wipe", "-"], ["outcome", "wipe", "blocked"], ["intent", "whoami", "-"], ["outcome", "whoami", "blocked"]]);
    expect(recs[0]!.approval).toMatchObject({ decision: "no-channel", channel: "none", reason: PROXY_NO_CHANNEL_REASON });
    expect(recs[2]!.policy).toMatchObject({ risk: "unreviewed", ruleId: "unreviewed:demo/whoami" });
    expect(recs[2]!.call.args).toEqual({});
    expect(calls.map((x) => x["status"])).toEqual(["blocked", "blocked"]);
    expect(await createLedger("jsonl", l.ledgerPath).verify()).toEqual({ ok: true, checked: 4 });
  });
  it("ADR-018: a wrong key gets 401 at the front (tools/call, tools/list, discover) with no record and no call line; the agent's key is NOT the upstream's credential (direct → 401)", async () => {
    const l = await lab();
    const { url, log } = await up(l);
    for (const method of ["tools/call", "tools/list", "server/discover"]) {
      const r = await mcpPost({ url, token: "not-the-key", method, params: method === "tools/call" ? { name: "demo__echo", arguments: { message: "x" } } : {} });
      expect(r.status).toBe(401); expect(r.text).not.toContain("not-the-key"); expect(r.text).not.toContain("demo__");
    }
    expect(records(l)).toEqual([]);
    expect(log.find((x) => x["callId"] !== undefined)).toBeUndefined();
    const direct = await mcpPost({ url: l.demoUrl, token: KEY, method: "tools/call", params: { name: "echo", arguments: { message: "x" } } });
    expect(direct.status).toBe(401);
    expect((await mcpPost({ url: l.demoUrl, token: KEY, method: "tools/list" })).status).toBe(401);
    expect(toolText(await mcpCall(l.demoUrl, T, "tools/call", { name: "echo", arguments: { message: "x" } }))).toBe("x");
    leakFree(JSON.stringify(log), l);
  });
  it("stop() closes the front, the upstream client and logs stopped; the port no longer answers", async () => {
    const l = await lab();
    const { server, log } = await up(l);
    await server.stop(); await server.stop();
    expect(log.at(-1)).toMatchObject({ event: "stopped" });
    await expect(fetch(`http://127.0.0.1:${server.port}/healthz`)).rejects.toThrow();
  });
});

describe("server root: refuses to start (one `refused` line, exit-1 semantics, no secret in the reason)", () => {
  const refusal = async (mut: (l: Lab) => void, re: RegExp, extra?: (l: Lab) => void) => {
    const l = await lab(mut); extra?.(l);
    const log: LogLine[] = [];
    let err: unknown; try { servers.push(await startServer(l.env, { log: (x) => log.push(x) })); } catch (e) { err = e; }
    expect(err, re.source).toBeInstanceOf(StartupRefused);
    expect((err as Error).message, re.source).toMatch(re);
    expect(log.at(-1)).toMatchObject({ event: "refused", reason: (err as Error).message });
    expect(log.some((x) => x["event"] === "listening")).toBe(false);
    leakFree(JSON.stringify(log), l);
  };
  it("NODE_OPTIONS set (even empty)", () => refusal((l) => { l.env["NODE_OPTIONS"] = ""; }, /NODE_OPTIONS is set/));
  it("approvals other than none, or absent", async () => { await refusal((l) => { l.env[ENV.approvals] = "Slack"; }, /AGENT_LEDGER_APPROVALS must be "none" or "slack"/); await refusal((l) => { delete l.env[ENV.approvals]; }, /got nothing/); });
  it("config dir / ledger URL missing, bad scheme, embedded password", async () => {
    await refusal((l) => { delete l.env[ENV.configDir]; }, /AGENT_LEDGER_CONFIG_DIR is required/);
    await refusal((l) => { delete l.env[ENV.ledgerUrl]; }, /AGENT_LEDGER_LEDGER_URL is required/);
    await refusal((l) => { l.env[ENV.ledgerUrl] = "mysql://x/y"; }, /scheme must be postgres/);
    await refusal((l) => { l.env[ENV.ledgerUrl] = "postgres://u:pw-in-url-canary@127.0.0.1:1/ledger"; }, /must not carry a password/, (l) => { expect(l.env[ENV.ledgerUrl]).toContain("pw-in-url-canary"); });
    await refusal((l) => { l.env[ENV.port] = "70000"; }, /AGENT_LEDGER_PORT/);
  });
  it("registry, agents, hmac key, secrets and upstreams files: each failure names the file, never a value", async () => {
    await refusal((l) => write(join(l.dir, "registry.yaml"), JSON.stringify({ version: 1, servers: { demo: { trusted: true, tools: { echo: { class: "nuclear", reviewedBy: "r", reviewedAt: "2026-10-03" } } } } })), /^registry\.yaml: /);
    await refusal((l) => rmSync(join(l.dir, "agents.yaml")), /^agents\.yaml: /);
    await refusal((l) => write(join(l.dir, "hmac.key"), randomBytes(31)), /hmac\.key: must be exactly 32 raw bytes/);
    await refusal((l) => chmodSync(join(l.dir, "hmac.key"), 0o644), /hmac\.key: must be owned by this user with mode 0600/);
    await refusal((l) => { const target = join(tmp(), "t"); write(target, "x"); symlinkSync(target, join(l.dir, "secrets", "other.token")); }, /"other\.token" is a symlink; refused/);
    await refusal((l) => write(join(l.dir, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${l.demoUrl}\n    token: ${T}\n`), /upstreams\.yaml: upstreams\[0\]: unknown field token/);
    await refusal((l) => write(join(l.dir, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: http://127.0.0.1:1/mcp\n`), /upstreams: upstream demo: server\/discover request failed/);
    await refusal((l) => rmSync(join(l.dir, "secrets", "demo.bearerToken")), /upstreams: upstream demo: HTTP 401 on server\/discover/); // no bearer → the demo upstream's front 401s
  });
  it("Postgres form: the password file is URL-encoded into the URL handed to createLedger; an unreachable ledger (head() throws, even naming the URL) is refused with the URL and password redacted", async () => {
    const l = await lab((l) => { l.env[ENV.ledgerUrl] = "postgres://ledger_app@127.0.0.1:1/ledger"; write(join(l.dir, "ledger.password"), "pw-canary@%:/\n"); });
    const seen: string[] = [];
    const fake: LedgerStore = { append: async () => { throw new Error("no"); }, verify: async () => ({ ok: true, checked: 0 }), head: async () => { throw new Error(`connect ECONNREFUSED for ${seen[0]} (password pw-canary@%:/)`); }, async *read() {} };
    const log: LogLine[] = [];
    let err: unknown;
    try { await startServer(l.env, { log: (x) => log.push(x), createLedger: (kind, target) => { seen.push(`${kind} ${target}`); return fake; } }); } catch (e) { err = e; }
    expect(seen).toEqual([`postgres postgres://ledger_app:${encodeURIComponent("pw-canary@%:/")}@127.0.0.1:1/ledger`]);
    expect(err).toBeInstanceOf(StartupRefused);
    expect((err as Error).message).toMatch(/^ledger unreachable: head\(\) failed \(Error: /);
    const text = JSON.stringify(log) + (err as Error).message;
    expect(text).not.toContain("pw-canary"); expect(text).not.toContain(encodeURIComponent("pw-canary@%:/")); expect(text).not.toContain("postgres://ledger_app");
    expect(log.some((x) => x["event"] === "listening")).toBe(false);
  });
});

describe("demo upstream (pin 6)", () => {
  it("tokenMatches is constant-time-safe (equal-length compare) and false on any difference", () => {
    const t = Buffer.from("abc123");
    expect(tokenMatches("abc123", t)).toBe(true);
    expect(tokenMatches("abc124", t)).toBe(false); expect(tokenMatches("abc12", t)).toBe(false); expect(tokenMatches("", t)).toBe(false); expect(tokenMatches("abc123x", t)).toBe(false);
  });
  it("handler: wrong credential → isError unauthorized before any tool runs; the five tools; bad arguments are tool errors; the log carries tool and status only", async () => {
    const log: LogLine[] = [];
    const h = createDemoHandler(Buffer.from(T), (x) => log.push(x));
    const c = (tool: string, args: Record<string, unknown>, value = T) => h({ callId: "c", credential: { kind: "api_key", value }, server: "demo", tool, args, receivedAt: new Date().toISOString() });
    expect(await c("echo", { message: "m" }, "wrong")).toEqual({ content: [{ type: "text", text: DEMO_UNAUTHORIZED_TEXT }], isError: true });
    expect(toolText(await c("echo", { message: "m" }) as never)).toBe("m");
    expect(Number.isFinite(Date.parse(toolText(await c("now", {}) as never)))).toBe(true);
    expect(toolText(await c("add", { a: 2, b: 3.5 }) as never)).toBe("5.5");
    expect(toolText(await c("wipe", { target: "prod" }) as never)).toBe(DEMO_WIPE_TEXT);
    expect(toolText(await c("whoami", {}) as never)).toBe(DEMO_WHOAMI_TEXT);
    for (const [tool, args] of [["echo", {}], ["add", { a: "2", b: 3 }], ["add", { a: Number.NaN, b: 1 }], ["wipe", {}], ["nope", {}]] as const) expect((await c(tool, args)).isError, tool).toBe(true);
    expect(log[0]).toMatchObject({ event: "call", tool: "echo", status: "unauthorized" });
    expect(Object.keys(log[1]!)).toEqual(["ts", "event", "tool", "status"]);
    expect(JSON.stringify(log)).not.toContain(T); expect(JSON.stringify(log)).not.toContain("prod");
    expect(DEMO_TOOLS.map((t) => t.name)).toEqual(["echo", "now", "add", "wipe", "whoami"]);
    expect(DEMO_TOOLS.every((t) => t.server === "demo" && t.inputSchema !== undefined)).toBe(true);
  });
  it("demoMain: reads the token from AGENT_LEDGER_DEMO_TOKEN_FILE (never argv), binds AGENT_LEDGER_DEMO_BIND_HOST, logs listening with the port; refuses NODE_OPTIONS, a missing/empty/loose token file", async () => {
    const d = tmp(); const tokenFile = join(d, "token"); write(tokenFile, `${T}\n`);
    const lines: string[] = [];
    const stderr = (s: string) => { lines.push(s); };
    const front = await demoMain({ AGENT_LEDGER_DEMO_PORT: "0", AGENT_LEDGER_DEMO_BIND_HOST: "127.0.0.1", AGENT_LEDGER_DEMO_TOKEN_FILE: tokenFile }, stderr);
    fronts.push(front);
    const listening = JSON.parse(lines.at(-1)!) as LogLine;
    expect(listening).toMatchObject({ event: "listening", port: front.port, bindHost: "127.0.0.1", tools: ["echo", "now", "add", "wipe", "whoami"] });
    expect(toolText(await mcpCall(`http://127.0.0.1:${front.port}/mcp`, T, "tools/call", { name: "echo", arguments: { message: "live" } }))).toBe("live");
    expect(((await mcpCall(`http://127.0.0.1:${front.port}/mcp`, T, "tools/list"))["tools"] as { name: string }[]).map((t) => t.name)).toEqual(["add", "echo", "now", "whoami", "wipe"]);
    const refuse = async (env: NodeJS.ProcessEnv, re: RegExp) => { const out: string[] = []; await expect(demoMain(env, (s) => { out.push(s); })).rejects.toThrow(re); expect(JSON.parse(out.at(-1)!)).toMatchObject({ event: "refused" }); expect(out.join("")).not.toContain(T); };
    await refuse({ AGENT_LEDGER_DEMO_TOKEN_FILE: tokenFile, NODE_OPTIONS: "--title=NODE_OPTIONS_CANARY" }, /NODE_OPTIONS is set/);
    await refuse({ AGENT_LEDGER_DEMO_PORT: "0" }, /AGENT_LEDGER_DEMO_TOKEN_FILE is required/);
    const empty = join(d, "empty"); write(empty, "\n");
    await refuse({ AGENT_LEDGER_DEMO_PORT: "0", AGENT_LEDGER_DEMO_TOKEN_FILE: empty }, /token file is empty/);
    const loose = join(d, "loose"); write(loose, T, 0o644);
    await refuse({ AGENT_LEDGER_DEMO_PORT: "0", AGENT_LEDGER_DEMO_TOKEN_FILE: loose }, /token file unreadable: loose: must be owned by this user with mode 0600/);
    await refuse({ AGENT_LEDGER_DEMO_PORT: "abc", AGENT_LEDGER_DEMO_TOKEN_FILE: tokenFile }, /AGENT_LEDGER_DEMO_PORT must be an integer/);
  });
});

describe("smoke client (pin 8), in process against the root + demo upstream", () => {
  it("runs the pinned sequence: SMOKE PASS once B's validator accepts channel none (until then it fails exactly at demo__wipe); a wrong key fails at the first governed call; the key is never printed", async () => {
    const l = await lab();
    const { url } = await up(l);
    const accepts = await validatorAcceptsNone();
    const lines: string[] = [];
    const code = await runSmoke({ url, key: KEY, upstreamUrl: l.demoUrl }, (s) => lines.push(s));
    expect(lines.join("\n")).not.toContain(KEY); expect(lines.join("\n")).not.toContain(T);
    expect(lines.slice(0, 5)).toEqual(["ok discover lists 2026-07-28", "ok tools/list contains the five demo tools, sorted overall", "ok demo__echo ok", "ok demo__now ok", "ok demo__add ok"]);
    if (!accepts) {
      expect(code).toBe(1); expect(lines.at(-1)).toBe("SMOKE FAIL demo__wipe denied: no channel"); expect(lines.at(-2)).toMatch(/^FAIL demo__wipe denied: no channel: Error: isError=true blocks=1 textBytes=\d+$/); // value-free (F1)
    } else {
      expect(code).toBe(0); expect(lines.at(-1)).toBe("SMOKE PASS");
      expect(lines.filter((x) => x.startsWith("ok ")).length).toBe(15);
      expect(lines).toContain("ok upstream direct, no bearer → 401");
      expect(lines).toContain("ok upstream direct, the agent's key → 401 on tools/call (the proxy key is not the upstream's credential)");
      expect(lines).toContain("ok upstream direct, the agent's key → 401 on tools/list (no upstream tool inventory)");
      expect(lines).toContain("ok wrong key → 401 on tools/call (unknown agent, not executed)");
      expect(lines).toContain("ok wrong key → 401 on tools/list (no tool inventory)");
    }
    const wrong: string[] = [];
    expect(await runSmoke({ url, key: "not-the-key" }, (s) => wrong.push(s))).toBe(1);
    expect(wrong.at(-1)).toBe("SMOKE FAIL discover lists 2026-07-28"); // ADR-018: an unknown key is refused before any method
    expect(l.demoLog.filter((x) => x["event"] === "call" && x["tool"] === "wipe")).toEqual([]);
    const d = tmp(); const keyFile = join(d, "api-key"); write(keyFile, `${KEY}\n`, 0o644);
    expect(parseSmokeArgs(["--url", url, "--key-file", keyFile, "--expect-upstream-401", l.demoUrl])).toEqual({ url, key: KEY, upstreamUrl: l.demoUrl });
    expect(() => parseSmokeArgs(["--url", url])).toThrow(/usage: smoke/);
    expect(() => parseSmokeArgs(["--url", url, "--key-file", keyFile, "--bogus"])).toThrow();
  });
});

// ---------- Fix round after Astra's review (docs/reviews/2026-10-03-astra-slice-2a-proxy-review.md) ----------
/** A raw 2026-07-28 upstream (node:http on 127.0.0.1:0) advertising the five demo tools; `onCall` decides each tools/call answer. */
interface RawCall { id: unknown; params: Record<string, unknown>; req: IncomingMessage; res: ServerResponse; }
async function rawUpstream(onCall: (c: RawCall) => void, onDiscover?: (c: RawCall) => boolean): Promise<{ url: string; calls: RawCall[] }> {
  const calls: RawCall[] = [];
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; const id = body["id"]; const params = (body["params"] ?? {}) as Record<string, unknown>;
      if (body["method"] === "server/discover") { if (onDiscover?.({ id, params, req, res })) return; return json(res, 200, { jsonrpc: "2.0", id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: {}, ttlMs: 1, cacheScope: "public" } }); }
      if (body["method"] === "tools/list") return json(res, 200, { jsonrpc: "2.0", id, result: { resultType: "complete", tools: DEMO_TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })), ttlMs: 1, cacheScope: "public" } });
      const c = { id, params, req, res }; calls.push(c); onCall(c);
    });
  });
  rawServers.push(srv);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`, calls };
}
const okJson = (c: RawCall, result: unknown) => { c.res.writeHead(200, { "content-type": "application/json" }); c.res.end(JSON.stringify({ jsonrpc: "2.0", id: c.id, result })); };
const pointAt = (l: Lab, url: string) => write(join(l.dir, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${url}\n`);
const ARG_CANARY = "root-arg-canary-5a9c";

describe("server root F1: upstream diagnostics reaching the agent, the log and the startup refusal are value-free", () => {
  it("a JSON-RPC error that reflects the upstream token and the raw argument: the reply, the log line and the ledger carry neither; the outcome is `error` with the error class", async () => {
    const up = await rawUpstream((c) => { c.res.writeHead(200, { "content-type": "application/json" }); c.res.end(JSON.stringify({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: `auth=${String(c.req.headers.authorization)} args=${JSON.stringify(c.params["arguments"])}` } })); });
    const l = await lab((l) => pointAt(l, up.url));
    const { url, log } = await up2(l);
    const r = await mcpCall(url, KEY, "tools/call", { name: "demo__echo", arguments: { message: ARG_CANARY } });
    expect(r["isError"]).toBe(true);
    expect(toolText(r)).toBe("agent-ledger: upstream failed: upstream demo: tools/call failed (JSON-RPC error -32000)");
    const everything = JSON.stringify(r) + JSON.stringify(log) + readFileSync(l.ledgerPath, "utf8");
    expect(everything).not.toContain(T); expect(everything).not.toContain("auth="); expect(JSON.stringify(log) + JSON.stringify(r)).not.toContain(ARG_CANARY);
    const recs = records(l);
    expect(recs.map((x) => [x.phase, x.outcome?.status ?? "-", x.outcome?.errorClass ?? "-"])).toEqual([["intent", "-", "-"], ["outcome", "error", "UpstreamError"]]);
    expect(log.at(-1)).toMatchObject({ tool: "echo", status: "error" });
  });
  it("startup: reflected discovery 500 and non-modern 404 followed by initialize refusal stay value-free", async () => {
    for (const status of [500, 404]) {
      const refuse = (c: RawCall) => { c.res.writeHead(status, { "content-type": "application/json" }); c.res.end(JSON.stringify({ jsonrpc: "2.0", id: c.id, error: { code: -32603, message: `saw ${String(c.req.headers.authorization)}` } })); return true; };
      // ADR-016/pin 2: -32603 is not a recognized modern error, so 404 must try initialize.
      // Explicitly refuse that attempt; silent-peer deadlines are tested with fake time in upstream-dual-era.
      const up = await rawUpstream(refuse, refuse);
      const l = await lab((l) => pointAt(l, up.url));
      const log: LogLine[] = [];
      let err: unknown; try { servers.push(await startServer(l.env, { log: (x) => log.push(x) })); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(StartupRefused);
      expect((err as Error).message).toBe(`upstreams: upstream demo: HTTP ${status} on ${status === 500 ? "server/discover" : "initialize"}`);
      expect((err as Error).message).not.toContain(T); expect((err as Error).message).not.toContain("saw ");
      expect(up.calls).toHaveLength(status === 500 ? 0 : 1);
      expect(JSON.stringify(log)).not.toContain(T); expect(JSON.stringify(log)).not.toContain("saw ");
    }
  });
});

describe("server root F2: a malformed upstream result is an `error` outcome and an isError reply, never `ok`", () => {
  it.each([
    ["content not an array, isError a string", { resultType: "complete", content: "not-content", isError: "true" }],
    ["content [null]", { resultType: "complete", content: [null] }],
    ["unrecognised resultType", { resultType: "partial", content: [] }],
  ])("%s", async (_label, result) => {
    const up = await rawUpstream((c) => okJson(c, result));
    const l = await lab((l) => pointAt(l, up.url));
    const { url, log } = await up2(l);
    const r = await mcpCall(url, KEY, "tools/call", { name: "demo__echo", arguments: { message: "x" } });
    expect(r["isError"]).toBe(true); expect(toolText(r)).toMatch(/^agent-ledger: upstream failed: upstream demo: tools\/call result is malformed/);
    expect(records(l).map((x) => [x.phase, x.outcome?.status ?? "-", x.outcome?.errorClass ?? "-"])).toEqual([["intent", "-", "-"], ["outcome", "error", "UpstreamError"]]);
    expect(log.at(-1)).toMatchObject({ tool: "echo", status: "error" });
  });
});

describe("server root F3: stop() drains in-flight calls before closing storage", () => {
  /** The real jsonl ledger, with every OUTCOME append delayed so the race the review found (storage closed before the outcome lands) is reproducible. */
  const slowOutcomes = (delayMs: number) => (kind: "jsonl" | "postgres", target: string): LedgerStore => {
    const real = createLedger(kind, target);
    return { ...real, head: () => real.head(), verify: () => real.verify(), read: (r) => real.read(r), async append(rec: UnsealedRecord) { if (rec.phase === "outcome") await new Promise((r) => setTimeout(r, delayMs)); return real.append(rec); } };
  };
  it("an upstream that answers during the drain: stop() resolves only after the `ok` outcome is persisted and the client got its result", async () => {
    const up = await rawUpstream(() => undefined);
    const l = await lab((l) => pointAt(l, up.url));
    const log: LogLine[] = [];
    const server = await startServer(l.env, { log: (x) => log.push(x), createLedger: slowOutcomes(300) }); servers.push(server);
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const reply = mcpCall(url, KEY, "tools/call", { name: "demo__echo", arguments: { message: "late" } });
    await vi.waitFor(() => expect(up.calls).toHaveLength(1));
    await vi.waitFor(() => expect(records(l).map((x) => x.phase)).toEqual(["intent"])); // the intent is durable; the upstream has the call
    const stopping = server.stop();
    setTimeout(() => okJson(up.calls[0]!, { resultType: "complete", content: [{ type: "text", text: "late" }], isError: false }), 100);
    await stopping;
    expect(records(l).map((x) => [x.phase, x.outcome?.status ?? "-"])).toEqual([["intent", "-"], ["outcome", "ok"]]); // persisted BEFORE stop() resolved
    expect(toolText(await reply)).toBe("late");
    expect(log.at(-1)).toMatchObject({ event: "stopped", drained: true, inflight: 0 });
  });
  it("an upstream that never answers: stop() aborts it, waits for the `error` outcome (UpstreamClosed) to persist, then closes; bounded well inside the 10 s grace", async () => {
    const up = await rawUpstream(() => undefined);
    const l = await lab((l) => pointAt(l, up.url));
    const log: LogLine[] = [];
    const server = await startServer(l.env, { log: (x) => log.push(x), createLedger: slowOutcomes(300) }); servers.push(server);
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const reply = mcpCall(url, KEY, "tools/call", { name: "demo__echo", arguments: { message: "never" } }).then((r) => r, (e: Error) => e);
    await vi.waitFor(() => expect(up.calls).toHaveLength(1));
    await vi.waitFor(() => expect(records(l).map((x) => x.phase)).toEqual(["intent"]));
    const started = Date.now();
    await server.stop();
    expect(Date.now() - started).toBeLessThan(9_000);
    expect(records(l).map((x) => [x.phase, x.outcome?.status ?? "-", x.outcome?.errorClass ?? "-"])).toEqual([["intent", "-", "-"], ["outcome", "error", "UpstreamClosed"]]);
    expect(log.at(-1)).toMatchObject({ event: "stopped", drained: true, inflight: 0 });
    expect(log.find((x) => x["callId"] !== undefined)).toMatchObject({ tool: "echo", status: "error" });
    await reply; // settled either way (result or connection closed); no unhandled rejection
    up.calls[0]!.res.destroy();
  }, 15_000); // the front's drain budget (SHUTDOWN_DRAIN_MS, 5 s) is spent waiting for the upstream before the abort
});

describe("server root F10: AGENT_LEDGER_MAX_INFLIGHT bounds concurrent tool invocations", () => {
  it("default 64; =1 → the second concurrent call is 503 with the overload code and no upstream call; an invalid value refuses to start", async () => {
    const up = await rawUpstream(() => undefined);
    const l = await lab((l) => { pointAt(l, up.url); l.env[ENV.maxInFlight] = "1"; });
    const { url, log } = await up2(l);
    expect(log.find((x) => x["event"] === "listening")).toMatchObject({ maxInFlight: 1 });
    const first = mcpCall(url, KEY, "tools/call", { name: "demo__echo", arguments: { message: "a" } });
    await vi.waitFor(() => expect(up.calls).toHaveLength(1));
    const second = await mcpPost({ url, token: KEY, method: "tools/call", params: { name: "demo__echo", arguments: { message: "b" } } });
    expect(second.status).toBe(503); expect((second.json as { error: { code: number } }).error.code).toBe(JSONRPC_OVERLOADED);
    expect(up.calls).toHaveLength(1); expect(records(l)).toHaveLength(1); // no intent for the refused call: it never became an IncomingCall
    okJson(up.calls[0]!, { resultType: "complete", content: [{ type: "text", text: "a" }], isError: false });
    expect(toolText(await first)).toBe("a");
    const bad = await lab((l) => { l.env[ENV.maxInFlight] = "0"; });
    await expect(startServer(bad.env, { log: () => undefined })).rejects.toThrow(/AGENT_LEDGER_MAX_INFLIGHT must be an integer 1-100000/);
  });
});

describe("server root F8: a FIFO where a private file is expected is refused, not blocked on", () => {
  it("hmac.key as a FIFO with no writer: the child refuses within the timeout naming the file (O_NONBLOCK open + same-fd regular-file check)", async () => {
    const l = await lab((l) => { rmSync(join(l.dir, "hmac.key")); execFileSync("mkfifo", ["-m", "600", join(l.dir, "hmac.key")]); });
    const script = `import(${JSON.stringify(pathToFileURL(resolve(".test-build/src/server/files.js")).href)}).then((m) => { try { m.readPrivateFile(${JSON.stringify(join(l.dir, "hmac.key"))}, 1024); console.log("NO THROW"); } catch (e) { console.log(e.message); } })`;
    const out = execFileSync(process.execPath, ["-e", script], { timeout: 5_000, encoding: "utf8" });
    expect(out.trim()).toBe("hmac.key: not a regular file");
  });
});

describe("demo upstream F9: the published input schemas are enforced before a tool runs", () => {
  it("additionalProperties:false, required and types are enforced for echo/now/whoami/add/wipe; valid calls still run", async () => {
    const h = createDemoHandler(Buffer.from(T));
    const c = (tool: string, args: Record<string, unknown>) => h({ callId: "c", credential: { kind: "api_key", value: T }, server: "demo", tool, args, receivedAt: new Date().toISOString() });
    const bad: [string, Record<string, unknown>][] = [["echo", { message: "hello", unexpected: 1 }], ["echo", {}], ["echo", { message: 5 }], ["now", { x: 1 }], ["whoami", { x: 1 }], ["add", { a: 1 }], ["add", { a: "1", b: 2 }], ["wipe", {}], ["wipe", { target: 7 }]];
    for (const [tool, args] of bad) { const r = await c(tool, args); expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true); expect(toolText(r as never), tool).toMatch(/^invalid arguments for /); }
    expect(toolText(await c("echo", { message: "hello" }) as never)).toBe("hello");
    expect(toolText(await c("add", { a: 1, b: 2, note: "extra allowed: the schema does not forbid it" }) as never)).toBe("3");
    expect(toolText(await c("wipe", { target: "prod" }) as never)).toBe(DEMO_WIPE_TEXT);
    expect(toolText(await c("now", {}) as never)).toMatch(/^\d{4}-/); expect(toolText(await c("whoami", {}) as never)).toBe(DEMO_WHOAMI_TEXT);
    expect(validateArgs({ a: 1 }, { type: "object", properties: { a: { type: "integer" } }, required: ["a"], additionalProperties: false })).toBeUndefined();
    expect(validateArgs({ a: 1.5 }, { type: "object", properties: { a: { type: "integer" } } })).toMatch(/a: expected integer/);
    expect(validateArgs({ a: 1 }, { type: "object", $ref: "https://example.com/schema" })).toMatch(/unsupported schema/); // never fetched, never permissive
  });
});
