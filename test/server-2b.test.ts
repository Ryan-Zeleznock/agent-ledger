import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ApprovalResult, LedgerRecord, PolicyDecision, ToolCall } from "../src/types/index.js";
import type { SlackChannel } from "../src/approvals/contract.js";
import { CONNECT_BACKOFF_MS, ENV, StartupRefused, startServer, type LogLine, type RunningServer } from "../src/server/main.js";
import { startDemoUpstream } from "../src/server/demo-upstream.js";
import { frontSupportsTls } from "../src/server/seams.js";
import type { RunningFront } from "../src/front/contract.js";
import { mcpCall, toolText } from "./helpers/mcp-client.js";

// Slice 2b pin 6, in process. The approvals module is REPLACED here by a scripted fake of the pinned exports
// (configureSlackApprovals, validateSlackChannel, probeSlack, requestApproval, closeSlackApprovals), so these rows prove
// the ROOT's wiring (order, retry, refusals, shutdown order, log shape) independently of Package A's Slack code. A's real
// implementation behind the real root is proven by test/e2e-slice-2b.test.ts against the loopback fake Slack server.
const fake = vi.hoisted(() => {
  const state = {
    calls: [] as string[],
    configured: [] as unknown[],
    problems: [] as string[],
    probeFailures: 0,
    probeReason: "auth.test: invalid_auth",
    pending: [] as { call: { callId: string }; resolve: (r: unknown) => void }[],
    closed: 0,
    reset() { this.calls = []; this.configured = []; this.problems = []; this.probeFailures = 0; this.probeReason = "auth.test: invalid_auth"; this.pending = []; this.closed = 0; },
  };
  return state;
});
vi.mock("../src/approvals/contract.js", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    SLACK_API_BASE_URL: "https://slack.com/api/",
    SLACK_PROXY_MAX_TIMEOUT_MS: 240_000,
    configureSlackApprovals: (cfg: unknown) => { fake.calls.push("configure"); fake.configured.push(cfg); },
    validateSlackChannel: async (ch: SlackChannel) => { fake.calls.push("validate"); expect(ch.botToken).toMatchObject({ kind: "file" }); return fake.problems; },
    probeSlack: async () => {
      fake.calls.push("probe");
      if (fake.probeFailures > 0) { fake.probeFailures--; return { ok: false, reason: fake.probeReason }; }
      return { ok: true, teamId: "T0TEAM0001", botUserId: "U0BOT00001", appId: "A0APP00001" };
    },
    requestApproval: (call: ToolCall, _d: PolicyDecision, _ch: SlackChannel) => {
      fake.calls.push("request");
      return new Promise<ApprovalResult>((resolve) => { fake.pending.push({ call, resolve: resolve as (r: unknown) => void }); });
    },
    closeSlackApprovals: async () => {
      fake.calls.push("close"); fake.closed++;
      for (const p of fake.pending.splice(0)) p.resolve({ callId: p.call.callId, decision: "unavailable", reason: "Slack unreachable: proxy shutting down", decidedAt: new Date().toISOString(), channel: "slack" });
    },
  };
});

