import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import canonicalize from "canonicalize";
import type { LedgerRecord } from "../src/types/index.js";
import { DEFAULT_DEADLINE_MS, HOOK_TIMEOUT_S, WATCHDOG_DEADLINE_AT_ENV, WATCHDOG_DEADLINE_ENV, WATCHDOG_MIN_MARGIN_MS } from "../src/hooks/contract.js";
import { createAnchor } from "../src/anchor/contract.js";
import { createRunner, parseCsv, pdfText, readJsonl, shellWords, type Run } from "./helpers/e2e-demo.js";

/**
 * Slice 1b end to end: docs/DEMO.md steps 1, 2, 4-6 with REAL processes and the BUILT artifacts, no mocks, no
 * Claude Code. The agent's part (the settings file and the terminal prompt) is replaced by what Claude Code would
 * do: run the printed hook commands through /bin/sh with the fixture events on stdin. The steps are sequential on
 * purpose: one sandbox, one ledger, one evidence pack, so a later step is checked against what the earlier ones
 * really wrote.
 *
 * The artifacts are `tsconfig.build.json` compiled into a PRIVATE root (dist + policies + package.json + a
 * node_modules symlink), not the repo's `dist/`: test/cli-process.test.ts rebuilds `dist/` in its own beforeAll, and
 * vitest runs files in parallel, so hooks executing from `dist/` while another worker's tsc truncates and rewrites it
 * would be a flake we would blame on the product. Same compiler, same config, different --outDir.
 */

