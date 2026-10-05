import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import canonicalize from "canonicalize";
import { ANCHOR_NOTE, main, type CliDeps } from "../src/cli/main.js";
import { createIdentity } from "../src/identity/contract.js";
import { loadRegistry } from "../src/policy/contract.js";
import { WATCHDOG_DEADLINE_DENY_REASON, type PipelineDeps } from "../src/pipeline/contract.js";
import { createLedger, type LedgerStore } from "../src/ledger/contract.js";
import { DEFAULT_DEADLINE_MS, HOOK_TIMEOUT_S, WATCHDOG_DEADLINE_AT_ENV, WATCHDOG_DEADLINE_ENV, type HeartbeatProbe } from "../src/hooks/contract.js";
import { HEARTBEAT_RULE_ID, HEARTBEAT_TOOL, PERMISSION_DENIED_ERROR_CLASS, type IncomingCall, type LedgerRecord, type SessionHeartbeat } from "../src/types/index.js";

const dirs: string[] = [];
async function sandbox() { const d = await mkdtemp(join(tmpdir(), "cli-test-")); dirs.push(d); return d; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
function run(args: string[], overrides: Partial<CliDeps> = {}) {
  let out = "", err = "";
  const result = main(args, { stdout: s => { out += s; }, stderr: s => { err += s; }, ...overrides });
  return { result, output: () => out, error: () => err };
}
async function initialized() { const dir = join(await sandbox(), "local"); expect(await run(["init", "--dir", dir]).result).toBe(0); return dir; }
/** Runs `fn` with both watchdog clock variables ABSENT (the record-only handlers' real environment), then restores them. */
async function withoutWatchdogEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = [WATCHDOG_DEADLINE_AT_ENV, WATCHDOG_DEADLINE_ENV].map(n => [n, process.env[n]] as const);
  for (const [n] of saved) delete process.env[n];
  try { return await fn(); } finally { for (const [n, v] of saved) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } }
}
const readAll = async (ledger: LedgerStore) => { const out: LedgerRecord[] = []; for await (const r of ledger.read({ from: "2020-01-01T00:00:00Z", to: "2090-01-01T00:00:00Z" })) out.push(r); return out; };