const KEY = "proxy-api-key-canary-2b-71ac"; const T = "demo-upstream-token-canary-2b-93d0";
const BOT = "xoxb-bot-token-canary-2b-11"; const APP = "xapp-app-token-canary-2b-22";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const REGISTRY = { version: 1, servers: { demo: { trusted: true, tools: {
  echo: { class: "read", reviewedBy: "ryan", reviewedAt: "2026-10-04", storeArgs: ["message"] },
  wipe: { class: "risky", reviewedBy: "ryan", reviewedAt: "2026-10-04", storeArgs: [] },
} } } };
const APPROVALS = "version: 1\nslack:\n  channelId: C0123456789\n  approvers: [U0123456789, W0123456789]\n  timeoutMs: 180000\n";
const dirs: string[] = []; const fronts: RunningFront[] = []; const servers: RunningServer[] = []; const raws: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop().catch(() => undefined);
  for (const f of fronts.splice(0)) await f.stop().catch(() => undefined);
  for (const r of raws.splice(0)) { r.closeAllConnections(); await new Promise<void>((d) => r.close(() => d())); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  fake.reset();
});
const write = (p: string, s: string | Buffer, mode = 0o600) => { writeFileSync(p, s, { mode }); chmodSync(p, mode); };
interface Lab { dir: string; env: NodeJS.ProcessEnv; ledgerPath: string; }
async function lab(opts: { slack?: boolean; upstreamUrl?: string } = {}): Promise<Lab> {
  let url = opts.upstreamUrl;
  if (url === undefined) {
    const demo = await startDemoUpstream({ port: 0, bindHost: "127.0.0.1", token: Buffer.from(T), log: () => undefined });
    fronts.push(demo); url = `http://127.0.0.1:${demo.port}/mcp`;
  }
  const dir = mkdtempSync(join(tmpdir(), "agent-ledger-server2b-")); dirs.push(dir);
  write(join(dir, "registry.yaml"), JSON.stringify(REGISTRY));
  write(join(dir, "agents.yaml"), JSON.stringify({ version: 1, agents: [{ id: "claude-lab", credential: { kind: "api_key", sha256: sha256(KEY) } }] }));
  write(join(dir, "hmac.key"), randomBytes(32));
  mkdirSync(join(dir, "secrets")); write(join(dir, "secrets", "demo.bearerToken"), `${T}\n`);
  write(join(dir, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: ${url}\n`);
  if (opts.slack) {
    write(join(dir, "approvals.yaml"), APPROVALS);
    write(join(dir, "secrets", "approvals.botToken"), `${BOT}\n`); write(join(dir, "secrets", "approvals.appToken"), `${APP}\n`);
  }
  const ledgerPath = join(dir, "ledger", "records.jsonl");
  const env: NodeJS.ProcessEnv = { [ENV.configDir]: dir, [ENV.ledgerUrl]: pathToFileURL(ledgerPath).toString(), [ENV.port]: "0", [ENV.bindHost]: "127.0.0.1",
    [ENV.allowedOrigins]: "", [ENV.approvals]: opts.slack ? "slack" : "none", [ENV.tls]: "off", [ENV.connectBudget]: "0" };
  return { dir, env, ledgerPath };
}
async function up(l: Lab, log: LogLine[] = [], extra: Parameters<typeof startServer>[1] = {}) {
  const server = await startServer(l.env, { log: (line) => log.push(line), ...extra }); servers.push(server);
  return { server, url: `http://127.0.0.1:${server.port}/mcp`, log };
}
async function refusal(l: Lab, re: RegExp): Promise<LogLine[]> {
  const log: LogLine[] = [];
  await expect(startServer(l.env, { log: (x) => log.push(x) })).rejects.toBeInstanceOf(StartupRefused);
  const refused = log.find((x) => x["event"] === "refused");
  expect(String(refused?.["reason"])).toMatch(re);
  expect(log.some((x) => x["event"] === "listening")).toBe(false);
  const text = JSON.stringify(log); for (const s of [KEY, T, BOT, APP]) expect(text).not.toContain(s);
  return log;
}
const records = (l: Lab): LedgerRecord[] => { try { return readFileSync(l.ledgerPath, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x) as LedgerRecord); } catch { return []; } };

describe("server root 2b: environment refusals (pin 6)", () => {
  it("AGENT_LEDGER_TLS absent or not on|off → refused (no silent plaintext); off → a warning start line", async () => {
    const l = await lab();
    delete l.env[ENV.tls]; await refusal(l, /AGENT_LEDGER_TLS must be "on" or "off" \(got nothing: no silent plaintext/);
    l.env[ENV.tls] = "true"; await refusal(l, /AGENT_LEDGER_TLS must be "on" or "off" \(got "true"\)/);
    l.env[ENV.tls] = "off";
    const { log } = await up(l);
    expect(log[0]).toMatchObject({ event: "warning", tls: "off" });
    expect(log.find((x) => x["event"] === "listening")).toMatchObject({ approvals: "none", tls: "off" });
  });
  it("AGENT_LEDGER_APPROVALS other than none|slack; AGENT_LEDGER_UPSTREAM_CONNECT_BUDGET_MS outside 0..600000", async () => {
    const l = await lab();
    l.env[ENV.approvals] = "SLACK"; await refusal(l, /AGENT_LEDGER_APPROVALS must be "none" or "slack"/);
    l.env[ENV.approvals] = "none";
    for (const b of ["600001", "-1", "1e3", ""]) { l.env[ENV.connectBudget] = b; await refusal(l, /AGENT_LEDGER_UPSTREAM_CONNECT_BUDGET_MS must be an integer 0-600000/); }
  });
  it("an upstream named `approvals` is refused (reserved: the Slack tokens are secrets/approvals.*)", async () => {
    const l = await lab();
    write(join(l.dir, "upstreams.yaml"), "version: 1\nupstreams:\n  - name: approvals\n    transport: http\n    url: http://127.0.0.1:9/mcp\n");
    await refusal(l, /upstreams\[0\]: name approvals is reserved/);
  });
});

describe("server root 2b: approvals.yaml (pin 5)", () => {
  const cases: [string, string | null, RegExp][] = [
    ["missing", null, /approvals\.yaml: cannot be read/],
    ["unknown top field", `${APPROVALS}extra: 1\n`, /approvals\.yaml: unknown field extra/],
    ["unknown slack field", APPROVALS.replace("timeoutMs", "botToken: x\n  timeoutMs"), /slack: unknown field botToken/],
    ["version 2", APPROVALS.replace("version: 1", "version: 2"), /version/],
    ["bad channel id", APPROVALS.replace("C0123456789", "#approvals"), /slack\.channelId must match/],
    ["empty approvers", APPROVALS.replace("[U0123456789, W0123456789]", "[]"), /slack\.approvers must be a non-empty sequence/],
    ["bad approver id", APPROVALS.replace("W0123456789", "ryan"), /slack\.approvers\[1\] must match/],
    ["duplicate approver", APPROVALS.replace("W0123456789", "U0123456789"), /duplicate/],
    ["timeoutMs 240001", APPROVALS.replace("180000", "240001"), /slack\.timeoutMs must be an integer 1000\.\.240000/],
    ["timeoutMs 999", APPROVALS.replace("180000", "999"), /slack\.timeoutMs must be an integer/],
    ["timeoutMs string", APPROVALS.replace("180000", '"180000"'), /slack\.timeoutMs must be an integer/],
    ["non-loopback apiBaseUrl", `${APPROVALS}  apiBaseUrl: http://evil.example/api/\n`, /slack\.apiBaseUrl must be https:\/\/slack\.com\/api\/ or http:\/\/127\.0\.0\.1:<port>\/api\//],
    ["localhost apiBaseUrl", `${APPROVALS}  apiBaseUrl: http://localhost:8080/api/\n`, /slack\.apiBaseUrl must be/],
    ["https loopback apiBaseUrl", `${APPROVALS}  apiBaseUrl: https://127.0.0.1:8080/api/\n`, /slack\.apiBaseUrl must be/],
    ["port 70000", `${APPROVALS}  apiBaseUrl: http://127.0.0.1:70000/api/\n`, /slack\.apiBaseUrl must be/],
  ];
  for (const [name, body, re] of cases) {
    it(`refused: ${name} (nothing Slack-side is touched)`, async () => {
      const l = await lab({ slack: true });
      if (body === null) rmSync(join(l.dir, "approvals.yaml")); else write(join(l.dir, "approvals.yaml"), body);
      await refusal(l, re);
      expect(fake.calls).toEqual([]);
    });
  }
  it("refused: approvals.yaml group-writable", async () => {
    const l = await lab({ slack: true }); chmodSync(join(l.dir, "approvals.yaml"), 0o620);
    await refusal(l, /approvals\.yaml: unsafe permissions or owner/);
  });
  it("timeoutMs omitted → 180000; the loopback apiBaseUrl is handed to configureSlackApprovals, and only then", async () => {
    const l = await lab({ slack: true });
    write(join(l.dir, "approvals.yaml"), APPROVALS.replace("  timeoutMs: 180000\n", "") + "  apiBaseUrl: http://127.0.0.1:4555/api/\n");
    const { log } = await up(l);
    expect(fake.configured).toEqual([{ apiBaseUrl: "http://127.0.0.1:4555/api/" }]);
    expect(log.find((x) => x["event"] === "approvals")).toMatchObject({ timeoutMs: 180_000 });
  });
});

describe("server root 2b: Slack start, call, shutdown order (pin 6, fake approvals module)", () => {
  it("validate → probe → `approvals` line (count, no token) → listening approvals: slack; configure is NOT called without apiBaseUrl", async () => {
    const l = await lab({ slack: true });
    const { log } = await up(l);
    expect(fake.calls).toEqual(["validate", "probe", "validate"]);   // the root's, then the pipeline's own init check
    expect(log.map((x) => x["event"])).toEqual(["warning", "ledger", "upstreams", "approvals", "listening"]);
    expect(log.find((x) => x["event"] === "approvals")).toEqual({ ts: expect.any(String), event: "approvals", kind: "slack", channelId: "C0123456789", approvers: 2, timeoutMs: 180_000, teamId: "T0TEAM0001" });
    expect(log.find((x) => x["event"] === "listening")).toMatchObject({ approvals: "slack" });
    const text = JSON.stringify(log); expect(text).not.toContain(BOT); expect(text).not.toContain(APP); expect(text).not.toContain("U0123456789");
  });
  it("validateSlackChannel problems → refused naming them; the upstream client is closed", async () => {
    const l = await lab({ slack: true }); fake.problems = ["botToken must start with xoxb-"];
    await refusal(l, /approvals: botToken must start with xoxb-/);
    expect(fake.calls).toEqual(["validate", "close"]);
  });
  it("probeSlack failing is retried under the connect backoff; still failing at the budget → refused with its value-free reason", async () => {
    const l = await lab({ slack: true }); l.env[ENV.connectBudget] = "3000"; fake.probeFailures = 99;
    const sleeps: number[] = []; let t = 0;
    const log: LogLine[] = [];
    await expect(startServer(l.env, { log: (x) => log.push(x), sleep: async (ms) => { sleeps.push(ms); t += ms; }, clock: () => t })).rejects.toBeInstanceOf(StartupRefused);
    expect(sleeps).toEqual([1000, 2000]);
    expect(log.filter((x) => x["event"] === "approvals-retry").map((x) => [x["attempt"], x["nextInMs"], x["reason"]])).toEqual([[1, 1000, "auth.test: invalid_auth"], [2, 2000, "auth.test: invalid_auth"]]);
    expect(String(log.at(-1)?.["reason"])).toBe("approvals: Slack probe failed (auth.test: invalid_auth)");
  });
  it("probeSlack failing once, then ok → starts", async () => {
    const l = await lab({ slack: true }); l.env[ENV.connectBudget] = "60000"; fake.probeFailures = 1;
    const { log } = await up(l, [], { sleep: async () => undefined });
    expect(fake.calls).toEqual(["validate", "probe", "probe", "validate"]);
    expect(log.some((x) => x["event"] === "listening")).toBe(true);
  });
  it("a risky call waits on requestApproval; SIGTERM-equivalent stop() → closeSlackApprovals FIRST, the pending approval is recorded `unavailable` (proxy shutting down) and denied before storage closes", async () => {
    const l = await lab({ slack: true });
    const { server, url, log } = await up(l);
    const call = mcpCall(url, KEY, "tools/call", { name: "demo__wipe", arguments: { target: "x" } });
    await vi.waitFor(() => expect(fake.pending.length).toBe(1), { timeout: 5_000 });
    const started = Date.now();
    await server.stop(); servers.splice(servers.indexOf(server), 1);
    expect(Date.now() - started).toBeLessThan(5_000);       // nobody waited for the front's drain timer on a human
    expect(fake.calls).toEqual(["validate", "probe", "validate", "request", "close"]);
    const r = await call;
    expect(r["isError"]).toBe(true); expect(toolText(r)).toMatch(/proxy shutting down/);
    const recs = records(l);
    expect(recs[0]).toMatchObject({ phase: "intent", approval: { decision: "unavailable", channel: "slack", reason: "Slack unreachable: proxy shutting down" } });
    expect(recs[1]).toMatchObject({ phase: "outcome", outcome: { status: "blocked" } });
    expect(log.at(-1)).toMatchObject({ event: "stopped", drained: true });
  });
});

describe("server root 2b: upstream connect retry (pin 6)", () => {
  it("attempts at 0, +1 s, +2 s: an upstream that answers 503 twice and then serves → starts; each retry logged value-free; eras on the upstreams line", async () => {
    const demo = await startDemoUpstream({ port: 0, bindHost: "127.0.0.1", token: Buffer.from(T), log: () => undefined }); fronts.push(demo);
    let failures = 2;
    const gate = createServer((req, res) => {
      if (failures > 0) { failures--; req.resume(); res.writeHead(503).end(); return; }
      const chunks: Buffer[] = []; req.on("data", (c: Buffer) => chunks.push(c)); req.on("end", () => {
        void fetch(`http://127.0.0.1:${demo.port}/mcp`, { method: "POST", headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) }).then(async (u) => {
          res.writeHead(u.status, { "content-type": u.headers.get("content-type") ?? "application/json" }); res.end(Buffer.from(await u.arrayBuffer()));
        });
      });
    });
    raws.push(gate); await new Promise<void>((d) => gate.listen(0, "127.0.0.1", () => d()));
    const l = await lab({ upstreamUrl: `http://127.0.0.1:${(gate.address() as AddressInfo).port}/mcp` }); l.env[ENV.connectBudget] = "60000";
    const sleeps: number[] = []; let t = 0;
    const { log } = await up(l, [], { sleep: async (ms) => { sleeps.push(ms); t += ms; }, clock: () => t });
    expect(sleeps).toEqual([1000, 2000]);
    const retries = log.filter((x) => x["event"] === "upstreams-retry");
    expect(retries.map((x) => [x["attempt"], x["nextInMs"]])).toEqual([[1, 1000], [2, 2000]]);
    for (const r of retries) expect(String(r["reason"])).toMatch(/503/);
    expect(log.find((x) => x["event"] === "upstreams")).toMatchObject({ servers: ["demo"], eras: { demo: "modern" } });
    expect(JSON.stringify(log)).not.toContain(T);
  });
  it("the budget bounds the attempts (1+2+4 s fit in 10 s, the next 8 s does not) → refused with the last reason; budget 0 → one attempt", async () => {
    const dead = createServer((req, res) => { req.resume(); res.writeHead(503).end(); }); raws.push(dead);
    await new Promise<void>((d) => dead.listen(0, "127.0.0.1", () => d()));
    const l = await lab({ upstreamUrl: `http://127.0.0.1:${(dead.address() as AddressInfo).port}/mcp` }); l.env[ENV.connectBudget] = "10000";
    const sleeps: number[] = []; let t = 0; const log: LogLine[] = [];
    await expect(startServer(l.env, { log: (x) => log.push(x), sleep: async (ms) => { sleeps.push(ms); t += ms; }, clock: () => t })).rejects.toBeInstanceOf(StartupRefused);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(String(log.at(-1)?.["reason"])).toMatch(/^upstreams: .*503/);
    expect(CONNECT_BACKOFF_MS).toEqual([1000, 2000, 4000, 8000, 16000]);
    l.env[ENV.connectBudget] = "0"; sleeps.length = 0;
    await expect(startServer(l.env, { log: () => undefined, sleep: async (ms) => { sleeps.push(ms); } })).rejects.toBeInstanceOf(StartupRefused);
    expect(sleeps).toEqual([]);
  });
  it("past 16 s the wait repeats 16 s", async () => {
    const dead = createServer((req, res) => { req.resume(); res.writeHead(503).end(); }); raws.push(dead);
    await new Promise<void>((d) => dead.listen(0, "127.0.0.1", () => d()));
    const l = await lab({ upstreamUrl: `http://127.0.0.1:${(dead.address() as AddressInfo).port}/mcp` }); l.env[ENV.connectBudget] = "70000";
    const sleeps: number[] = []; let t = 0;
    await expect(startServer(l.env, { log: () => undefined, sleep: async (ms) => { sleeps.push(ms); t += ms; }, clock: () => t })).rejects.toBeInstanceOf(StartupRefused);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 16000, 16000]);
  });
});

