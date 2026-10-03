import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import canonicalize from "canonicalize";
import type { LedgerRecord } from "../src/types/index.js";
import { HEARTBEAT_REASON, HEARTBEAT_RULE_ID, HEARTBEAT_TOOL, PERMISSION_DENIED_ERROR_CLASS } from "../src/types/index.js";
import { DEFAULT_DEADLINE_MS, HOOK_TIMEOUT_S, WATCHDOG_DEADLINE_AT_ENV, WATCHDOG_DEADLINE_ENV } from "../src/hooks/contract.js";
import { ORPHAN_OUTCOME_RULE_PREFIX } from "../src/pipeline/contract.js";
import { ANCHOR_NOTE } from "../src/cli/main.js";
import { createRunner, pdfText, readJsonl, shellWords, type Run } from "./helpers/e2e-demo.js";

/**
 * Slice 1c end to end, Package A's half (docs/slices/slice-1c-pins.md "Integration seams" steps 1-7; the coordinator
 * adds the pack-content steps 8-10 at integration). REAL processes and the BUILT artifacts, no mocks, no Claude Code:
 * the printed hook commands run through /bin/sh with fixture events on stdin, exactly as Claude Code would run them.
 * Sequential on purpose: one sandbox, one ledger, so each step is checked against what the earlier ones really wrote.
 *
 * Same private build root as test/e2e-slice-1b.test.ts (tsconfig.build.json into a tmp --outDir, plus policies,
 * package.json and a node_modules symlink): test/cli-process.test.ts rebuilds the repo's dist/ in its own beforeAll and
 * vitest runs files in parallel, so hooks executing from dist/ would race that rebuild. The heartbeat's watchdog self-test
 * therefore also finds the REAL watchdog next to the CLI (step 1 expects `watchdogCheck: "ok"`).
 */