it("init creates a usable reviewed registry, identity and owner-only random secrets; refuses overwrite", async () => {
  const dir = await initialized(); const key = await readFile(join(dir, "hmac.key")); const cred = await readFile(join(dir, "credential"), "utf8");
  expect(key).toHaveLength(32); expect(cred.trim()).toHaveLength(64);
  for (const name of ["hmac.key", "credential"]) expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "ledger"))).isDirectory()).toBe(true);
  expect(await createIdentity("file", join(dir, "agents.yaml")).resolveAgent({ kind: "local", value: cred.trim() })).toBe("local-agent");
  expect((await loadRegistry(join(dir, "registry.yaml"))).servers["builtin:claude-code"]!.tools.Bash!.class).toBe("risky");
  expect(await run(["init", "--dir", dir]).result).toBe(1); expect(await readFile(join(dir, "hmac.key"))).toEqual(key);
  const other = await initialized(); expect(await readFile(join(other, "hmac.key"))).not.toEqual(key);
});
it("prints only a Claude settings snippet with quoted absolute paths and all five events; only PreToolUse runs under the watchdog", async () => {
  const dir = join(await sandbox(), "space ' dollar$ back`tick");
  const r = run(["install-hooks", "--print", "--dir", dir]); expect(await r.result).toBe(0);
  const hooks = JSON.parse(r.output()).hooks;
  expect(Object.keys(hooks)).toEqual(["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "PermissionDenied"]);
  const pre = hooks.PreToolUse[0].hooks[0];
  expect(pre.timeout).toBe(HOOK_TIMEOUT_S); expect(pre.command).toContain(`--deadline-ms ${DEFAULT_DEADLINE_MS}`);
  expect(pre.command).toContain("watchdog-main.js"); expect(pre.command).toContain(process.execPath);
  const direct: [string, string][] = [["PostToolUse", "post"], ["PostToolUseFailure", "post"], ["SessionStart", "session-start"], ["PermissionDenied", "denied"]];
  for (const [name, flag] of direct) {
    expect(hooks[name]).toHaveLength(1); expect(hooks[name][0].matcher).toBe(""); expect(hooks[name][0].hooks).toHaveLength(1);
    const h = hooks[name][0].hooks[0];
    expect(h.type).toBe("command"); expect(h.timeout).toBe(HOOK_TIMEOUT_S);
    expect(h.command).not.toContain("watchdog-main"); expect(h.command).toContain(`--event ${flag} `); expect(h.command).toContain("--agent claude-code");
  }
  expect(r.error()).toBe(""); await expect(stat(dir)).rejects.toThrow();
});
it.each([[], ["wat"], ["install-hooks"], ["init", "--wat"], ["init", "--dir"], ["init", "--dir", "a", "--dir", "b"], ["report", "--from", "bad", "--to", "bad", "--out", "out"],
  ["anchor", "--print"], ["hook", "--agent", "claude-code", "--event", "heartbeat"], ["hook", "--agent", "codex", "--event", "denied"]])("rejects invalid arguments %j", async (...values) => {
  const args = values.flat() as string[]; const stdin = vi.fn(async () => "raw");
  expect(await run(args, { stdin }).result).toBe(2); expect(stdin).not.toHaveBeenCalled();
});

const incoming: IncomingCall = { callId: "t1", credential: { kind: "local", value: "fake" }, server: "builtin:claude-code", tool: "Bash", args: {}, receivedAt: "2026-09-30T12:00:00.000Z" };
const probe: HeartbeatProbe = { interpreter: "/opt/node/bin/node", nodeOptionsSet: true, watchdogCheck: "ok" };
const heartbeat: SessionHeartbeat = { agentSessionId: "s1", hookAgent: "claude-code", source: "startup", interpreter: probe.interpreter, nodeOptionsSet: true, watchdogCheck: "ok" };
function hookFakes() {
  const event = { session_id: "s1", transcript_path: "t", cwd: "/tmp", hook_event_name: "PreToolUse" as const, tool_name: "Bash", tool_input: {}, tool_use_id: "t1" };
  const sessionStart = { session_id: "s1", transcript_path: "t", cwd: "/tmp", hook_event_name: "SessionStart" as const, source: "startup" };
  const denied = { ...event, hook_event_name: "PermissionDenied" as const, reason: "Destructive command" };
  const decide = vi.fn(async () => ({ callId: "t1", decision: "ask" as const, kind: "decided" as const, reason: "risky" }));
  const recordOutcome = vi.fn(async () => {});
  const recordHeartbeat = vi.fn(async () => {});
  const createPipeline = vi.fn((_deps: PipelineDeps) => ({ decide, recordOutcome, recordHeartbeat, handle: vi.fn() }));
  const hooks = {
    parseHookInput: vi.fn(() => event) as unknown as CliDeps["hooks"]["parseHookInput"], toIncomingCall: vi.fn<CliDeps["hooks"]["toIncomingCall"]>(() => incoming),
    toHeartbeat: vi.fn<CliDeps["hooks"]["toHeartbeat"]>(() => heartbeat), toOutcome: vi.fn<CliDeps["hooks"]["toOutcome"]>(() => ({ status: "ok" as const })),
    formatPreToolUseOutput: vi.fn(() => '{"decision":"ask"}'),
  };
  const heartbeatProbe = vi.fn<CliDeps["heartbeatProbe"]>(async () => probe);
  const parsing = (ev: unknown) => ({ ...hooks, parseHookInput: (() => ev) as CliDeps["hooks"]["parseHookInput"] });
  return { createPipeline, hooks, heartbeatProbe, decide, recordOutcome, recordHeartbeat, event, sessionStart, denied, parsing };
}
describe("hook wiring", () => {
  it.each(["claude-code", "codex"])("passes %s, credential, key and hook-ask to decide-only pipeline", async agent => {
    const dir = await initialized(); const f = hookFakes();
    const r = run(["hook", "--agent", agent, "--event", "pre", "--dir", dir], { ...f, stdin: async () => "raw" });
    expect(await r.result).toBe(0); expect(r.output()).toBe('{"decision":"ask"}\n');
    expect(f.hooks.parseHookInput).toHaveBeenCalledWith("raw", agent);
    expect(f.hooks.toIncomingCall.mock.calls[0]![1]).toEqual({ kind: "local", value: (await readFile(join(dir, "credential"), "utf8")).trim() });
    const deps = f.createPipeline.mock.calls[0]![0];
    expect(deps).toHaveProperty("argsHmacKey", await readFile(join(dir, "hmac.key"))); expect(deps.hookAgent).toBe(agent); expect(deps.approvals).toEqual({ kind: "hook-ask" });
    await expect(deps.upstream.execute({ ...incoming, sessionId: "s", agentId: "a" })).rejects.toThrow();
    expect(f.decide).toHaveBeenCalledWith(incoming);
    expect(f.heartbeatProbe).not.toHaveBeenCalled();
  });
  it.each(["PostToolUse", "PostToolUseFailure"])("records %s without emitting stdout", async name => {
    const dir = await initialized(); const f = hookFakes();
    const hooks = f.parsing({ ...f.event, hook_event_name: name, tool_response: {}, error: "failed" });
    const r = run(["hook", "--agent", "claude-code", "--event", "post", "--dir", dir], { ...f, hooks, stdin: async () => "raw" });
    expect(await r.result).toBe(0); expect(r.output()).toBe(""); expect(f.recordOutcome).toHaveBeenCalledWith("t1", { status: "ok" });
  });
  it.each(["claude-code", "codex"])("session-start under %s: probe → toHeartbeat → recordHeartbeat with the credential, and NOTHING on stdout", async agent => {
    const dir = await initialized(); const f = hookFakes();
    const r = run(["hook", "--agent", agent, "--event", "session-start", "--dir", dir], { ...f, hooks: f.parsing(f.sessionStart), stdin: async () => "raw" });
    expect(await r.result).toBe(0); expect(r.output()).toBe(""); expect(r.error()).toBe("");
    expect(f.heartbeatProbe).toHaveBeenCalledWith(agent);
    expect(f.hooks.toHeartbeat).toHaveBeenCalledWith(f.sessionStart, agent, probe);
    const credential = (await readFile(join(dir, "credential"), "utf8")).trim();
    expect(f.recordHeartbeat).toHaveBeenCalledWith(heartbeat, { kind: "local", value: credential });
    expect(f.decide).not.toHaveBeenCalled(); expect(f.recordOutcome).not.toHaveBeenCalled();
    expect(f.createPipeline.mock.calls[0]![0].hookAgent).toBe(agent);
  });
  it("denied: PermissionDenied → toOutcome → recordOutcome(tool_use_id), silent, no probe", async () => {
    const dir = await initialized(); const f = hookFakes();
    f.hooks.toOutcome.mockReturnValue({ status: "blocked", errorClass: PERMISSION_DENIED_ERROR_CLASS });
    const r = run(["hook", "--agent", "claude-code", "--event", "denied", "--dir", dir], { ...f, hooks: f.parsing(f.denied), stdin: async () => "raw" });
    expect(await r.result).toBe(0); expect(r.output()).toBe(""); expect(r.error()).toBe("");
    expect(f.hooks.toOutcome).toHaveBeenCalledWith(f.denied, "claude-code");
    expect(f.recordOutcome).toHaveBeenCalledWith("t1", { status: "blocked", errorClass: PERMISSION_DENIED_ERROR_CLASS });
    expect(f.heartbeatProbe).not.toHaveBeenCalled(); expect(f.recordHeartbeat).not.toHaveBeenCalled();
  });
  it.each(["pre", "post", "session-start", "denied"])("contains errors safely for %s (record-only handlers exit 0, pre exits 1; the exception text never reaches stderr)", async event => {
    const dir = await initialized(); const f = hookFakes();
    f.createPipeline.mockImplementation(() => { throw new Error("secret-canary"); });
    const ev = event === "session-start" ? f.sessionStart : event === "denied" ? f.denied : event === "post" ? { ...f.event, hook_event_name: "PostToolUse", tool_response: {} } : f.event;
    const r = run(["hook", "--agent", "claude-code", "--event", event, "--dir", dir], { ...f, hooks: f.parsing(ev), stdin: async () => "raw" });
    expect(await r.result).toBe(event === "pre" ? 1 : 0); expect(r.output()).toBe(""); expect(r.error()).not.toContain("secret-canary"); expect(r.error()).not.toBe("");
    if (event === "session-start") expect(r.error()).toContain("heartbeat"); if (event === "denied") expect(r.error()).toContain("denial");
  });
  it.each(["probe", "recordHeartbeat", "toHeartbeat"])("session-start exits 0 with an empty stdout when the %s fails", async which => {
    const dir = await initialized(); const f = hookFakes();
    if (which === "probe") f.heartbeatProbe.mockRejectedValue(new Error("secret-canary"));
    if (which === "recordHeartbeat") f.recordHeartbeat.mockRejectedValue(new Error("secret-canary"));
    if (which === "toHeartbeat") f.hooks.toHeartbeat.mockImplementation(() => { throw new Error("secret-canary"); });
    const r = run(["hook", "--agent", "claude-code", "--event", "session-start", "--dir", dir], { ...f, hooks: f.parsing(f.sessionStart), stdin: async () => "raw" });
    expect(await r.result).toBe(0); expect(r.output()).toBe(""); expect(r.error()).toContain("heartbeat"); expect(r.error()).not.toContain("secret-canary");
  });
  it("rejects short or exposed keys before deciding, and before the session-start probe spawns anything", async () => {
    const dir = await initialized(); const f = hookFakes();
    for (const mode of ["short", "exposed"]) {
      await writeFile(join(dir, "hmac.key"), Buffer.alloc(mode === "short" ? 31 : 32));
      await chmod(join(dir, "hmac.key"), mode === "exposed" ? 0o644 : 0o600);
      expect(await run(["hook", "--agent", "claude-code", "--event", "pre", "--dir", dir], { ...f, stdin: async () => "raw" }).result).toBe(1);
      const hb = run(["hook", "--agent", "claude-code", "--event", "session-start", "--dir", dir], { ...f, hooks: f.parsing(f.sessionStart), stdin: async () => "raw" });
      expect(await hb.result).toBe(0); expect(hb.output()).toBe("");
    }
    expect(f.decide).not.toHaveBeenCalled(); expect(f.heartbeatProbe).not.toHaveBeenCalled(); expect(f.createPipeline).not.toHaveBeenCalled();
  });
  it.each(["pre", "post", "session-start", "denied"])("rejects a mismatched event for --event %s before pipeline construction", async event => {
    const dir = await initialized(); const f = hookFakes();
    // Every handler is fed the wrong kind of event: pre gets a post, the others get a pre.
    const hooks = f.parsing(event === "pre" ? { ...f.event, hook_event_name: "PostToolUse", tool_response: {} } : f.event);
    const r = run(["hook", "--agent", "claude-code", "--event", event, "--dir", dir], { ...f, hooks, stdin: async () => "raw" });
    expect(await r.result).toBe(event === "pre" ? 1 : 0);
    expect(r.output()).toBe(""); expect(r.error()).not.toBe("");
    expect(f.createPipeline).not.toHaveBeenCalled(); expect(f.recordOutcome).not.toHaveBeenCalled(); expect(f.recordHeartbeat).not.toHaveBeenCalled(); expect(f.heartbeatProbe).not.toHaveBeenCalled();
  });
});

describe("ADR-011: no watchdog-deadline shim", () => {
  it.each(["post", "session-start", "denied"])("constructs the pipeline for %s with both watchdog clock variables absent and never sets them", async event => {
    const dir = await initialized(); const f = hookFakes();
    const ev = event === "session-start" ? f.sessionStart : event === "denied" ? f.denied : { ...f.event, hook_event_name: "PostToolUse", tool_response: {} };
    const seen: (string | undefined)[] = [];
    f.createPipeline.mockImplementation(() => { seen.push(process.env[WATCHDOG_DEADLINE_AT_ENV], process.env[WATCHDOG_DEADLINE_ENV]); return { decide: f.decide, recordOutcome: f.recordOutcome, recordHeartbeat: f.recordHeartbeat, handle: vi.fn() }; });
    const code = await withoutWatchdogEnv(() => run(["hook", "--agent", "claude-code", "--event", event, "--dir", dir], { ...f, hooks: f.parsing(ev), stdin: async () => "raw" }).result);
    expect(code).toBe(0); expect(f.createPipeline).toHaveBeenCalledOnce(); expect(seen).toEqual([undefined, undefined]);
  });
  it("real modules, no deadline in the environment: session-start writes the pin 7 heartbeat; pre outside the watchdog denies and appends nothing; so denied records an ORPHAN blocked outcome through the real jsonl ledger (the chained case is test/cli-process.test.ts and e2e step 3)", async () => {
    const dir = await initialized();
    const sessionStart = JSON.stringify({ session_id: "sess-real-1", transcript_path: "/t/x.jsonl", cwd: "/tmp", hook_event_name: "SessionStart", source: "startup", permission_mode: "default" });
    const pre = JSON.stringify({ session_id: "sess-real-1", transcript_path: "/t/x.jsonl", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/a" }, tool_use_id: "toolu_real_1" });
    const denied = JSON.stringify({ session_id: "sess-real-1", transcript_path: "/t/x.jsonl", cwd: "/tmp", hook_event_name: "PermissionDenied", tool_name: "Read", tool_input: { file_path: "/tmp/a" }, tool_use_id: "toolu_real_1", reason: "Destructive command" });
    const heartbeatProbe = vi.fn<CliDeps["heartbeatProbe"]>(async () => probe);
    await withoutWatchdogEnv(async () => {
      const hb = run(["hook", "--agent", "claude-code", "--event", "session-start", "--dir", dir], { stdin: async () => sessionStart, heartbeatProbe });
      expect(await hb.result).toBe(0); expect(hb.output()).toBe(""); expect(hb.error()).toBe("");
      // ADR-011 fail closed: `pre` outside the watchdog can only answer deny (its line is on stdout; under the watchdog that is exit 2).
      const p = run(["hook", "--agent", "claude-code", "--event", "pre", "--dir", dir], { stdin: async () => pre });
      expect(await p.result).toBe(0);
      const line = JSON.parse(p.output()) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
      expect(line.hookSpecificOutput.permissionDecision).toBe("deny"); expect(line.hookSpecificOutput.permissionDecisionReason).toContain(WATCHDOG_DEADLINE_DENY_REASON);
      const d = run(["hook", "--agent", "claude-code", "--event", "denied", "--dir", dir], { stdin: async () => denied });
      expect(await d.result).toBe(0); expect(d.output()).toBe(""); expect(d.error()).toBe("");
    });
    const ledger = createLedger("jsonl", join(dir, "ledger", "records.jsonl"));
    const records = await readAll(ledger);
    expect(records.map(r => [r.phase, r.call.tool])).toEqual([["intent", HEARTBEAT_TOOL], ["outcome", "unknown"]]); // the deny appended nothing; the denial is an orphan here (no intent)
    const heartbeatRecord = records[0]!;
    expect(heartbeatRecord.policy.ruleId).toBe(HEARTBEAT_RULE_ID); expect(heartbeatRecord.call.agentSessionId).toBe("sess-real-1"); expect(heartbeatRecord.call.agentId).toBe("local-agent");
    expect(heartbeatRecord.call.args).toEqual({ agentSessionId: "sess-real-1", hookAgent: "claude-code", source: "startup", permissionMode: "default", ...probe });
    expect(records[1]!.outcome).toEqual({ status: "blocked", errorClass: PERMISSION_DENIED_ERROR_CLASS }); expect(records[1]!.call.callId).toBe("toolu_real_1");
    expect(await ledger.verify()).toEqual({ ok: true, checked: 2 });
    expect(JSON.stringify(records)).not.toContain((await readFile(join(dir, "credential"), "utf8")).trim());
  });
});

describe("verify", () => {
  it.each(["missing", "head", "ancestor", "mismatch", "broken"])("reports %s anchor/chain status", async scenario => {
    const dir = await initialized();
    const ledger: LedgerStore = { append: vi.fn(), verify: vi.fn(async () => ({ ok: scenario !== "broken", checked: 2 })), head: async () => "b".repeat(64), async *read() { yield { hash: "a".repeat(64) } as never; } };
    const latest = scenario === "missing" ? null : { hash: (scenario === "head" ? "b" : scenario === "ancestor" ? "a" : "c").repeat(64), at: "2026-09-30T12:00:00.000Z" };
    const r = run(["verify", "--dir", dir], { createLedger: () => ledger, createAnchor: () => ({ latest: async () => latest, write: vi.fn() }) });
    expect(await r.result).toBe(["mismatch", "broken"].includes(scenario) ? 1 : scenario === "missing" ? 3 : 0);
    expect(JSON.parse(r.output()).anchor.status).toBe(scenario === "broken" ? "untrusted" : scenario);
    expect(ledger.verify).toHaveBeenCalled();
  });
});

describe("anchor", () => {
  const HEAD = "b".repeat(64);
  const fakes = (o: { heads?: string[]; ok?: boolean; latest?: { hash: string; at: string } | null; torn?: boolean } = {}) => {
    const heads = [...(o.heads ?? [HEAD])];
    const ledger: LedgerStore = { append: vi.fn(), verify: vi.fn(async () => ({ ok: o.ok ?? true, checked: 3 })), head: vi.fn(async () => heads.length > 1 ? heads.shift()! : heads[0]!), async *read() { if (o.latest) yield { hash: o.latest.hash } as never; } };
    const write = vi.fn(async () => {});
    const latest = vi.fn(async () => { if (o.torn) throw new Error("anchor: torn tail secret-canary"); return o.latest ?? null; });
    return { ledger, write, latest, createLedger: () => ledger, createAnchor: vi.fn((_k: "file" | "s3", _t: string) => ({ latest, write })) };
  };
  it("healthy: writes { hash: head, at } and prints one JSON line with the canonical line, the previous entry, the chain, the path and the honesty note", async () => {
    const dir = await initialized(); const previous = { hash: "a".repeat(64), at: "2026-09-30T12:00:00.000Z" };
    const f = fakes({ latest: previous });
    const r = run(["anchor", "--dir", dir], f);
    expect(await r.result).toBe(0); expect(r.error()).toBe("");
    const lines = r.output().split("\n").filter(Boolean); expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]!);
    expect(f.write).toHaveBeenCalledOnce();
    const entry = (f.write.mock.calls[0] as unknown as [{ hash: string; at: string }])[0];
    expect(entry.hash).toBe(HEAD); expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(out).toEqual({ anchored: true, entry, line: canonicalize(entry), previous, chain: { ok: true, checked: 3 }, path: join(dir, "anchors.jsonl"), note: ANCHOR_NOTE });
    expect(f.createAnchor).toHaveBeenCalledWith("file", join(dir, "anchors.jsonl"));
    expect(f.ledger.append).not.toHaveBeenCalled();
  });
  const refusals: [string, { heads?: string[]; ok?: boolean }][] = [
    ["empty-ledger", { heads: ["0"] }], ["chain-failed", { ok: false }], ["ledger-changed", { heads: [HEAD, "c".repeat(64)] }],
  ];
  it.each(refusals)("refuses with exit 1 and reason %s without writing a line", async (reason, o) => {
    const dir = await initialized(); const f = fakes(o);
    const r = run(["anchor", "--dir", dir], f);
    expect(await r.result).toBe(1); expect(r.error()).toBe("");
    expect(JSON.parse(r.output())).toEqual({ anchored: false, reason, chain: { ok: o.ok ?? true, checked: 3 } });
    expect(f.write).not.toHaveBeenCalled(); expect(f.latest).not.toHaveBeenCalled();
  });
  it("a damaged ledger tail (head throws) is chain-failed, and a torn anchor file is exit 1 with nothing written and no exception text", async () => {
    const dir = await initialized();
    const damaged = fakes({ ok: false }); (damaged.ledger.head as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("bad tail"));
    const a = run(["anchor", "--dir", dir], damaged); expect(await a.result).toBe(1); expect(JSON.parse(a.output()).reason).toBe("chain-failed");
    const torn = fakes({ torn: true });
    const b = run(["anchor", "--dir", dir], torn);
    expect(await b.result).toBe(1); expect(b.output()).toBe(""); expect(b.error()).not.toBe(""); expect(b.error()).not.toContain("secret-canary"); expect(torn.write).not.toHaveBeenCalled();
  });
  it("end to end in process: anchors the real ledger head so verify answers head/exit 0, and an empty ledger is refused", async () => {
    const dir = await initialized(); const ledgerPath = join(dir, "ledger", "records.jsonl");
    const empty = run(["anchor", "--dir", dir]); expect(await empty.result).toBe(1); expect(JSON.parse(empty.output()).reason).toBe("empty-ledger");
    await expect(stat(join(dir, "anchors.jsonl"))).rejects.toThrow();
    const ledger = createLedger("jsonl", ledgerPath);
    const first = await ledger.append({ id: "r1", phase: "intent", call: { callId: "c1", sessionId: "s", agentId: "a", server: "builtin:claude-code", tool: "Read", args: {}, receivedAt: "2026-10-01T00:00:00.000Z" }, policy: { verdict: "allow", risk: "read", ruleId: "r", reason: "x" } });
    const bytes = await readFile(ledgerPath);
    const anchored = run(["anchor", "--dir", dir]); expect(await anchored.result).toBe(0);
    const out = JSON.parse(anchored.output()); expect(out.entry.hash).toBe(first.hash); expect(out.previous).toBeNull();
    expect(await readFile(join(dir, "anchors.jsonl"), "utf8")).toBe(out.line + "\n");
    expect(await readFile(ledgerPath)).toEqual(bytes); // the ledger is never changed by anchoring
    const verify = run(["verify", "--dir", dir]); expect(await verify.result).toBe(0); expect(JSON.parse(verify.output()).anchor).toEqual({ status: "head", latest: out.entry });
    const again = run(["anchor", "--dir", dir]); expect(await again.result).toBe(0); expect(JSON.parse(again.output()).previous).toEqual(out.entry); // a time series, on purpose
  });
});

it("passes the selected range, output directory and the anchor context (as verify computes it) to the report contract", async () => {
  const dir = await initialized(); const out = join(await sandbox(), "pack");
  const generateReport = vi.fn<CliDeps["generateReport"]>(async ledger => { await ledger.verify(); return { pdfPath: join(out, "report.pdf"), csvPath: join(out, "records.csv") }; });
  const r = run(["report", "--from", "2026-09-30T00:00:00Z", "--to", "2026-09-30T23:59:59Z", "--out", out, "--dir", dir], { generateReport });
  expect(await r.result).toBe(0);
  expect(generateReport.mock.calls[0]!.slice(1)).toEqual([{ from: "2026-09-30T00:00:00Z", to: "2026-09-30T23:59:59Z" }, out, { anchor: { status: "missing", latest: null } }]);
  expect(JSON.parse(r.output()).htmlPath).toBe(join(out, "report.html")); expect(JSON.parse(r.output()).anchor).toEqual({ status: "missing", latest: null });
});
it.each(["head", "ancestor", "mismatch", "untrusted"])("report context carries anchor status %s", async scenario => {
  const dir = await initialized();
  const ledger: LedgerStore = { append: vi.fn(), verify: vi.fn(async () => ({ ok: scenario !== "untrusted", checked: 2 })), head: async () => "b".repeat(64), async *read() { yield { hash: "a".repeat(64) } as never; } };
  const latest = { hash: (scenario === "head" ? "b" : scenario === "ancestor" ? "a" : "c").repeat(64), at: "2026-09-30T12:00:00.000Z" };
  const generateReport = vi.fn<CliDeps["generateReport"]>(async store => { await store.verify(); return { pdfPath: "pack/report.pdf", csvPath: "pack/records.csv" }; });
  const r = run(["report", "--dir", dir, "--from", "2026-09-30T00:00:00Z", "--to", "2026-10-01T00:00:00Z", "--out", "pack"], { createLedger: () => ledger, createAnchor: () => ({ latest: async () => latest, write: vi.fn() }), generateReport });
  expect(await r.result).toBe(["untrusted", "mismatch"].includes(scenario) ? 1 : 0);
  expect(generateReport.mock.calls[0]![3]).toEqual({ anchor: { status: scenario, latest } });
  expect(JSON.parse(r.output()).anchor.status).toBe(scenario);
});
it("reports a broken chain even when its tail cannot be read", async () => {
  const dir = await initialized();
  const ledger: LedgerStore = { append: vi.fn(), verify: vi.fn(async () => ({ ok: false, checked: 0, brokenAt: "line:1" })), head: async () => { throw new Error("bad tail"); }, async *read() {} };
  const r = run(["verify", "--dir", dir], { createLedger: () => ledger, createAnchor: () => ({ latest: async () => null, write: vi.fn() }) });
  expect(await r.result).toBe(1); expect(ledger.verify).toHaveBeenCalledOnce(); expect(JSON.parse(r.output()).chain.brokenAt).toBe("line:1");
});
it.each(["0", "a".repeat(64)])("treats a genesis anchor as missing with head %s", async head => {
  const dir = await initialized();
  const ledger: LedgerStore = { append: vi.fn(), verify: async () => ({ ok: true, checked: head === "0" ? 0 : 1 }), head: async () => head, async *read() {} };
  const r = run(["verify", "--dir", dir], { createLedger: () => ledger, createAnchor: () => ({ latest: async () => ({ hash: "0", at: "2026-09-30T12:00:00Z" }), write: vi.fn() }) });
  expect(await r.result).toBe(3); expect(JSON.parse(r.output()).anchor.status).toBe("missing");
});
it.each(["2026-09-30T24:00:00Z", "2026-02-30T00:00:00Z"])("returns usage for invalid calendar timestamp %s before ledger access", async from => {
  const createLedger = vi.fn<CliDeps["createLedger"]>();
  const r = run(["report", "--from", from, "--to", "2026-10-01T00:00:00Z", "--out", "unused"], { createLedger });
  expect(await r.result).toBe(2); expect(r.error()).toContain("Usage:"); expect(createLedger).not.toHaveBeenCalled();
});
it.each([true, false])("reports the export's actual chain result (ok=%s); the CLI's own pass only feeds the anchor status", async ok => {
  const dir = await initialized(); const chain = { ok, checked: 7, ...(ok ? {} : { brokenAt: "rec-2" }) };
  const verify = vi.fn(async () => chain);
  const ledger: LedgerStore = { append: vi.fn(), head: async () => "0", verify, async *read() {} };
  const generateReport = vi.fn<CliDeps["generateReport"]>(async store => {
    await store.verify(); return { pdfPath: "pack/report.pdf", csvPath: "pack/records.csv" };
  });
  const r = run(["report", "--dir", dir, "--from", "2026-09-30T00:00:00Z", "--to", "2026-10-01T00:00:00Z", "--out", "pack"], { createLedger: () => ledger, generateReport });
  expect(await r.result).toBe(ok ? 0 : 1); expect(JSON.parse(r.output()).chain).toEqual(chain);
  expect(verify).toHaveBeenCalledTimes(2); // pin 5/6: one pass for the anchor status handed to the report, one by the report itself (stdout carries the report's)
  expect(JSON.parse(r.output()).anchor.status).toBe(ok ? "missing" : "untrusted");
});
it("places pinned yaml in runtime dependencies and the production lock graph", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  expect(pkg.dependencies.yaml).toBe("2.9.1"); expect(pkg.devDependencies.yaml).toBeUndefined();
  expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
  expect(lock.packages[""].devDependencies).toEqual(pkg.devDependencies);
  expect(lock.packages["node_modules/yaml"].dev).toBeUndefined();
  expect(lock.packages["node_modules/yaml"].version).toBe("2.9.1");
});

describe("--ledger <postgres url> (Slice 2a pin 7; createLedger injected through CliDeps)", () => {
  const URL_PG = "postgres://ledger_reader@127.0.0.1:15432/ledger";
  const HEAD = "c".repeat(64);
  const fakes = () => {
    const ledger: LedgerStore = { append: vi.fn(), verify: vi.fn(async () => ({ ok: true, checked: 3 })), head: vi.fn(async () => HEAD), async *read() {} };
    const createLedger = vi.fn<CliDeps["createLedger"]>(() => ledger);
    const write = vi.fn(async () => {});
    const createAnchor = vi.fn((_k: "file" | "s3", _t: string) => ({ latest: async () => ({ hash: HEAD, at: "2026-10-03T12:00:00.000Z" }), write }));
    return { ledger, createLedger, createAnchor, write };
  };
  it.each(["postgres://u@h:5432/db", "postgresql://u@h/db"])("verify --ledger %s uses createLedger('postgres', url) with no <dir>/ledger directory; --dir still holds anchors.jsonl", async url => {
    const dir = join(await sandbox(), "lab-not-initialized");
    const f = fakes();
    const r = run(["verify", "--dir", dir, "--ledger", url], { createLedger: f.createLedger, createAnchor: f.createAnchor });
    expect(await r.result).toBe(0);
    expect(f.createLedger).toHaveBeenCalledWith("postgres", url);
    expect(f.createAnchor).toHaveBeenCalledWith("file", join(dir, "anchors.jsonl"));
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(JSON.parse(r.output())).toMatchObject({ head: HEAD, anchor: { status: "head" } });
    expect(r.output()).not.toContain(url); expect(r.error()).toBe("");
  });
  it("anchor --ledger writes the Mac-side anchor from the Postgres head and never prints the URL", async () => {
    const dir = join(await sandbox(), "lab");
    const f = fakes();
    const r = run(["anchor", "--dir", dir, "--ledger", URL_PG], { createLedger: f.createLedger, createAnchor: f.createAnchor });
    expect(await r.result).toBe(0);
    expect(f.write).toHaveBeenCalledWith({ hash: HEAD, at: expect.any(String) });
    expect(JSON.parse(r.output())).toMatchObject({ anchored: true, entry: { hash: HEAD }, path: join(dir, "anchors.jsonl") });
    expect(r.output()).not.toContain("postgres://"); expect(r.output()).not.toContain("15432");
  });
  it("report --ledger renders from the Postgres ledger and still prints chain + anchor", async () => {
    const dir = join(await sandbox(), "lab");
    const f = fakes();
    const generateReport = vi.fn<CliDeps["generateReport"]>(async store => { await store.verify(); return { pdfPath: "pack/report.pdf", csvPath: "pack/records.csv" }; });
    const r = run(["report", "--dir", dir, "--ledger", URL_PG, "--from", "2026-10-01T00:00:00Z", "--to", "2026-10-02T00:00:00Z", "--out", join(dir, "pack")], { createLedger: f.createLedger, createAnchor: f.createAnchor, generateReport });
    expect(await r.result).toBe(0);
    expect(f.createLedger).toHaveBeenCalledWith("postgres", URL_PG);
    expect(JSON.parse(r.output())).toMatchObject({ chain: { ok: true, checked: 3 }, anchor: { status: "head" } });
    expect(r.output()).not.toContain(URL_PG);
  });
  it.each([
    [["hook", "--agent", "claude-code", "--event", "pre", "--ledger", URL_PG]],
    [["init", "--ledger", URL_PG]],
    [["install-hooks", "--print", "--ledger", URL_PG]],
  ])("%j refuses --ledger with usage, exit 2, before any ledger is created", async args => {
    const createLedger = vi.fn<CliDeps["createLedger"]>();
    const r = run(args, { createLedger, stdin: async () => "{}" });
    expect(await r.result).toBe(2); expect(r.error()).toContain("Usage:"); expect(createLedger).not.toHaveBeenCalled();
  });
  it.each(["mysql://u@h/db", "file:///tmp/ledger.jsonl", "ledger", "", "postgres"])("--ledger %j (not postgres:// or postgresql://) is a usage error, exit 2", async url => {
    const createLedger = vi.fn<CliDeps["createLedger"]>();
    const r = run(["verify", "--dir", join(await sandbox(), "lab"), "--ledger", url], { createLedger });
    expect(await r.result).toBe(2); expect(r.error()).toContain("Usage:"); expect(createLedger).not.toHaveBeenCalled();
    expect(r.error()).not.toContain("mysql");
  });
  it("a duplicated --ledger is a usage error; without --ledger the jsonl path and the Initialize-first check are unchanged", async () => {
    const createLedger = vi.fn<CliDeps["createLedger"]>();
    const dup = run(["verify", "--ledger", URL_PG, "--ledger", URL_PG], { createLedger });
    expect(await dup.result).toBe(2); expect(createLedger).not.toHaveBeenCalled();
    const plain = run(["verify", "--dir", join(await sandbox(), "nope")], { createLedger });
    expect(await plain.result).toBe(1); expect(createLedger).not.toHaveBeenCalled();
    expect(plain.error()).toContain("command failed");
  });
  it("the usage line documents --ledger on anchor, verify and report only", async () => {
    const r = run(["bogus"]);
    expect(await r.result).toBe(2);
    const u = r.error();
    expect(u).toMatch(/anchor \[--dir d\] \[--ledger postgres:\/\/user@host:port\/db\]/); expect(u).toMatch(/verify \[--dir d\] \[--ledger url\]/); expect(u).toMatch(/report .*\[--ledger url\]/);
    const segments = u.replace(/^Usage: agent-ledger /, "").trim().split(" | ");
    expect(segments.filter(s => s.includes("--ledger")).map(s => s.split(" ")[0])).toEqual(["anchor", "verify", "report"]);
  });
});

it("C2/C3: truncation remains a mismatch after refused re-anchor and writes a failing diagnostic pack", async () => {
  const dir = await initialized(), path = join(dir, "ledger", "records.jsonl");
  const ledger = createLedger("jsonl", path);
  const { unsealed } = await import("./helpers/ledger-fixtures.js");
  await ledger.append(unsealed(1));
  const prefix = await readFile(path);
  await ledger.append(unsealed(2));
  expect(await run(["anchor", "--dir", dir]).result).toBe(0);
  const checkpoint = await readFile(join(dir, "anchors.jsonl"));
  await writeFile(path, prefix);
  expect(await run(["verify", "--dir", dir]).result).toBe(1);
  const attempt = run(["anchor", "--dir", dir]);
  expect(await attempt.result).toBe(1);
  expect(JSON.parse(attempt.output()).reason).toBe("anchor-mismatch");
  expect(await readFile(join(dir, "anchors.jsonl"))).toEqual(checkpoint);
  expect(await run(["verify", "--dir", dir]).result).toBe(1);
  const out = join(dir, "diagnostic");
  expect(await run(["report", "--dir", dir, "--from", "2020-01-01T00:00:00Z", "--to", "2090-01-01T00:00:00Z", "--out", out]).result).toBe(1);
  expect(await readFile(join(out, "report.html"), "utf8")).toContain("MISMATCH");
  expect((await stat(join(out, "report.pdf"))).size).toBeGreaterThan(0);
  expect((await stat(join(out, "records.csv"))).size).toBeGreaterThan(0);
});