describe("server root 2b: TLS files (ADR-017)", () => {
  const pair = (dir: string) => {
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, "tls.key"), "-out", join(dir, "tls.crt")], { stdio: "ignore" });
    chmodSync(join(dir, "tls.key"), 0o600); chmodSync(join(dir, "tls.crt"), 0o644);
  };
  it("on: tls.crt missing → refused; tls.key group-readable → refused naming the file; tls.key not PEM → refused; never the key bytes", async () => {
    const l = await lab(); l.env[ENV.tls] = "on";
    await refusal(l, /tls\.crt: cannot be read/);
    pair(l.dir);
    const keyText = readFileSync(join(l.dir, "tls.key"), "utf8");
    chmodSync(join(l.dir, "tls.key"), 0o640);
    const log = await refusal(l, /tls\.key: must be owned by this user with mode 0600/);
    expect(JSON.stringify(log)).not.toContain(keyText.split("\n")[1]!);
    write(join(l.dir, "tls.key"), "not a key\n"); await refusal(l, /tls\.key: must be a PEM private key/);
    write(join(l.dir, "tls.crt"), "not a cert\n", 0o644); await refusal(l, /tls\.crt: must be a PEM certificate/);
  });
  it("on with a valid pair: serves HTTPS once the front has A's TLS option; before integration the root refuses instead of serving plaintext", async () => {
    const l = await lab(); l.env[ENV.tls] = "on"; pair(l.dir);
    if (!frontSupportsTls()) { await refusal(l, /front: front TLS option is not on this branch yet .*pre-integration/); return; }
    const { log } = await up(l);
    expect(log.some((x) => x["event"] === "warning")).toBe(false);
    expect(log.find((x) => x["event"] === "listening")).toMatchObject({ tls: "on" });
  });
});

