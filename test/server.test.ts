import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LedgerRecord } from "../src/types/index.js";
import { PROXY_NO_CHANNEL_REASON } from "../src/types/index.js";
import { createLedger, type LedgerStore } from "../src/ledger/contract.js";
import { ENV, StartupRefused, startServer, type LogLine, type RunningServer } from "../src/server/main.js";
import { DEMO_TOOLS, DEMO_UNAUTHORIZED_TEXT, DEMO_WHOAMI_TEXT, DEMO_WIPE_TEXT, createDemoHandler, demoMain, startDemoUpstream, tokenMatches } from "../src/server/demo-upstream.js";
import type { RunningFront } from "../src/front/contract.js";
import { parseSmokeArgs, runSmoke } from "../src/server/smoke.js";
import { mcpCall, toolText } from "./helpers/mcp-client.js";

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
const dirs: string[] = []; const fronts: RunningFront[] = []; const servers: RunningServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop().catch(() => undefined);
  for (const f of fronts.splice(0)) await f.stop().catch(() => undefined);
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
  const env: NodeJS.ProcessEnv = { [ENV.configDir]: dir, [ENV.ledgerUrl]: pathToFileURL(ledgerPath).toString(), [ENV.port]: "0", [ENV.bindHost]: "127.0.0.1", [ENV.allowedOrigins]: "", [ENV.approvals]: "none" };
  const l = { dir, env, demoUrl, demoLog, ledgerPath };
  mut(l);
  return l;
}
async function up(l: Lab, log: LogLine[] = []): Promise<{ server: RunningServer; url: string; log: LogLine[] }> {
  const server = await startServer(l.env, { log: (line) => log.push(line) });
  servers.push(server);
  return { server, url: `http://127.0.0.1:${server.port}/mcp`, log };
}
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
    expect(log.map((x) => x["event"])).toEqual(["ledger", "upstreams", "listening"]);
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
  it("a wrong key is denied by identity with no record and a log line without agentId; the agent's key is NOT the upstream's credential (direct call → unauthorized)", async () => {
    const l = await lab();
    const { url, log } = await up(l);
    const r = await mcpCall(url, "not-the-key", "tools/call", { name: "demo__echo", arguments: { message: "x" } });
    expect(r["isError"]).toBe(true); expect(toolText(r)).toMatch(/unknown agent/);
    expect(records(l)).toEqual([]);
    const line = log.find((x) => x["callId"] !== undefined)!;
    expect(line).toMatchObject({ server: "demo", tool: "echo", status: "denied" }); expect(line["agentId"]).toBeUndefined(); expect(line["verdict"]).toBeUndefined();
    const direct = await mcpCall(l.demoUrl, KEY, "tools/call", { name: "echo", arguments: { message: "x" } });
    expect(direct).toMatchObject({ isError: true }); expect(toolText(direct)).toBe(DEMO_UNAUTHORIZED_TEXT);
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
  it("approvals other than none, or absent", async () => { await refusal((l) => { l.env[ENV.approvals] = "slack"; }, /AGENT_LEDGER_APPROVALS must be "none"/); await refusal((l) => { delete l.env[ENV.approvals]; }, /got nothing/); });
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
    expect(lines.slice(0, 5)).toEqual(["ok discover lists 2026-07-28", "ok tools/list is exactly the five demo tools, sorted", "ok demo__echo ok", "ok demo__now ok", "ok demo__add ok"]);
    if (!accepts) {
      expect(code).toBe(1); expect(lines.at(-1)).toBe("SMOKE FAIL demo__wipe denied: no channel"); expect(lines.at(-2)).toMatch(/^FAIL demo__wipe denied: no channel: isError=true text=.*ledger unavailable/);
    } else {
      expect(code).toBe(0); expect(lines.at(-1)).toBe("SMOKE PASS");
      expect(lines.filter((x) => x.startsWith("ok ")).length).toBe(13);
      expect(lines).toContain("ok upstream direct, no token → 401");
      expect(lines).toContain("ok upstream direct, the agent's key → unauthorized (the proxy key is not the upstream's credential)");
    }
    const wrong: string[] = [];
    expect(await runSmoke({ url, key: "not-the-key" }, (s) => wrong.push(s))).toBe(1);
    expect(wrong.slice(0, 2)).toEqual(["ok discover lists 2026-07-28", "ok tools/list is exactly the five demo tools, sorted"]);
    expect(wrong.at(-1)).toBe("SMOKE FAIL demo__echo ok");
    expect(l.demoLog.filter((x) => x["event"] === "call" && x["tool"] === "wipe")).toEqual([]);
    const d = tmp(); const keyFile = join(d, "api-key"); write(keyFile, `${KEY}\n`, 0o644);
    expect(parseSmokeArgs(["--url", url, "--key-file", keyFile, "--expect-upstream-401", l.demoUrl])).toEqual({ url, key: KEY, upstreamUrl: l.demoUrl });
    expect(() => parseSmokeArgs(["--url", url])).toThrow(/usage: smoke/);
    expect(() => parseSmokeArgs(["--url", url, "--key-file", keyFile, "--bogus"])).toThrow();
  });
});