interface HookSnippet { hooks: Record<string, { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[]> }
type HookOutput = { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
interface AnchorOut { anchored: boolean; reason?: string; entry?: { hash: string; at: string }; line?: string; previous?: unknown; chain: { ok: boolean; checked: number }; path?: string; note?: string }
interface VerifyOut { chain: { ok: boolean; checked: number }; head: string; anchor: { status: string; latest: { hash: string; at: string } | null } }

const HOOK_TIMEOUT_MS = 60_000;
const SESSION_A = "e2e-sess-a-7f31";                     // heartbeated session
const SESSION_B = "e2e-sess-b-02cd";                     // a session that never heartbeated (B's "session without heartbeat")
const NODE_OPTIONS_CANARY = "e2e-nodeopt-canary";        // the VALUE of NODE_OPTIONS: only "set or not" is recorded
const BASH_CANARY = "e2e-bash-canary-4c1f7a";            // Bash command argument: storeArgs [] → hmac only
const NOTE_CANARY = "e2e-note-canary-b83d2e";            // a non-allowlisted Read field → hmac only
const REASON_CANARY = "e2e-reason-canary-9d2b41";        // PermissionDenied `reason`: display text, never stored
const CLEAR_PATH = "/tmp/e2e-sandbox/notes-1c.txt";      // Read.file_path, the one reviewed clear field
const BASH_A_ID = "toolu_e2e1c_bash_a"; const READ_A_ID = "toolu_e2e1c_read_a"; const READ_A2_ID = "toolu_e2e1c_read_a2"; const BASH_B_ID = "toolu_e2e1c_bash_b";
const REGISTRY = {
  version: 1,
  servers: {
    "builtin:claude-code": {
      trusted: true,
      tools: {
        Bash: { class: "risky", reviewedBy: "e2e-reviewer", reviewedAt: "2026-10-01", storeArgs: [] },
        Read: { class: "read", reviewedBy: "e2e-reviewer", reviewedAt: "2026-10-01", storeArgs: ["file_path"] },
      },
    },
  },
};

const fixture = (name: string) => JSON.parse(readFileSync(resolve(`test/fixtures/claude-code-${name}.json`), "utf8")) as Record<string, unknown>;
const transcript: string[] = [];
const run = createRunner(transcript);
const timings: Record<string, number> = {};

let root: string; let project: string; let ledgerDir: string; let cli: string;
let env: NodeJS.ProcessEnv;
let startedAt: number;
let keyHex = ""; let credentialHex = "";
let snippet: HookSnippet;
let preCommand = ""; let postCommand = ""; let sessionStartCommand = ""; let deniedCommand = "";
let ledgerPath = ""; let anchorsPath = "";
let anchorEntry: { hash: string; at: string } | undefined;
let pack: { htmlPath: string; pdfPath: string; csvPath: string } | undefined;

const records = () => readJsonl<LedgerRecord>(ledgerPath);
const byCall = (callId: string, phase: LedgerRecord["phase"]) => records().filter((r) => r.call.callId === callId && r.phase === phase);
const heartbeats = () => records().filter((r) => r.policy.ruleId === HEARTBEAT_RULE_ID);
const HMAC_RE = /^hmac-sha256:[0-9a-f]{64}$/;
const oneLine = (r: Run): HookOutput => {
  const lines = r.stdout.split("\n").filter((l) => l.length > 0);
  expect(lines, `stdout: ${JSON.stringify(r.stdout)}`).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!) as HookOutput;
  expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  return parsed;
};
const sh = (command: string, event: unknown, extraEnv: NodeJS.ProcessEnv = {}, timeoutMs = HOOK_TIMEOUT_MS) => run("/bin/sh", ["-c", command], { cwd: project, env: { ...env, ...extraEnv }, input: JSON.stringify(event), timeoutMs });
const agentLedger = (args: string[]) => run(process.execPath, [cli, ...args], { cwd: project, env });
const preEvent = (session: string, tool: string, id: string, input: Record<string, unknown>) => ({ ...fixture("pretooluse"), session_id: session, cwd: project, tool_name: tool, tool_use_id: id, tool_input: input });
const expectSilent = (r: Run, label: string) => { expect(r.signal, label).toBeNull(); expect(r.code, `${label}: ${r.stderr}`).toBe(0); expect(r.stdout, label).toBe(""); };
const assertChainLinks = (list: LedgerRecord[]) => {
  list.forEach((r, i) => {
    expect(r.prevHash).toBe(i === 0 ? "0" : list[i - 1]!.hash);
    expect(r.parentRecordId).toBe(i === 0 ? null : list[i - 1]!.id);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });
};
const verify = async (): Promise<{ code: number | null; out: VerifyOut }> => {
  const r = await agentLedger(["verify", "--dir", ledgerDir]);
  return { code: r.code, out: JSON.parse(r.stdout) as VerifyOut };
};

beforeAll(() => {
  startedAt = Date.now();
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-ledger-e2e1c-")));
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", join(root, "dist")], { stdio: "pipe" });
  cli = join(root, "dist/cli/main.js");
  chmodSync(cli, 0o755);
  cpSync(resolve("policies"), join(root, "policies"), { recursive: true });
  copyFileSync(resolve("package.json"), join(root, "package.json"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"));
  project = join(root, "project"); mkdirSync(project);
  ledgerDir = join(project, ".agent-ledger");
  ledgerPath = join(ledgerDir, "ledger", "records.jsonl");
  anchorsPath = join(ledgerDir, "anchors.jsonl");
  env = { ...process.env };
  delete env[WATCHDOG_DEADLINE_AT_ENV]; delete env[WATCHDOG_DEADLINE_ENV]; delete env["NODE_OPTIONS"];
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe.sequential("Slice 1c demo path (Package A half), real processes, built artifacts", () => {
  it("0. init; the sandbox registry; anchor refuses an empty ledger with exit 1 and writes no anchor file", async () => {
    const init = await agentLedger(["init", "--dir", ledgerDir]);
    expect(init.code, init.stderr).toBe(0);
    keyHex = readFileSync(join(ledgerDir, "hmac.key")).toString("hex");
    credentialHex = readFileSync(join(ledgerDir, "credential"), "utf8").trim();
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/); expect(credentialHex).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(ledgerDir, "registry.yaml"), JSON.stringify(REGISTRY, null, 2) + "\n", { mode: 0o600 });
    const empty = await agentLedger(["anchor", "--dir", ledgerDir]);
    expect(empty.code, empty.stderr).toBe(1); expect(empty.stderr).toBe("");
    expect(JSON.parse(empty.stdout)).toEqual({ anchored: false, reason: "empty-ledger", chain: { ok: true, checked: 0 } });
    expect(existsSync(anchorsPath)).toBe(false);
    const v = await verify(); expect(v.code).toBe(3); expect(v.out.anchor.status).toBe("missing");
  }, HOOK_TIMEOUT_MS);

  it("1. the printed snippet has 5 events (4 direct); the SessionStart command prints an EMPTY stdout, exits 0 and appends a heartbeat with watchdogCheck ok and nodeOptionsSet true, the NODE_OPTIONS value nowhere", async () => {
    const printed = await agentLedger(["install-hooks", "--print", "--dir", ledgerDir]);
    expect(printed.code, printed.stderr).toBe(0);
    snippet = JSON.parse(printed.stdout) as HookSnippet;
    expect(Object.keys(snippet.hooks)).toEqual(["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "PermissionDenied"]);
    for (const entries of Object.values(snippet.hooks)) {
      expect(entries).toHaveLength(1); expect(entries[0]!.matcher).toBe(""); expect(entries[0]!.hooks).toHaveLength(1);
      expect(entries[0]!.hooks[0]!.type).toBe("command"); expect(entries[0]!.hooks[0]!.timeout).toBe(HOOK_TIMEOUT_S);
    }
    const commandOf = (event: string) => snippet.hooks[event]![0]!.hooks[0]!.command;
    preCommand = commandOf("PreToolUse"); postCommand = commandOf("PostToolUse"); sessionStartCommand = commandOf("SessionStart"); deniedCommand = commandOf("PermissionDenied");
    expect(commandOf("PostToolUseFailure")).toBe(postCommand);
    // Drift check: the pre command is the real watchdog in front of the real CLI; the four record-only commands are the CLI directly.
    const pre = shellWords(preCommand); const sep = pre.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(pre[1]).toBe(join(root, "dist/hooks/watchdog-main.js")); expect(existsSync(pre[1]!)).toBe(true);
    expect(pre.slice(2, sep)).toEqual(["--agent", "claude-code", "--deadline-ms", String(DEFAULT_DEADLINE_MS), "--timeout-s", String(HOOK_TIMEOUT_S)]);
    expect(pre.slice(sep + 1)).toEqual([process.execPath, cli, "hook", "--agent", "claude-code", "--event", "pre", "--dir", ledgerDir]);
    for (const [command, flag] of [[postCommand, "post"], [sessionStartCommand, "session-start"], [deniedCommand, "denied"]] as const) {
      const words = shellWords(command);
      expect(words).toEqual([process.execPath, cli, "hook", "--agent", "claude-code", "--event", flag, "--dir", ledgerDir]);
      expect(command).not.toContain("watchdog-main");
    }
    for (const path of [pre[0]!, pre[1]!, cli]) expect(existsSync(path), path).toBe(true);

    const r = await sh(sessionStartCommand, { ...fixture("sessionstart"), session_id: SESSION_A, cwd: project, source: "startup" }, { NODE_OPTIONS: `--title=${NODE_OPTIONS_CANARY}` });
    timings["session-start"] = r.ms;
    expectSilent(r, "session-start"); expect(r.stderr).toBe("");
    const all = records(); expect(all).toHaveLength(1);
    const hb = all[0]!;
    expect(hb.phase).toBe("intent");
    expect(hb.call.callId).toMatch(/^heartbeat:[0-9a-f-]{36}$/);
    expect(hb.call.server).toBe("builtin:claude-code"); expect(hb.call.tool).toBe(HEARTBEAT_TOOL);
    expect(hb.call.agentId).toBe("local-agent"); expect(hb.call.agentSessionId).toBe(SESSION_A);
    expect(hb.policy).toEqual({ verdict: "allow", risk: "read", ruleId: HEARTBEAT_RULE_ID, reason: HEARTBEAT_REASON });
    expect(hb.outcome).toBeUndefined(); expect(hb.approval).toBeUndefined();
    expect(hb.call.args).toEqual({ agentSessionId: SESSION_A, hookAgent: "claude-code", source: "startup", interpreter: realpathSync(process.execPath), nodeOptionsSet: true, watchdogCheck: "ok" });
    const bytes = readFileSync(ledgerPath, "utf8");
    expect(bytes).not.toContain(NODE_OPTIONS_CANARY);
    for (const field of ["transcript_path", "model", "context_tokens", "estimated_cache_write_usd", "seconds_since_last_response"]) expect(bytes).not.toContain(field);
    expect(r.ms, "heartbeat incl. watchdog self-test").toBeLessThan(10_000);
  }, HOOK_TIMEOUT_MS);

  it("2. PreToolUse after the heartbeat records call.agentSessionId equal to the fixture session_id (a risky Bash → ask, a reviewed Read → allow, then a PostToolUse ok for the Read)", async () => {
    const bash = await sh(preCommand, preEvent(SESSION_A, "Bash", BASH_A_ID, { command: `printf '${BASH_CANARY}\\n'`, description: "approved sandbox demo" }));
    timings["pre-bash-ask"] = bash.ms;
    expect(bash.signal).toBeNull(); expect(bash.code, bash.stderr).toBe(0); expect(bash.stderr).toBe("");
    expect(oneLine(bash).hookSpecificOutput.permissionDecision).toBe("ask");
    const read = await sh(preCommand, preEvent(SESSION_A, "Read", READ_A_ID, { file_path: CLEAR_PATH, limit: 20, note: NOTE_CANARY }));
    timings["pre-read-allow"] = read.ms;
    expect(read.code, read.stderr).toBe(0); expect(oneLine(read).hookSpecificOutput.permissionDecision).toBe("allow");
    const post = await sh(postCommand, { ...fixture("posttooluse"), session_id: SESSION_A, cwd: project, tool_name: "Read", tool_use_id: READ_A_ID, tool_input: { file_path: CLEAR_PATH, limit: 20, note: NOTE_CANARY }, tool_response: "file contents" });
    expectSilent(post, "post"); expect(post.stderr).toBe("");

    const bashIntent = byCall(BASH_A_ID, "intent"); const readIntent = byCall(READ_A_ID, "intent"); const readOutcome = byCall(READ_A_ID, "outcome");
    expect(bashIntent).toHaveLength(1); expect(readIntent).toHaveLength(1); expect(readOutcome).toHaveLength(1);
    expect(bashIntent[0]!.call.agentSessionId).toBe(SESSION_A); expect(readIntent[0]!.call.agentSessionId).toBe(SESSION_A);
    expect(readOutcome[0]!.call).toEqual(readIntent[0]!.call); expect(readOutcome[0]!.outcome).toEqual({ status: "ok" });
    expect(bashIntent[0]!.policy).toMatchObject({ verdict: "require_approval", risk: "risky" });
    expect(bashIntent[0]!.approval).toMatchObject({ callId: BASH_A_ID, channel: "hook-ask", decision: "delegated" });
    for (const value of Object.values(bashIntent[0]!.call.args)) expect(value).toMatch(HMAC_RE);
    expect(readIntent[0]!.call.args["file_path"]).toBe(CLEAR_PATH); expect(readIntent[0]!.call.args["note"]).toMatch(HMAC_RE);
    expect(records()).toHaveLength(4);
  }, HOOK_TIMEOUT_MS * 2);

  it("3. a PreToolUse for a second session with no heartbeat, then its PermissionDenied → a blocked outcome with errorClass permission-denied:auto-mode chained to the intent (not an orphan)", async () => {
    const pre = await sh(preCommand, preEvent(SESSION_B, "Bash", BASH_B_ID, { command: `rm -rf /tmp/data-${BASH_CANARY}` }));
    timings["pre-bash-b-ask"] = pre.ms;
    expect(pre.code, pre.stderr).toBe(0); expect(oneLine(pre).hookSpecificOutput.permissionDecision).toBe("ask");
    const denied = await sh(deniedCommand, { ...fixture("permissiondenied"), session_id: SESSION_B, cwd: project, tool_name: "Bash", tool_input: { command: `rm -rf /tmp/data-${BASH_CANARY}` }, tool_use_id: BASH_B_ID, reason: `Destructive command ${REASON_CANARY}` });
    timings["denied"] = denied.ms;
    expectSilent(denied, "denied"); expect(denied.stderr).toBe("");

    const intent = byCall(BASH_B_ID, "intent"); const outcome = byCall(BASH_B_ID, "outcome");
    expect(intent).toHaveLength(1); expect(outcome).toHaveLength(1);
    expect(intent[0]!.call.agentSessionId).toBe(SESSION_B);
    expect(heartbeats().some((h) => h.call.agentSessionId === SESSION_B)).toBe(false);
    expect(outcome[0]!.outcome).toEqual({ status: "blocked", errorClass: PERMISSION_DENIED_ERROR_CLASS });
    expect(outcome[0]!.call).toEqual(intent[0]!.call); expect(outcome[0]!.policy).toEqual(intent[0]!.policy);
    expect(outcome[0]!.policy.ruleId.startsWith(ORPHAN_OUTCOME_RULE_PREFIX)).toBe(false);
    expect(outcome[0]!.call.agentSessionId).toBe(SESSION_B);
    const all = records(); expect(all).toHaveLength(6); assertChainLinks(all);
    expect(readFileSync(ledgerPath, "utf8")).not.toContain(REASON_CANARY);
  }, HOOK_TIMEOUT_MS * 2);

  it("4. anchor → exit 0 and one canonical line; verify → exit 0 head; one more hooked record → ancestor; a truncated tail → exit 1 mismatch", async () => {
    const before = records(); const head = before.at(-1)!.hash;
    const bytes = readFileSync(ledgerPath);
    const anchored = await agentLedger(["anchor", "--dir", ledgerDir]);
    timings["anchor"] = anchored.ms;
    expect(anchored.code, anchored.stderr).toBe(0); expect(anchored.stderr).toBe("");
    const lines = anchored.stdout.split("\n").filter(Boolean); expect(lines).toHaveLength(1);
    const out = JSON.parse(lines[0]!) as AnchorOut;
    expect(out.anchored).toBe(true); expect(out.entry!.hash).toBe(head); expect(out.previous).toBeNull();
    expect(out.chain).toEqual({ ok: true, checked: before.length }); expect(out.path).toBe(anchorsPath); expect(out.note).toBe(ANCHOR_NOTE);
    expect(out.line).toBe(canonicalize(out.entry));
    expect(readFileSync(anchorsPath, "utf8")).toBe(out.line + "\n");
    expect(readFileSync(ledgerPath).equals(bytes)).toBe(true); // anchor never changes the ledger
    anchorEntry = out.entry;

    const atHead = await verify();
    expect(atHead.code).toBe(0); expect(atHead.out.anchor).toEqual({ status: "head", latest: anchorEntry }); expect(atHead.out.head).toBe(head);

    const more = await sh(preCommand, preEvent(SESSION_A, "Read", READ_A2_ID, { file_path: CLEAR_PATH }));
    expect(more.code, more.stderr).toBe(0); expect(oneLine(more).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(records()).toHaveLength(before.length + 1);
    const ancestor = await verify();
    expect(ancestor.code).toBe(0); expect(ancestor.out.anchor.status).toBe("ancestor"); expect(ancestor.out.chain).toEqual({ ok: true, checked: before.length + 1 });

    // Truncation detection (the 1b test too): drop the anchored head's line and everything after it.
    const full = readFileSync(ledgerPath, "utf8");
    const kept = full.split("\n").filter(Boolean).slice(0, before.length - 1).join("\n") + "\n";
    writeFileSync(ledgerPath, kept);
    try {
      const truncated = await verify();
      expect(truncated.code).toBe(1); expect(truncated.out.anchor.status).toBe("mismatch"); expect(truncated.out.chain.ok).toBe(true);
    } finally { writeFileSync(ledgerPath, full); }
    const restored = await verify(); expect(restored.code).toBe(0); expect(restored.out.anchor.status).toBe("ancestor");
  }, HOOK_TIMEOUT_MS * 2);

  it("5. report stdout carries anchor.status ancestor and the report's own head check still passes", async () => {
    const from = new Date(startedAt - 60_000).toISOString(); const to = new Date(Date.now() + 60_000).toISOString();
    const outDir = join(project, "evidence-pack");
    const r = await agentLedger(["report", "--from", from, "--to", to, "--out", outDir, "--dir", ledgerDir]);
    timings["report"] = r.ms;
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { htmlPath: string; pdfPath: string; csvPath: string; chain: { ok: boolean; checked: number }; anchor: { status: string; latest: unknown } };
    expect(out.chain).toEqual({ ok: true, checked: records().length });
    expect(out.anchor).toEqual({ status: "ancestor", latest: anchorEntry });
    for (const p of [out.htmlPath, out.pdfPath, out.csvPath]) { expect(existsSync(p), p).toBe(true); expect(statSync(p).mode & 0o777).toBe(0o600); }
    pack = out;
    expect(readFileSync(out.htmlPath, "utf8")).toContain("Chain verification: PASS");
  }, HOOK_TIMEOUT_MS);

  it("6. fail closed is unchanged with the 5-event snippet: a corrupt registry, a missing key or a world-readable key make the watchdog deny with exit 2, while session-start and denied exit 0 silently; the ledger stays byte-identical", async () => {
    const before = readFileSync(ledgerPath);
    const registryPath = join(ledgerDir, "registry.yaml"); const keyPath = join(ledgerDir, "hmac.key");
    const expectDeny = (r: Run, label: string) => {
      expect(r.signal, label).toBeNull();
      expect(r.code, `${label}: ${r.stderr}`).toBe(2);
      const out = oneLine(r);
      expect(out.hookSpecificOutput.permissionDecision, label).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason, label).toMatch(/^watchdog:/);
      expect(r.ms, `${label}: deny must not wait for the deadline`).toBeLessThan(DEFAULT_DEADLINE_MS);
    };
    const silentBoth = async (label: string) => {
      const hb = await sh(sessionStartCommand, { ...fixture("sessionstart"), session_id: "e2e-sess-broken", cwd: project });
      expectSilent(hb, `${label} session-start`); expect(hb.stderr, `${label} session-start`).not.toBe("");
      const dn = await sh(deniedCommand, { ...fixture("permissiondenied"), session_id: SESSION_B, cwd: project, tool_use_id: BASH_B_ID, reason: REASON_CANARY });
      expectSilent(dn, `${label} denied`); expect(dn.stderr, `${label} denied`).not.toBe("");
    };
    const corrupt = { ...REGISTRY, servers: { "builtin:claude-code": { trusted: true, tools: { Read: { class: "harmless", reviewedBy: "nobody", reviewedAt: "2026-10-01" } } } } };
    writeFileSync(registryPath, JSON.stringify(corrupt) + "\n", { mode: 0o600 });
    try {
      expectDeny(await sh(preCommand, preEvent(SESSION_A, "Read", "toolu_e2e1c_denied_registry", { file_path: CLEAR_PATH })), "corrupt registry");
      await silentBoth("corrupt registry");
    } finally { writeFileSync(registryPath, JSON.stringify(REGISTRY, null, 2) + "\n", { mode: 0o600 }); }
    renameSync(keyPath, keyPath + ".bak");
    try {
      expectDeny(await sh(preCommand, preEvent(SESSION_A, "Read", "toolu_e2e1c_denied_nokey", { file_path: CLEAR_PATH })), "missing key");
      await silentBoth("missing key");
    } finally { renameSync(keyPath + ".bak", keyPath); }
    chmodSync(keyPath, 0o644);
    try {
      expectDeny(await sh(preCommand, preEvent(SESSION_A, "Read", "toolu_e2e1c_denied_keymode", { file_path: CLEAR_PATH })), "key not 0600");
      await silentBoth("key not 0600");
    } finally { chmodSync(keyPath, 0o600); }
    expect(readFileSync(ledgerPath).equals(before)).toBe(true);
    expect(heartbeats().some((h) => h.call.agentSessionId === "e2e-sess-broken")).toBe(false);
    // Whole again: the next reviewed read is allowed and recorded; the anchor is still an ancestor, so verify still passes.
    const again = await sh(preCommand, preEvent(SESSION_A, "Read", "toolu_e2e1c_read_03", { file_path: CLEAR_PATH }));
    expect(again.code, again.stderr).toBe(0); expect(oneLine(again).hookSpecificOutput.permissionDecision).toBe("allow");
    const v = await verify(); expect(v.code).toBe(0); expect(v.out.anchor.status).toBe("ancestor");
  }, HOOK_TIMEOUT_MS * 3);

  it("7. leak sweep: raw hashed arguments, the denial reason, the key, the credential and the NODE_OPTIONS canary are absent from the ledger, the pack and every process output", () => {
    expect(pack, "step 5 produced a pack").toBeDefined();
    const ledgerBytes = readFileSync(ledgerPath, "utf8");
    const surfaces: [string, string][] = [
      ["ledger", ledgerBytes],
      ["anchors", readFileSync(anchorsPath, "utf8")],
      ["html", readFileSync(pack!.htmlPath, "utf8")],
      ["csv", readFileSync(pack!.csvPath, "utf8")],
      ["pdf", pdfText(readFileSync(pack!.pdfPath))],
      ["pdf-bytes", readFileSync(pack!.pdfPath).toString("latin1")],
      ["transcript", transcript.join("\n")],
    ];
    expect(transcript.length).toBeGreaterThan(20);
    for (const [name, text] of surfaces) {
      for (const secret of [BASH_CANARY, NOTE_CANARY, REASON_CANARY, NODE_OPTIONS_CANARY, keyHex, credentialHex]) {
        expect(text.includes(secret), `${secret} found in ${name}`).toBe(false);
      }
    }
    expect(ledgerBytes).toContain(CLEAR_PATH);
    expect(ledgerBytes).toContain(SESSION_A); expect(ledgerBytes).toContain(SESSION_B);
    expect((ledgerBytes.match(/hmac-sha256:[0-9a-f]{64}/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // Every SessionStart hook run in this file produced zero stdout bytes (step 1 and the three broken-config runs).
    expect(heartbeats()).toHaveLength(1);
  });
});

afterAll(() => {
  if (Object.keys(timings).length > 0) process.stderr.write(`e2e-slice-1c round trips (ms): ${JSON.stringify(timings)}\n`);
});