describe("server root 2b fix round F2: the start budget bounds each WHOLE attempt, not just the sleeps", () => {
  type Up = Awaited<ReturnType<typeof import("../src/upstream/contract.js").connectUpstreams>>;
  const fakeUpstream = (closed: string[], name: string): Up => ({ listTools: async () => [], execute: async () => { throw new Error("unused"); }, close: async () => { closed.push(name); } });
  it("a SUCCESSFUL but slow attempt (180 s by the injected clock, e.g. discovery + 8 list pages at 20 s) past the 60 s budget is refused and its upstream client closed; nothing listens", async () => {
    const l = await lab(); l.env[ENV.connectBudget] = "60000";
    let t = 0; const closed: string[] = []; const log: LogLine[] = [];
    await expect(startServer(l.env, { log: (x) => log.push(x), clock: () => t, sleep: async (ms) => { t += ms; },
      connectUpstreams: async () => { t += 180_000; return fakeUpstream(closed, "slow"); } })).rejects.toBeInstanceOf(StartupRefused);
    expect(String(log.at(-1)?.["reason"])).toBe("upstreams: attempt 1 did not finish within the 60000 ms start budget");
    await vi.waitFor(() => expect(closed).toEqual(["slow"]));
    expect(log.some((x) => x["event"] === "listening")).toBe(false);
  });
  it("a HANGING attempt is cut when the deadline (= the whole budget for attempt 1) fires; a result that arrives after the refusal is closed, never activated", async () => {
    const l = await lab(); l.env[ENV.connectBudget] = "60000";
    const deadlines: number[] = []; const closed: string[] = []; const log: LogLine[] = [];
    let release: (u: Up) => void = () => undefined;
    const hanging = new Promise<Up>((r) => { release = r; });
    await expect(startServer(l.env, { log: (x) => log.push(x), clock: () => 0, deadline: async (ms) => { deadlines.push(ms); }, connectUpstreams: () => hanging })).rejects.toBeInstanceOf(StartupRefused);
    expect(deadlines).toEqual([60_000]);
    expect(String(log.at(-1)?.["reason"])).toMatch(/did not finish within the 60000 ms start budget/);
    release(fakeUpstream(closed, "late"));
    await vi.waitFor(() => expect(closed).toEqual(["late"]));
  });
  it("deadlines shrink with time spent: after failures and sleeps the next attempt only gets what is left; a failure near the deadline is refused with ITS reason; budget 0 = one attempt bounded at 30 s", async () => {
    const l = await lab(); l.env[ENV.connectBudget] = "10000";
    let t = 0; const deadlines: number[] = []; let n = 0; const log: LogLine[] = [];
    await expect(startServer(l.env, { log: (x) => log.push(x), clock: () => t, sleep: async (ms) => { t += ms; }, deadline: () => new Promise(() => undefined),
      connectUpstreams: async () => { n++; t += 500; throw new Error(`HTTP 503 #${n}`); } })).rejects.toBeInstanceOf(StartupRefused);
    expect(String(log.at(-1)?.["reason"])).toMatch(/HTTP 503 #4$/);
    const l0 = await lab(); l0.env[ENV.connectBudget] = "0";
    await expect(startServer(l0.env, { log: () => undefined, clock: () => 0, deadline: async (ms) => { deadlines.push(ms); }, connectUpstreams: () => new Promise(() => undefined) })).rejects.toBeInstanceOf(StartupRefused);
    expect(deadlines).toEqual([30_000]);
    // the remaining-time arithmetic, observed: 10 s budget, each failure costs 0.5 s, sleeps 1, 2, 4 s
    const seen: number[] = []; t = 0; n = 0;
    await expect(startServer(l.env, { log: () => undefined, clock: () => t, sleep: async (ms) => { t += ms; }, deadline: (ms) => { seen.push(ms); return new Promise(() => undefined); },
      connectUpstreams: async () => { n++; t += 500; throw new Error("x"); } })).rejects.toBeInstanceOf(StartupRefused);
    expect(seen).toEqual([30_000, 28_500, 26_000, 21_500]);
  });
});

describe("server root: security round P3s (server audit 2026-10-05)", () => {
  it("AGENT_LEDGER_TLS=off with a non-loopback bind is refused; off-non-loopback is the explicit override (logged); loopback binds keep plain off", async () => {
    const l = await lab();
    l.env[ENV.bindHost] = "192.0.2.1"; l.env[ENV.tls] = "off";
    await refusal(l, /AGENT_LEDGER_TLS=off with AGENT_LEDGER_BIND_HOST="192\.0\.2\.1" would serve bearer tokens in plaintext/);
    l.env[ENV.tls] = "off-non-loopback";
    const log = await refusal(l, /^front: /); // past the TLS rule; this TEST-NET address cannot be bound, so no test binds a real interface
    expect(log[0]).toMatchObject({ event: "warning", tls: "off", bindHost: "192.0.2.1", override: "off-non-loopback" });
    for (const host of ["127.0.0.1", "localhost"]) {
      l.env[ENV.bindHost] = host; l.env[ENV.tls] = "off";
      const { log: ok } = await up(l); expect(ok.find((x) => x["event"] === "listening")).toMatchObject({ tls: "off", bindHost: host });
    }
  });
  it("the listening line carries the SHA-256 of registry.yaml, agents.yaml, upstreams.yaml (and approvals.yaml in slack mode), never their contents", async () => {
    const l = await lab();
    const { log } = await up(l);
    const listening = log.find((x) => x["event"] === "listening")!;
    const h = (f: string) => createHash("sha256").update(readFileSync(join(l.dir, f), "utf8"), "utf8").digest("hex");
    expect(listening["configSha256"]).toEqual({ "registry.yaml": h("registry.yaml"), "agents.yaml": h("agents.yaml"), "upstreams.yaml": h("upstreams.yaml") });
    expect(JSON.stringify(log)).not.toContain(readFileSync(join(l.dir, "agents.yaml"), "utf8").slice(0, 40));
  });
});