interface HookSnippet { hooks: Record<string, { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[]> }
type HookOutput = { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };

const HOOK_TIMEOUT_MS = 60_000;
const BASH_CANARY = "e2e-bash-canary-4c1f7a";           // a Bash command argument: storeArgs [] → never in the clear
const NOTE_CANARY = "e2e-note-canary-b83d2e";           // a non-allowlisted Read field → hmac only
const ERROR_CANARY = "e2e-error-canary-91aa07";         // PostToolUseFailure error text → never stored
const CLEAR_PATH = "/tmp/e2e-sandbox/notes-7d0c.txt";   // Read.file_path, the one reviewed clear field
const BASH_ID = "toolu_e2e_bash_01"; const READ_ID = "toolu_e2e_read_01";
const REGISTRY = {
  version: 1,
  servers: {
    "builtin:claude-code": {
      trusted: true,
      tools: {
        Bash: { class: "risky", reviewedBy: "e2e-reviewer", reviewedAt: "2026-09-30", storeArgs: [] },
        Read: { class: "read", reviewedBy: "e2e-reviewer", reviewedAt: "2026-09-30", storeArgs: ["file_path"] },
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
let preCommand = ""; let postCommand = ""; let postFailureCommand = "";
let ledgerPath = "";
let head = "";
let pack: { htmlPath: string; pdfPath: string; csvPath: string };

const records = () => readJsonl<LedgerRecord>(ledgerPath);
const byCall = (callId: string, phase: LedgerRecord["phase"]) => records().filter((r) => r.call.callId === callId && r.phase === phase);
const HMAC_RE = /^hmac-sha256:[0-9a-f]{64}$/;
const oneLine = (r: Run): HookOutput => {
  const lines = r.stdout.split("\n").filter((l) => l.length > 0);
  expect(lines, `stdout: ${JSON.stringify(r.stdout)}`).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!) as HookOutput;
  expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
  expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(typeof parsed.hookSpecificOutput.permissionDecisionReason).toBe("string");
  return parsed;
};
const sh = (command: string, event: unknown, timeoutMs = HOOK_TIMEOUT_MS) => run("/bin/sh", ["-c", command], { cwd: project, env, input: JSON.stringify(event), timeoutMs });
const agentLedger = (args: string[]) => run(process.execPath, [cli, ...args], { cwd: project, env });
const preEvent = (tool: string, id: string, input: Record<string, unknown>) => ({ ...fixture("pretooluse"), cwd: project, tool_name: tool, tool_use_id: id, tool_input: input });
const assertChainLinks = (list: LedgerRecord[]) => {
  list.forEach((r, i) => {
    expect(r.prevHash).toBe(i === 0 ? "0" : list[i - 1]!.hash);
    expect(r.parentRecordId).toBe(i === 0 ? null : list[i - 1]!.id);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });
};

beforeAll(() => {
  startedAt = Date.now();
  root = realpathSync(mkdtempSync(join(tmpdir(), "agent-ledger-e2e-")));
  execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", join(root, "dist")], { stdio: "pipe" });
  cli = join(root, "dist/cli/main.js");
  chmodSync(cli, 0o755);
  cpSync(resolve("policies"), join(root, "policies"), { recursive: true });
  copyFileSync(resolve("package.json"), join(root, "package.json"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"));
  project = join(root, "project"); mkdirSync(project);
  ledgerDir = join(project, ".agent-ledger");
  ledgerPath = join(ledgerDir, "ledger", "records.jsonl");
  env = { ...process.env };
  delete env[WATCHDOG_DEADLINE_AT_ENV]; delete env[WATCHDOG_DEADLINE_ENV];
}, 120_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe.sequential("Slice 1b demo path, real processes, built artifacts", () => {
  it("1. init creates a private ledger directory whose key and credential are 0600, and refuses a second init", async () => {
    const init = await agentLedger(["init", "--dir", ledgerDir]);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain("Initialized");
    expect(statSync(ledgerDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(ledgerDir, "ledger")).isDirectory()).toBe(true);
    const key = statSync(join(ledgerDir, "hmac.key"));
    expect(key.mode & 0o777).toBe(0o600); expect(key.size).toBe(32);
    const credential = statSync(join(ledgerDir, "credential"));
    expect(credential.mode & 0o777).toBe(0o600);
    keyHex = readFileSync(join(ledgerDir, "hmac.key")).toString("hex");
    credentialHex = readFileSync(join(ledgerDir, "credential"), "utf8").trim();
    expect(credentialHex).toMatch(/^[a-f0-9]{64}$/);
    for (const name of ["registry.yaml", "agents.yaml"]) expect(statSync(join(ledgerDir, name)).mode & 0o777).toBe(0o600);
    expect(init.stdout + init.stderr).not.toContain(keyHex);
    expect(init.stdout + init.stderr).not.toContain(credentialHex);
    const again = await agentLedger(["init", "--dir", ledgerDir]);
    expect(again.code).toBe(1); expect(again.stderr).not.toBe("");
  }, HOOK_TIMEOUT_MS);

  it("2. the sandbox registry classifies Bash as risky (no clear args) and Read as read with file_path in the clear; a fresh ledger verifies empty", async () => {
    // Registry in the format the policy loader accepts (JSON is a YAML subset; `init` writes the same way).
    writeFileSync(join(ledgerDir, "registry.yaml"), JSON.stringify(REGISTRY, null, 2) + "\n", { mode: 0o600 });
    const verify = await agentLedger(["verify", "--dir", ledgerDir]);
    expect(verify.code, verify.stderr).toBe(3); // chain ok, no anchor: documented exit 3
    const out = JSON.parse(verify.stdout) as { chain: unknown; anchor: { status: string } };
    expect(out.chain).toEqual({ ok: true, checked: 0 }); expect(out.anchor.status).toBe("missing");
  }, HOOK_TIMEOUT_MS);

  it("3. install-hooks --print wires PreToolUse through the watchdog and both post events directly; every path in it exists", async () => {
    const printed = await agentLedger(["install-hooks", "--print", "--dir", ledgerDir]);
    expect(printed.code, printed.stderr).toBe(0);
    snippet = JSON.parse(printed.stdout) as HookSnippet;
    // Slice 1c (pin 5) added SessionStart and PermissionDenied; this 1b path still only exercises the first three.
    expect(Object.keys(snippet.hooks).sort()).toEqual(["PermissionDenied", "PostToolUse", "PostToolUseFailure", "PreToolUse", "SessionStart"]);
    for (const entries of Object.values(snippet.hooks)) {
      expect(entries).toHaveLength(1);
      expect(entries[0]!.matcher).toBe("");
      expect(entries[0]!.hooks).toHaveLength(1);
      expect(entries[0]!.hooks[0]!.type).toBe("command");
      expect(entries[0]!.hooks[0]!.timeout).toBe(HOOK_TIMEOUT_S);
    }
    preCommand = snippet.hooks["PreToolUse"]![0]!.hooks[0]!.command;
    postCommand = snippet.hooks["PostToolUse"]![0]!.hooks[0]!.command;
    postFailureCommand = snippet.hooks["PostToolUseFailure"]![0]!.hooks[0]!.command;
    expect(postFailureCommand).toBe(postCommand);

    // Drift check: the snippet must name the real entry points, and they must be the ones we built.
    const pre = shellWords(preCommand);
    const sep = pre.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    const watchdogArgv = pre.slice(0, sep); const handlerArgv = pre.slice(sep + 1);
    expect(realpathSync(watchdogArgv[0]!)).toBe(realpathSync(process.execPath));
    expect(watchdogArgv[1]).toBe(join(root, "dist/hooks/watchdog-main.js"));
    expect(existsSync(watchdogArgv[1]!)).toBe(true);
    expect(watchdogArgv.slice(2)).toEqual(["--agent", "claude-code", "--deadline-ms", String(DEFAULT_DEADLINE_MS), "--timeout-s", String(HOOK_TIMEOUT_S)]);
    expect(DEFAULT_DEADLINE_MS + WATCHDOG_MIN_MARGIN_MS).toBeLessThanOrEqual(HOOK_TIMEOUT_S * 1000);
    expect(realpathSync(handlerArgv[0]!)).toBe(realpathSync(process.execPath));
    expect(handlerArgv[1]).toBe(cli);
    expect(handlerArgv.slice(2)).toEqual(["hook", "--agent", "claude-code", "--event", "pre", "--dir", ledgerDir]);
    const post = shellWords(postCommand);
    expect(realpathSync(post[0]!)).toBe(realpathSync(process.execPath));
    expect(post[1]).toBe(cli);
    expect(post.slice(2)).toEqual(["hook", "--agent", "claude-code", "--event", "post", "--dir", ledgerDir]);
  }, HOOK_TIMEOUT_MS);

  it("4. a risky Bash PreToolUse through the printed watchdog command answers ask with exit 0 and records a delegated intent", async () => {
    const r = await sh(preCommand, preEvent("Bash", BASH_ID, { command: `printf '${BASH_CANARY}\\n'`, description: "approved sandbox demo" }));
    timings["pre-bash-ask"] = r.ms;
    expect(r.signal).toBeNull();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    const out = oneLine(r);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/risky/);
    expect(JSON.stringify(out)).toBe(r.stdout.trim()); // the watchdog re-serialises; the line IS the payload
    const intents = byCall(BASH_ID, "intent");
    expect(intents).toHaveLength(1);
    const intent = intents[0]!;
    expect(intent.call.server).toBe("builtin:claude-code"); expect(intent.call.tool).toBe("Bash");
    expect(intent.call.agentId).toBe("local-agent");
    expect(intent.policy).toMatchObject({ verdict: "require_approval", risk: "risky" });
    expect(intent.approval).toMatchObject({ callId: BASH_ID, channel: "hook-ask", decision: "delegated" });
    expect(Object.keys(intent.call.args).sort()).toEqual(["command", "description"]);
    for (const value of Object.values(intent.call.args)) expect(value).toMatch(HMAC_RE);
    expect(r.ms, "watchdog round trip").toBeLessThan(10_000);
  }, HOOK_TIMEOUT_MS);

  it("5. a reviewed Read PreToolUse answers allow; file_path is stored in the clear and every other field only as a keyed digest", async () => {
    const r = await sh(preCommand, preEvent("Read", READ_ID, { file_path: CLEAR_PATH, limit: 20, note: NOTE_CANARY }));
    timings["pre-read-allow"] = r.ms;
    expect(r.signal).toBeNull();
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(oneLine(r).hookSpecificOutput.permissionDecision).toBe("allow");
    const intents = byCall(READ_ID, "intent");
    expect(intents).toHaveLength(1);
    const { args } = intents[0]!.call;
    expect(intents[0]!.policy).toMatchObject({ verdict: "allow", risk: "read" });
    expect(args["file_path"]).toBe(CLEAR_PATH);
    expect(args["limit"]).toMatch(HMAC_RE);
    expect(args["note"]).toMatch(HMAC_RE);
    // ADR-009: an auditor holding the per-ledger key can recompute the digest of a value they are shown; nobody else can read it.
    const key = readFileSync(join(ledgerDir, "hmac.key"));
    const digest = (value: unknown) => "hmac-sha256:" + createHmac("sha256", key).update(canonicalize(value)!, "utf8").digest("hex");
    expect(args["note"]).toBe(digest(NOTE_CANARY));
    expect(args["limit"]).toBe(digest(20));
    expect(args["note"]).not.toBe(digest("not the note"));
    expect(r.ms, "watchdog round trip").toBeLessThan(10_000);
  }, HOOK_TIMEOUT_MS);

  it("6. the direct post handler exits 0 silently: PostToolUse chains an ok outcome to the Read intent, PostToolUseFailure an error outcome to the Bash intent", async () => {
    const post = await sh(postCommand, { ...fixture("posttooluse"), cwd: project, tool_name: "Read", tool_use_id: READ_ID, tool_input: { file_path: CLEAR_PATH, limit: 20, note: NOTE_CANARY }, tool_response: "file contents" });
    timings["post-read-ok"] = post.ms;
    expect(post.code, post.stderr).toBe(0); expect(post.stdout).toBe(""); expect(post.stderr).toBe("");
    const failure = await sh(postFailureCommand, { ...fixture("posttoolusefailure"), cwd: project, tool_name: "Bash", tool_use_id: BASH_ID, tool_input: { command: `printf '${BASH_CANARY}\\n'`, description: "approved sandbox demo" }, error: `Exit code 7\nError: ${ERROR_CANARY}`, is_interrupt: false, duration_ms: 12 });
    timings["post-bash-failure"] = failure.ms;
    expect(failure.code, failure.stderr).toBe(0); expect(failure.stdout).toBe(""); expect(failure.stderr).toBe("");

    const all = records();
    expect(all).toHaveLength(4);
    assertChainLinks(all);
    const readIntent = byCall(READ_ID, "intent")[0]!; const readOutcome = byCall(READ_ID, "outcome");
    expect(readOutcome).toHaveLength(1);
    expect(readOutcome[0]!.outcome).toEqual({ status: "ok" });
    expect(readOutcome[0]!.call).toEqual(readIntent.call);       // the outcome carries the intent's projected call, not the event's raw input
    expect(readOutcome[0]!.policy).toEqual(readIntent.policy);
    const bashIntent = byCall(BASH_ID, "intent")[0]!; const bashOutcome = byCall(BASH_ID, "outcome");
    expect(bashOutcome).toHaveLength(1);
    expect(bashOutcome[0]!.outcome).toEqual({ status: "error", errorClass: "Exit code 7", durationMs: 12 });
    expect(bashOutcome[0]!.call).toEqual(bashIntent.call);
    expect(bashOutcome[0]!.approval).toBeUndefined();
    // No orphan: every outcome follows an intent for the same call in this ledger.
    const seen = new Set<string>();
    for (const r of all) { if (r.phase === "intent") seen.add(r.call.callId); else expect(seen.has(r.call.callId), `orphan outcome ${r.id}`).toBe(true); }
  }, HOOK_TIMEOUT_MS);

  it("7. fail closed: a corrupt registry, a missing key or a world-readable key make the watchdog deny with exit 2 and leave the ledger byte-identical", async () => {
    const before = readFileSync(ledgerPath);
    const registryPath = join(ledgerDir, "registry.yaml"); const keyPath = join(ledgerDir, "hmac.key");
    const expectDeny = (r: Run, label: string) => {
      expect(r.signal, label).toBeNull();
      expect(r.code, `${label}: ${r.stderr}`).toBe(2);
      const out = oneLine(r);
      expect(out.hookSpecificOutput.permissionDecision, label).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason, label).toMatch(/^watchdog:/);
      expect(r.stderr.split("\n")[0], label).toMatch(/^watchdog:/);
      expect(r.ms, `${label}: deny must not wait for the deadline`).toBeLessThan(DEFAULT_DEADLINE_MS);
    };
    const corrupt = { ...REGISTRY, servers: { "builtin:claude-code": { trusted: true, tools: { Read: { class: "harmless", reviewedBy: "nobody", reviewedAt: "2026-09-30" } } } } };
    writeFileSync(registryPath, JSON.stringify(corrupt) + "\n", { mode: 0o600 });
    try {
      const r = await sh(preCommand, preEvent("Read", "toolu_e2e_denied_registry", { file_path: CLEAR_PATH }));
      timings["pre-deny-corrupt-registry"] = r.ms;
      expectDeny(r, "corrupt registry");
    } finally { writeFileSync(registryPath, JSON.stringify(REGISTRY, null, 2) + "\n", { mode: 0o600 }); }

    renameSync(keyPath, keyPath + ".bak");
    try {
      const r = await sh(preCommand, preEvent("Read", "toolu_e2e_denied_nokey", { file_path: CLEAR_PATH }));
      timings["pre-deny-missing-key"] = r.ms;
      expectDeny(r, "missing key");
    } finally { renameSync(keyPath + ".bak", keyPath); }

    chmodSync(keyPath, 0o644);
    try {
      const r = await sh(preCommand, preEvent("Read", "toolu_e2e_denied_keymode", { file_path: CLEAR_PATH }));
      timings["pre-deny-key-0644"] = r.ms;
      expectDeny(r, "key not 0600");
    } finally { chmodSync(keyPath, 0o600); }

    expect(readFileSync(ledgerPath).equals(before)).toBe(true);
    // The configuration is whole again: the next reviewed read is allowed (and recorded, so the ledger grows by one).
    const again = await sh(preCommand, preEvent("Read", "toolu_e2e_read_02", { file_path: CLEAR_PATH }));
    expect(again.code, again.stderr).toBe(0);
    expect(oneLine(again).hookSpecificOutput.permissionDecision).toBe("allow");
    expect(records()).toHaveLength(5);
  }, HOOK_TIMEOUT_MS * 2);

  it("8. verify passes the chain: exit 3 with no anchor, exit 0 once the head is anchored", async () => {
    const unanchored = await agentLedger(["verify", "--dir", ledgerDir]);
    expect(unanchored.code, unanchored.stderr).toBe(3);
    const first = JSON.parse(unanchored.stdout) as { chain: { ok: boolean; checked: number }; head: string; anchor: { status: string } };
    expect(first.chain).toEqual({ ok: true, checked: 5 });
    expect(first.anchor.status).toBe("missing");
    head = first.head;
    expect(head).toBe(records().at(-1)!.hash);
    // This slice ships no anchor scheduler; the anchor module is the real one the CLI reads.
    await createAnchor("file", join(ledgerDir, "anchors.jsonl")).write({ hash: head, at: new Date().toISOString() });
    const anchored = await agentLedger(["verify", "--dir", ledgerDir]);
    expect(anchored.code, anchored.stderr).toBe(0);
    const second = JSON.parse(anchored.stdout) as { chain: unknown; anchor: { status: string } };
    expect(second.chain).toEqual({ ok: true, checked: 5 });
    expect(second.anchor.status).toBe("head");
  }, HOOK_TIMEOUT_MS);

  it("9. report writes HTML, PDF and CSV; the CSV rows are the ledger records in range and all three state the local-mode trust boundary", async () => {
    const from = new Date(startedAt - 60_000).toISOString(); const to = new Date(Date.now() + 60_000).toISOString();
    const outDir = join(project, "evidence-pack");
    const r = await agentLedger(["report", "--from", from, "--to", to, "--out", outDir]);
    // `report` resolves --dir against cwd; the demo runs it from the project directory with the default `.agent-ledger`.
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { htmlPath: string; pdfPath: string; csvPath: string; chain: { ok: boolean; checked: number } };
    expect(out.chain).toEqual({ ok: true, checked: 5 });
    pack = out;
    for (const p of [out.htmlPath, out.pdfPath, out.csvPath]) { expect(existsSync(p), p).toBe(true); expect(statSync(p).mode & 0o777).toBe(0o600); }
    expect(out.htmlPath).toBe(join(outDir, "report.html"));

    const all = records();
    const inRange = all.filter((x) => Date.parse(x.writtenAt) >= Date.parse(from) && Date.parse(x.writtenAt) <= Date.parse(to));
    expect(inRange).toHaveLength(all.length);
    const rows = parseCsv(readFileSync(out.csvPath, "utf8"));
    const header = rows[0]!; const data = rows.slice(1);
    expect(data).toHaveLength(inRange.length);
    const col = (name: string) => { const i = header.indexOf(name); expect(i, `csv column ${name}`).toBeGreaterThanOrEqual(0); return i; };
    expect(data.map((row) => row[col("record_id")])).toEqual(inRange.map((x) => x.id));
    expect(data.map((row) => row[col("hash")])).toEqual(inRange.map((x) => x.hash));
    for (const row of data) expect(row[col("trust_boundary")]).toContain("Local mode: visibility, tamper-evident logging and best-effort gating, not enforcement");
    const readRow = data.find((row) => row[col("call_id")] === READ_ID && row[col("phase")] === "intent")!;
    expect(readRow[col("arguments_labeled")]).toContain(CLEAR_PATH);
    expect(readRow[col("arguments_labeled")]).toContain("HMAC-SHA256 digest (argument withheld)");
    expect(readRow[col("arguments_labeled")]).not.toContain("hmac-sha256:");
    const bashRow = data.find((row) => row[col("call_id")] === BASH_ID && row[col("phase")] === "intent")!;
    expect(bashRow[col("approval")]).toContain("delegated");
    expect(bashRow[col("criteria")]).toContain("CC8.1");

    const trust = "Local mode: visibility, tamper-evident logging and best-effort gating, not enforcement.";
    const html = readFileSync(out.htmlPath, "utf8");
    expect(html).toContain(`${inRange.length} records`);
    expect(html).toContain("Chain verification: PASS");
    expect(html).toContain(trust);
    expect(html).toContain(CLEAR_PATH);
    expect(html).toContain("delegated = asked in the terminal; not a recorded human approval");
    const pdf = readFileSync(out.pdfPath);
    expect(pdf.subarray(0, 8).toString("ascii")).toBe("%PDF-1.4");
    const text = pdfText(pdf);
    expect(text).toContain(trust);
    expect(text).toContain("Chain verification: PASS");
    expect(text).toContain(CLEAR_PATH);

    // Existing pack files are never replaced.
    const repeat = await agentLedger(["report", "--from", from, "--to", to, "--out", outDir]);
    expect(repeat.code).toBe(1);
    expect(readFileSync(out.htmlPath, "utf8")).toBe(html);
  }, HOOK_TIMEOUT_MS);

  it("10. nothing withheld leaks: raw hashed arguments, the error text, the key and the credential are absent from the ledger, the pack and every process output", () => {
    expect(pack, "step 9 produced a pack").toBeDefined();
    const ledgerBytes = readFileSync(ledgerPath, "utf8");
    const surfaces: [string, string][] = [
      ["ledger", ledgerBytes],
      ["html", readFileSync(pack.htmlPath, "utf8")],
      ["csv", readFileSync(pack.csvPath, "utf8")],
      ["pdf", pdfText(readFileSync(pack.pdfPath))],
      ["pdf-bytes", readFileSync(pack.pdfPath).toString("latin1")],
      ["transcript", transcript.join("\n")],
    ];
    expect(transcript.length).toBeGreaterThan(10);
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
    for (const [name, text] of surfaces) {
      for (const secret of [BASH_CANARY, NOTE_CANARY, ERROR_CANARY, keyHex, credentialHex]) {
        expect(text.includes(secret), `${secret} found in ${name}`).toBe(false);
      }
    }
    // The clear field is readable in the ledger, and the withheld ones are labeled digests, never the values.
    expect(ledgerBytes).toContain(CLEAR_PATH);
    expect((ledgerBytes.match(/hmac-sha256:[0-9a-f]{64}/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

afterAll(() => {
  if (Object.keys(timings).length > 0) process.stderr.write(`e2e-slice-1b hook round trips (ms): ${JSON.stringify(timings)}\n`);
});
