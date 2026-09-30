import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLedger } from "../src/ledger/contract.js";
import { createAnchor } from "../src/anchor/contract.js";
import { unsealed } from "./helpers/ledger-fixtures.js";

const dirs: string[] = [];
const cli = resolve("dist/cli/main.js");
beforeAll(() => { execFileSync("npm", ["run", "build"], { stdio: "pipe" }); });
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function sandbox() { const d = await mkdtemp(join(tmpdir(), "cli-process-")); dirs.push(d); return d; }
function run(cwd: string, args: string[], input = "") { return spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: "utf8", timeout: 10_000 }); }

describe("built CLI in real processes", () => {
  it("runs init, prints settings, verifies and exports a real directly-written ledger", async () => {
    const cwd = await sandbox(); const dir = join(cwd, ".agent-ledger");
    expect(run(cwd, ["init"]).status).toBe(0);
    const bin = spawnSync(cli, ["verify"], { cwd, encoding: "utf8", timeout: 10_000 });
    expect(bin.status, String(bin.error)).toBe(3);
    const snippet = run(cwd, ["install-hooks", "--print"]);
    expect(snippet.status).toBe(0); expect(Object.keys(JSON.parse(snippet.stdout).hooks)).toHaveLength(3);
    const empty = run(cwd, ["verify"]); expect(empty.status).toBe(3); expect(JSON.parse(empty.stdout).chain).toEqual({ ok: true, checked: 0 });
    const ledger = createLedger("jsonl", join(dir, "ledger/records.jsonl"));
    const intent = unsealed(1, { command: `hmac-sha256:${"f".repeat(64)}` });
    intent.call.tool = "Bash"; intent.policy = { verdict: "require_approval", risk: "risky", ruleId: "registry:builtin:claude-code/Bash", reason: "Reviewed risky shell" };
    intent.approval = { callId: intent.call.callId, channel: "hook-ask", decision: "delegated", decidedAt: new Date().toISOString() };
    const first = await ledger.append(intent);
    await createAnchor("file", join(dir, "anchors.jsonl")).write({ hash: first.hash, at: new Date().toISOString() });
    await ledger.append({ ...intent, id: "outcome-1", phase: "outcome", outcome: { status: "ok" } });
    const verified = run(cwd, ["verify"]); expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).chain).toEqual({ ok: true, checked: 2 }); expect(JSON.parse(verified.stdout).anchor.status).toBe("ancestor");
    const report = run(cwd, ["report", "--from", "2020-01-01T00:00:00Z", "--to", "2090-01-01T00:00:00Z", "--out", "pack"]);
    expect(report.status, report.stderr).toBe(0); const files = JSON.parse(report.stdout);
    const html = await readFile(files.htmlPath, "utf8"); expect(html).toContain("2 records"); expect(html).toContain("Chain verification: PASS"); expect(html).toContain("CC8.1");
    const csv = await readFile(files.csvPath, "utf8"); expect(csv.trim().split(/\r?\n/)).toHaveLength(3); expect(csv).not.toContain("hmac-sha256:");
    expect((await readFile(files.pdfPath)).subarray(0, 8).toString()).toBe("%PDF-1.4");
    // A report must not change the evidence ledger or append an anchor while verifying.
    expect(await ledger.verify()).toEqual({ ok: true, checked: 2 });
  });
  it("returns failure for a truncated chain whose remembered anchor is no longer present", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    const path = join(cwd, ".agent-ledger/ledger/records.jsonl"); const ledger = createLedger("jsonl", path);
    await ledger.append(unsealed(1)); const prefix = await readFile(path);
    const last = await ledger.append(unsealed(2));
    await createAnchor("file", join(cwd, ".agent-ledger/anchors.jsonl")).write({ hash: last.hash, at: new Date().toISOString() });
    await writeFile(path, prefix);
    const r = run(cwd, ["verify"]); expect(r.status).toBe(1); expect(JSON.parse(r.stdout).anchor.status).toBe("mismatch");
  });
  it("fails pre on unimplemented adapters and keeps direct post non-blocking", async () => {
    const cwd = await sandbox(); expect(run(cwd, ["init"]).status).toBe(0);
    for (const event of ["pre", "post"]) {
      const r = run(cwd, ["hook", "--agent", "claude-code", "--event", event], "invalid fixture");
      expect(r.status).toBe(event === "post" ? 0 : 1); expect(r.stdout).toBe(""); expect(r.stderr).not.toBe("");
    }
  });
  it("prints post commands that survive shell quoting of a hostile-looking sandbox path", async () => {
    const cwd = await sandbox(); const dir = join(cwd, "quote' space $HOME `echo nope`");
    expect(run(cwd, ["init", "--dir", dir]).status).toBe(0);
    const snippet = JSON.parse(run(cwd, ["install-hooks", "--print", "--dir", dir]).stdout);
    const command = snippet.hooks.PostToolUse[0].hooks[0].command;
    const r = spawnSync("/bin/sh", ["-c", command], { cwd, input: "{}", encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0); expect(r.stdout).toBe(""); expect(r.stderr).toContain("post outcome was not recorded");
  });
});
