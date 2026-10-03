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
import { createRunner, parseCsv, pdfText, readJsonl, shellWords, type Run } from "./helpers/e2e-demo.js";

/**
 * Slice 1c end to end (docs/slices/slice-1c-pins.md "Integration seams"): Package A's steps 0-7, then the integration
 * steps 8-10 added at integration (test engineer, 2026-10-03): the pack produced by the REAL CLI in step 5 is read back
 * (HTML, PDF, CSV) and checked against the records the hooks really wrote, and the DEMO order (exit Claude → anchor →
 * verify exit 0 → report) runs end to end in a second sandbox. REAL processes and the BUILT artifacts, no mocks, no Claude Code:
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
let packRecords: LedgerRecord[] = [];                     // the ledger exactly as it was when step 5's pack was generated

const SECTION_IDS = ["summary", "cc6-1", "cc7-2", "cc8-1", "records", "legend"] as const;
const SECTION_TITLES = ["Executive summary", "CC6.1 logical access", "CC7.2 monitoring", "CC8.1 change management", "Record evidence", "Vocabulary"] as const;
const DENIAL_SENTENCE = "A manual denial at the Claude Code permission prompt fires no hook event (Claude Code hooks reference, read 2026-10-01), so 'asked, no outcome observed' cannot distinguish a user's denial from a cancelled call, an interrupted session or lost telemetry. Only auto-mode denials are recorded (`permission-denied:auto-mode`).";
const ANCHOR_SUFFIX = "; local file anchor, editable by this machine's owner";
const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]!);
/** The HTML of one `<section id>` (pin 8), with entities decoded so pinned sentences can be matched verbatim. */
const section = (html: string, id: string) => { const body = html.split(`<section id="${id}">`)[1]?.split("</section>")[0]; expect(body, `section #${id}`).toBeDefined(); return unesc(body!); };
/** The HTML that follows one `<h3>` heading up to the next heading (the table that belongs to that heading). */
const under = (sectionHtml: string, heading: string) => { const body = sectionHtml.split(`<h3>${heading}</h3>`)[1]?.split("<h3>")[0]; expect(body, `heading ${heading}`).toBeDefined(); return body!; };
/** Body rows of the first table in `html`, as cell texts; an empty table renders one `None` cell and yields []. */
const tableRows = (html: string): string[][] => {
  const tbody = html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "";
  return [...tbody.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) => [...m[1]!.matchAll(/<td(?: colspan="\d+")?>(.*?)<\/td>/gs)].map((c) => c[1]!)).filter((row) => !(row.length === 1 && row[0] === "None"));
};
const listItems = (html: string): string[] => [...html.matchAll(/<li>(.*?)<\/li>/gs)].map((m) => m[1]!);
const packRange = () => ({ from: new Date(startedAt - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });

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

describe.sequential("Slice 1c demo path (collector, pack and DEMO order), real processes, built artifacts", () => {
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
    pack = out; packRecords = records();
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

  // Integration seams 8-10 (test engineer, 2026-10-03). The pack under test is the one the REAL CLI wrote in step 5, read
  // back here against `packRecords` (the ledger as it stood at that moment: 7 records; step 6 appended one more later).
  it("8. pack content: the six sections in order in HTML and PDF; the anchor line says ancestor (pin 6 seam, not 'not supplied'); the heartbeat table has the step-1 row; sessions without heartbeat names exactly the step-3 session; CC8.1 shows denied: auto mode and asked, no outcome observed; the verbatim denial sentence is present", () => {
    expect(pack, "step 5 produced a pack").toBeDefined();
    expect(anchorEntry, "step 4 anchored").toBeDefined();
    expect(packRecords).toHaveLength(7);
    const html = readFileSync(pack!.htmlPath, "utf8");
    const pdf = pdfText(readFileSync(pack!.pdfPath));
    const hb = packRecords[0]!; const bashA = byCall(BASH_A_ID, "intent")[0]!; const bashB = byCall(BASH_B_ID, "intent")[0]!; const readA2 = byCall(READ_A2_ID, "intent")[0]!;
    expect(hb.policy.ruleId).toBe(HEARTBEAT_RULE_ID);

    // Section order, HTML ids and PDF titles (pin 8).
    let h = -1; let p = -1;
    SECTION_IDS.forEach((id, i) => {
      const nextH = html.indexOf(`<section id="${id}"><h2>${SECTION_TITLES[i]}</h2>`); expect(nextH, `#${id}`).toBeGreaterThan(h); h = nextH;
      const nextP = pdf.indexOf(SECTION_TITLES[i]!); expect(nextP, `pdf ${SECTION_TITLES[i]}`).toBeGreaterThan(p); p = nextP;
    });
    expect(pdf).toContain("page 1 /"); expect(pdf).toContain("chain PASS");

    // Anchor line: the CLI's anchor state reached B's renderer through the pin 6 context (the drift the seams list catches).
    const anchorLine = `Anchor: ancestor anchored at ${anchorEntry!.at}: records after it are unprotected${ANCHOR_SUFFIX}`;
    const summary = section(html, "summary"); const monitoring = section(html, "cc7-2"); const change = section(html, "cc8-1"); const access = section(html, "cc6-1");
    expect(summary).toContain(anchorLine); expect(monitoring).toContain(anchorLine); expect(pdf).toContain(anchorLine);
    for (const text of [html, pdf]) expect(text).not.toContain("not supplied to this report");
    expect(summary).toContain("Chain verification: PASS; checked 7 records (whole ledger); brokenAt: none");
    expect(summary).toContain(`Observed ledger head: ${packRecords.at(-1)!.hash}`);
    expect(summary).toContain("Agent sessions seen: 2; heartbeats: 1");
    expect(summary).toContain("Tool intents by risk: read: 2; write: 0; risky: 2; unreviewed: 0");
    expect(summary).toContain("Asks: 2; recorded approvals: 0");
    expect(summary).toContain("Recorded denials by cause: denied: auto mode: 1");
    expect(summary).toContain("Outcomes ok: 1; error: 0; no outcome observed: 2");
    const findings = listItems(under(summary, "Findings"));
    expect(findings).toEqual([
      `session without heartbeat: ${SESSION_B}; first tool record ${bashB.id}; 1 tool records in range`,
      `Launch environment: ${hb.id}; ${SESSION_A}; nodeOptionsSet: true; informational`,
      `no outcome observed: ${bashA.id}; call ${BASH_A_ID}`,
      `no outcome observed: ${readA2.id}; call ${READ_A2_ID}`,
    ]);

    // CC6.1: the four tool intents, never the heartbeat.
    const accessRows = tableRows(access);
    expect(accessRows.map((r) => [r[1], r[3], r[4], r[5]])).toEqual([
      [SESSION_A, "builtin:claude-code/Bash", "risky", "require_approval"],
      [SESSION_A, "builtin:claude-code/Read", "read", "allow"],
      [SESSION_B, "builtin:claude-code/Bash", "risky", "require_approval"],
      [SESSION_A, "builtin:claude-code/Read", "read", "allow"],
    ]);
    expect(access).not.toContain(HEARTBEAT_TOOL);

    // CC7.2: the heartbeat table carries the step-1 record (real session-start event) and nothing from the broken-config runs.
    expect(monitoring).toContain("Heartbeats (1)");
    expect(tableRows(under(monitoring, "Heartbeats (1)"))).toEqual([[hb.writtenAt, SESSION_A, "startup", "not supplied", "ok", "true", realpathSync(process.execPath)]]);
    expect(monitoring).not.toContain("e2e-sess-broken");
    expect(monitoring).toContain("Sessions without heartbeat (1)");
    expect(tableRows(under(monitoring, "Sessions without heartbeat (1)"))).toEqual([[SESSION_B, bashB.id, "1"]]);
    expect(tableRows(under(monitoring, "Launch-environment warnings (1)"))).toEqual([[hb.id, SESSION_A, "nodeOptionsSet: true", "informational"]]);
    for (const empty of ["Record anomalies (0)", "Orphan outcomes (0)", "Unreconciled handoffs (0)"]) expect(monitoring).toContain(empty);
    expect(tableRows(under(monitoring, "Intents with no outcome observed (2)"))).toEqual([[bashA.id, BASH_A_ID], [readA2.id, READ_A2_ID]]);
    expect(pdf).toContain("Heartbeats (1)"); expect(pdf).toContain("Sessions without heartbeat (1)"); expect(pdf).toContain(SESSION_B);

    // CC8.1: the two risky Bash intents with their evidence classes; the denial sentence directly under the table, verbatim.
    const changeRows = tableRows(change);
    expect(changeRows).toHaveLength(2);
    expect(changeRows[0]).toEqual([bashA.writtenAt, SESSION_A, "builtin:claude-code/Bash", "risky", "delegated, not recorded", "no outcome observed", "asked, no outcome observed"]);
    expect(changeRows[1]!.filter((_, i) => i !== 5)).toEqual([bashB.writtenAt, SESSION_B, "builtin:claude-code/Bash", "risky", "delegated, not recorded", "denied: auto mode"]);
    expect(JSON.parse(changeRows[1]![5]!)).toEqual({ status: "blocked", errorClass: PERMISSION_DENIED_ERROR_CLASS });
    expect(change.split("</table>")[1]).toContain(`<p>${DENIAL_SENTENCE}</p>`);
    expect(section(html, "legend")).toContain(DENIAL_SENTENCE);
    expect(section(html, "legend")).toContain("heartbeat = the SessionStart hook ran and could reach the ledger; it does not prove every later call was hooked");
    expect(pdf).toContain(DENIAL_SENTENCE); expect(pdf).toContain("denied: auto mode");
    expect(html).not.toContain("<script>");
  });

  it("9. CSV: the three appended columns are last and in order; the heartbeat row maps to CC7.2 only; evidence_class and agent_session_id match the HTML tables; anchor_status is ancestor on every row", () => {
    expect(pack, "step 5 produced a pack").toBeDefined();
    const rows = parseCsv(readFileSync(pack!.csvPath, "utf8"));
    const header = rows[0]!; const data = rows.slice(1);
    expect(header.slice(-4)).toEqual(["trust_boundary", "agent_session_id", "evidence_class", "anchor_status"]);
    const col = (name: string) => { const i = header.indexOf(name); expect(i, `csv column ${name}`).toBeGreaterThanOrEqual(0); return i; };
    expect(data.map((r) => r[col("record_id")])).toEqual(packRecords.map((r) => r.id));
    for (const row of data) { expect(row).toHaveLength(header.length); expect(row[col("anchor_status")]).toBe("ancestor"); expect(row[col("chain_verify")]).toBe("PASS"); }
    expect(data.map((r) => r[col("agent_session_id")])).toEqual(packRecords.map((r) => r.call.agentSessionId));
    const byId = (id: string) => data.find((r) => r[col("record_id")] === id)!;
    const hbRow = byId(packRecords[0]!.id);
    expect(hbRow[col("criteria")]).toBe("CC7.2"); expect(hbRow[col("evidence_class")]).toBe(""); expect(hbRow[col("anomalies")]).toBe("");
    expect(hbRow[col("tool")]).toBe(HEARTBEAT_TOOL);
    // evidence_class per record, matching the HTML CC8.1 cells for the two risky intents and their causes for the rest.
    const expected: [string, LedgerRecord["phase"], string, string, string][] = [
      [BASH_A_ID, "intent", "asked, no outcome observed", "CC6.1; CC7.2; CC8.1", "no outcome observed"],
      [READ_A_ID, "intent", "executed (allowed)", "CC6.1; CC7.2", ""],
      [READ_A_ID, "outcome", "executed (allowed)", "CC6.1; CC7.2", ""],
      [BASH_B_ID, "intent", "denied: auto mode", "CC6.1; CC7.2; CC8.1", "session without heartbeat"],
      [BASH_B_ID, "outcome", "denied: auto mode", "CC6.1; CC7.2; CC8.1", ""],
      [READ_A2_ID, "intent", "allowed, no outcome observed", "CC6.1; CC7.2", "no outcome observed"],
    ];
    for (const [callId, phase, label, criteria, anomalies] of expected) {
      const row = data.find((r) => r[col("call_id")] === callId && r[col("phase")] === phase)!;
      expect(row, `${callId} ${phase}`).toBeDefined();
      expect(row[col("evidence_class")], `${callId} ${phase}`).toBe(label);
      expect(row[col("criteria")], `${callId} ${phase}`).toBe(criteria);
      expect(row[col("anomalies")], `${callId} ${phase}`).toBe(anomalies);
    }
    const html = readFileSync(pack!.htmlPath, "utf8");
    for (const row of tableRows(section(html, "cc8-1"))) {
      const csvRow = data.find((r) => r[col("written_at")] === row[0] && r[col("phase")] === "intent")!;
      expect(csvRow[col("evidence_class")]).toBe(row[6]); expect(csvRow[col("agent_session_id")]).toBe(row[1]);
    }
    const bashB = byId(byCall(BASH_B_ID, "outcome")[0]!.id);
    expect(JSON.parse(bashB[col("outcome")]!)).toEqual({ status: "blocked", errorClass: PERMISSION_DENIED_ERROR_CLASS });
    for (const row of data) { expect(row[col("arguments_labeled")]).not.toContain("hmac-sha256:"); }
  });

  it("10. DEMO order in a fresh sandbox: heartbeat (zero stdout) → approved Bash → manually denied Bash → exit 7 → exit Claude → anchor → verify exit 0 head → report says head anchored, executed after ask, asked, no outcome observed, execution error, no findings about heartbeats", async () => {
    // docs/DEMO.md steps 1-6 as Claude Code would drive them, in a second project under the same private build root.
    // The npm-level half of seam 10 (`npm test` 3/3 under a concurrent run, `npm run check`) is run by the harness, not here.
    const demo = join(root, "demo-project"); mkdirSync(demo);
    const demoLedgerDir = join(demo, ".agent-ledger"); const demoLedger = join(demoLedgerDir, "ledger", "records.jsonl");
    const demoSession = "e2e-demo-sess-5a9e"; const ERROR_CANARY = "e2e-error-canary-c0ffee";
    const approvedId = "toolu_demo_bash_approved"; const deniedId = "toolu_demo_bash_denied"; const exit7Id = "toolu_demo_bash_exit7";
    const demoCli = (args: string[]) => run(process.execPath, [cli, ...args], { cwd: demo, env });
    const demoSh = (command: string, event: unknown) => run("/bin/sh", ["-c", command], { cwd: demo, env, input: JSON.stringify(event), timeoutMs: HOOK_TIMEOUT_MS });
    const demoRecords = () => readJsonl<LedgerRecord>(demoLedger);

    const init = await demoCli(["init"]); expect(init.code, init.stderr).toBe(0);          // DEMO 1 (default --dir from the project cwd)
    writeFileSync(join(demoLedgerDir, "registry.yaml"), JSON.stringify(REGISTRY, null, 2) + "\n", { mode: 0o600 });
    const printed = await demoCli(["install-hooks", "--print"]); expect(printed.code, printed.stderr).toBe(0); // DEMO 2
    const demoSnippet = JSON.parse(printed.stdout) as HookSnippet;
    expect(Object.keys(demoSnippet.hooks)).toHaveLength(5);
    const cmd = (event: string) => demoSnippet.hooks[event]![0]!.hooks[0]!.command;
    expect(shellWords(cmd("SessionStart")).slice(-2)).toEqual(["--dir", demoLedgerDir]);

    // DEMO 3: the heartbeat lands before the first prompt; the handler prints nothing (it would become Claude's context).
    const hb = await demoSh(cmd("SessionStart"), { ...fixture("sessionstart"), session_id: demoSession, cwd: demo, source: "startup", permission_mode: "default" });
    timings["demo-session-start"] = hb.ms;
    expectSilent(hb, "demo session-start"); expect(hb.stderr).toBe(""); expect(Buffer.byteLength(hb.stdout)).toBe(0);
    expect(demoRecords()).toHaveLength(1); expect(demoRecords()[0]!.call.args).toMatchObject({ permissionMode: "default", watchdogCheck: "ok", nodeOptionsSet: false });
    // DEMO 4: approve one harmless Bash → ask, then PostToolUse ok.
    const approvedInput = { command: "printf 'approved sandbox demo\\n'" };
    const ask1 = await demoSh(cmd("PreToolUse"), { ...fixture("pretooluse"), session_id: demoSession, cwd: demo, tool_name: "Bash", tool_use_id: approvedId, tool_input: approvedInput });
    expect(ask1.code, ask1.stderr).toBe(0); expect(oneLine(ask1).hookSpecificOutput.permissionDecision).toBe("ask");
    const post = await demoSh(cmd("PostToolUse"), { ...fixture("posttooluse"), session_id: demoSession, cwd: demo, tool_name: "Bash", tool_use_id: approvedId, tool_input: approvedInput, tool_response: "approved sandbox demo\n" });
    expectSilent(post, "demo post");
    // DEMO 5: deny the second Bash at the prompt: no hook event follows, so the ledger keeps the ask and nothing else.
    const ask2 = await demoSh(cmd("PreToolUse"), { ...fixture("pretooluse"), session_id: demoSession, cwd: demo, tool_name: "Bash", tool_use_id: deniedId, tool_input: { command: "printf 'denied sandbox demo\\n'" } });
    expect(ask2.code, ask2.stderr).toBe(0); expect(oneLine(ask2).hookSpecificOutput.permissionDecision).toBe("ask");
    // DEMO 5 optional: approve `exit 7` → PostToolUseFailure records an error outcome (the error text is never stored).
    const ask3 = await demoSh(cmd("PreToolUse"), { ...fixture("pretooluse"), session_id: demoSession, cwd: demo, tool_name: "Bash", tool_use_id: exit7Id, tool_input: { command: "exit 7" } });
    expect(ask3.code, ask3.stderr).toBe(0); expect(oneLine(ask3).hookSpecificOutput.permissionDecision).toBe("ask");
    const failure = await demoSh(cmd("PostToolUseFailure"), { ...fixture("posttoolusefailure"), session_id: demoSession, cwd: demo, tool_name: "Bash", tool_use_id: exit7Id, tool_input: { command: "exit 7" }, error: `Exit code 7\nError: ${ERROR_CANARY}`, is_interrupt: false, duration_ms: 12 });
    expectSilent(failure, "demo post-failure");
    const all = demoRecords(); expect(all).toHaveLength(6); assertChainLinks(all);
    expect(all.filter((r) => r.phase === "outcome").map((r) => [r.call.callId, r.outcome!.status])).toEqual([[approvedId, "ok"], [exit7Id, "error"]]);

    // DEMO 6: Claude has exited; anchor → verify exit 0 head → report; the saved anchor JSON moves into the pack afterwards.
    const anchored = await demoCli(["anchor"]); timings["demo-anchor"] = anchored.ms;
    expect(anchored.code, anchored.stderr).toBe(0);
    const anchorOut = JSON.parse(anchored.stdout) as AnchorOut;
    expect(anchorOut.anchored).toBe(true); expect(anchorOut.entry!.hash).toBe(all.at(-1)!.hash); expect(anchorOut.chain).toEqual({ ok: true, checked: 6 });
    const savedAnchor = join(demo, "anchor-result.json"); writeFileSync(savedAnchor, anchored.stdout, { mode: 0o600 });
    const verified = await demoCli(["verify"]); timings["demo-verify"] = verified.ms;
    expect(verified.code, verified.stderr).toBe(0);
    const v = JSON.parse(verified.stdout) as VerifyOut;
    expect(v.chain).toEqual({ ok: true, checked: 6 }); expect(v.anchor).toEqual({ status: "head", latest: anchorOut.entry });
    const { from, to } = packRange(); const outDir = join(demo, "evidence-pack");
    expect(existsSync(outDir)).toBe(false);                                                  // report creates it (0700), never mkdir -p
    const reported = await demoCli(["report", "--from", from, "--to", to, "--out", outDir]); timings["demo-report"] = reported.ms;
    expect(reported.code, reported.stderr).toBe(0);
    const out = JSON.parse(reported.stdout) as { htmlPath: string; pdfPath: string; csvPath: string; chain: { ok: boolean; checked: number }; anchor: { status: string; latest: unknown } };
    expect(out.chain).toEqual({ ok: true, checked: 6 }); expect(out.anchor).toEqual({ status: "head", latest: anchorOut.entry });
    expect(statSync(outDir).mode & 0o777).toBe(0o700);
    renameSync(savedAnchor, join(outDir, "anchor-result.json"));
    expect(JSON.parse(readFileSync(join(outDir, "anchor-result.json"), "utf8"))).toEqual(anchorOut);

    // The walk-through (DEMO 6, sections 1-4) on the real pack.
    const html = readFileSync(out.htmlPath, "utf8"); const pdf = pdfText(readFileSync(out.pdfPath));
    const summary = section(html, "summary"); const monitoring = section(html, "cc7-2"); const change = section(html, "cc8-1");
    const headLine = `Anchor: head anchored at ${anchorOut.entry!.at}${ANCHOR_SUFFIX}`;
    expect(summary).toContain(headLine); expect(monitoring).toContain(headLine); expect(pdf).toContain(headLine);
    expect(summary).toContain("Chain verification: PASS; checked 6 records (whole ledger); brokenAt: none");
    expect(summary).toContain("Agent sessions seen: 1; heartbeats: 1");
    expect(summary).toContain("Asks: 3; recorded approvals: 0");
    expect(summary).toContain("Recorded denials by cause: none");
    expect(summary).toContain("Outcomes ok: 1; error: 1; no outcome observed: 1");
    const deniedIntent = all.find((r) => r.call.callId === deniedId)!;
    expect(listItems(under(summary, "Findings"))).toEqual([`no outcome observed: ${deniedIntent.id}; call ${deniedId}`]);
    expect(tableRows(under(monitoring, "Heartbeats (1)")).map((r) => r.slice(1, 6))).toEqual([[demoSession, "startup", "default", "ok", "false"]]);
    for (const empty of ["Sessions without heartbeat (0)", "Launch-environment warnings (0)", "Orphan outcomes (0)", "Unreconciled handoffs (0)"]) expect(monitoring).toContain(empty);
    expect(tableRows(change).map((r) => [r[1], r[4], r[6]])).toEqual([
      [demoSession, "delegated, not recorded", "executed after ask"],
      [demoSession, "delegated, not recorded", "asked, no outcome observed"],
      [demoSession, "delegated, not recorded", "execution error"],
    ]);
    expect(change).toContain(DENIAL_SENTENCE);
    const csv = parseCsv(readFileSync(out.csvPath, "utf8"));
    expect(csv.slice(1).map((r) => r.at(-1))).toEqual(Array(6).fill("head"));
    for (const text of [html, pdf, readFileSync(out.csvPath, "utf8"), readFileSync(demoLedger, "utf8"), transcript.join("\n")]) {
      expect(text).not.toContain(ERROR_CANARY);
      expect(text).not.toContain("approved sandbox demo");                                  // Bash storeArgs []: command text withheld
    }
  }, HOOK_TIMEOUT_MS * 3);
});

afterAll(() => {
  if (Object.keys(timings).length > 0) process.stderr.write(`e2e-slice-1c round trips (ms): ${JSON.stringify(timings)}\n`);
});
