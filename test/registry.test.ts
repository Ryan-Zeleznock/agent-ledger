import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { CLASS_DECISION, CLASS_RANK, TOOL_CLASSES, type Escalation, type ToolClass, type ToolEntry, type ToolRegistry } from "../src/policy/contract.js";
import type { PolicyDecision } from "../src/types/index.js";

// TEST-ONLY validator + evaluator over the real registry YAML, mirroring the contract's documented semantics. The
// product functions (src/policy loadRegistry/evaluate) stay stubs until Gate 2 (ADR-002); when they land, the
// tables below move onto them and these helpers go away (test/todo/policy.todo.md).
type Args = Record<string, unknown>;
const re = (p: string) => new RegExp(p, "i");
const argsMatch = (patterns: Record<string, string>, args: Args) =>
  Object.entries(patterns).every(([k, p]) => k in args && re(p).test(String(args[k])));
const isClass = (c: unknown): c is ToolClass => (TOOL_CLASSES as readonly unknown[]).includes(c);

/** Schema check for the invariant "nothing downgrades": returns the problems a loader would refuse on. */
function validate(reg: ToolRegistry): string[] {
  const problems: string[] = [];
  if (reg.version !== 1) problems.push("version");
  for (const [server, s] of Object.entries(reg.servers)) {
    if (typeof s.trusted !== "boolean") problems.push(`${server}: trusted`);
    for (const [tool, t] of Object.entries(s.tools)) {
      const at = `${server}/${tool}`;
      if (!isClass(t.class)) problems.push(`${at}: class`);
      if (!t.reviewedBy || !t.reviewedAt) problems.push(`${at}: review`);
      for (const [i, e] of (t.escalateWhen ?? []).entries()) {
        if (!isClass(e.to) || !isClass(t.class) || CLASS_RANK[e.to] <= CLASS_RANK[t.class]) problems.push(`${at}#escalate:${i}: to must rank above ${t.class}`);
      }
    }
  }
  return problems;
}

function decide(reg: ToolRegistry, server: string, tool: string, args: Args = {}): PolicyDecision {
  const row: ToolEntry | undefined = reg.servers[server]?.tools[tool];
  if (!row) return { verdict: "require_approval", risk: "unreviewed", ruleId: `unreviewed:${server}/${tool}`, reason: "Tool not in the reviewed registry" };
  let cls: ToolClass = row.class;
  let ruleId = `registry:${server}/${tool}`;
  for (const [i, e] of (row.escalateWhen ?? []).entries()) {
    if (argsMatch(e.argPattern, args) && CLASS_RANK[e.to] > CLASS_RANK[cls]) { cls = e.to; ruleId = `registry:${server}/${tool}#escalate:${i}`; }
  }
  return { ...CLASS_DECISION[cls], ruleId, reason: row.note ?? `Reviewed ${cls} by ${row.reviewedBy}` };
}

const registry = parse(readFileSync("policies/tools.example.yaml", "utf8")) as ToolRegistry;

describe("policies/tools.example.yaml (ADR-004 registry)", () => {
  it("parses as version 1 with the github and claude-code servers", () => {
    expect(registry.version).toBe(1);
    expect(Object.keys(registry.servers).sort()).toEqual(["claude-code", "github"]);
    expect(registry.servers["github"]!.trusted).toBe(true);
  });
  it("every row has a reviewer, a date, and a known class; the example validates", () => {
    expect(validate(registry)).toEqual([]);
    for (const s of Object.values(registry.servers)) for (const t of Object.values(s.tools)) {
      expect(t.reviewedBy).toBe("ryan");
      expect(t.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it("classifies the example rows as documented", () => {
    const gh = registry.servers["github"]!.tools, cc = registry.servers["claude-code"]!.tools;
    expect(gh["list_repos"]!.class).toBe("read");
    expect(gh["create_issue"]!.class).toBe("write");
    expect(gh["delete_repo"]!.class).toBe("risky");
    expect(gh["merge_pull_request"]!.class).toBe("risky");
    for (const t of ["Read", "Grep", "Glob", "WebFetch"]) expect(cc[t]!.class, t).toBe("read");
    for (const t of ["Edit", "Write"]) expect(cc[t]!.class, t).toBe("write");
    expect(cc["Bash"]!.class).toBe("risky");
    expect(cc["Bash"]!.note).toMatch(/shell/i);
  });
  it("uses only the class-to-decision mapping the contract exports", () => {
    expect(CLASS_DECISION).toEqual({
      read: { verdict: "allow", risk: "read" },
      write: { verdict: "allow", risk: "write" },
      risky: { verdict: "require_approval", risk: "risky" },
    });
    expect(CLASS_RANK.read).toBeLessThan(CLASS_RANK.write);
    expect(CLASS_RANK.write).toBeLessThan(CLASS_RANK.risky);
  });

  describe("schema rejects downgrades (the loader refuses these registries)", () => {
    const withEscalation = (cls: ToolClass, to: Escalation["to"]): ToolRegistry => ({
      version: 1,
      servers: { s: { trusted: false, tools: { t: { class: cls, reviewedBy: "ryan", reviewedAt: "2026-09-29", escalateWhen: [{ argPattern: { env: "dev" }, to }] } } } },
    });
    it("write -> write is refused (no-op escalation)", () => { expect(validate(withEscalation("write", "write"))).toEqual(["s/t#escalate:0: to must rank above write"]); });
    it("risky -> write is refused (would lower)", () => { expect(validate(withEscalation("risky", "write"))).toEqual(["s/t#escalate:0: to must rank above risky"]); });
    it("risky -> risky is refused", () => { expect(validate(withEscalation("risky", "risky")).length).toBe(1); });
    it("`to: read` is not a legal escalation target at all", () => {
      const bad = withEscalation("write", "read" as unknown as Escalation["to"]);
      expect(validate(bad).length).toBe(1);
    });
    it("read -> write and write -> risky are accepted", () => {
      expect(validate(withEscalation("read", "write"))).toEqual([]);
      expect(validate(withEscalation("write", "risky"))).toEqual([]);
    });
    it("a row without reviewer or date is refused", () => {
      const r: ToolRegistry = { version: 1, servers: { s: { trusted: true, tools: { t: { class: "read", reviewedBy: "", reviewedAt: "" } } } } };
      expect(validate(r)).toEqual(["s/t: review"]);
    });
  });

  describe("decision table (test-only evaluator)", () => {
    const cases: [string, string, Args, string, string, string][] = [
      // unknown server -> unreviewed
      ["aws", "list_buckets", {}, "require_approval", "unreviewed", "unreviewed:aws/list_buckets"],
      // unknown tool on a known server -> unreviewed, even when the server is trusted
      ["github", "list_branches", {}, "require_approval", "unreviewed", "unreviewed:github/list_branches"],
      ["claude-code", "NotebookEdit", {}, "require_approval", "unreviewed", "unreviewed:claude-code/NotebookEdit"],
      // reviewed rows
      ["github", "list_repos", {}, "allow", "read", "registry:github/list_repos"],
      ["github", "create_issue", {}, "allow", "write", "registry:github/create_issue"],
      ["github", "delete_repo", {}, "require_approval", "risky", "registry:github/delete_repo"],
      ["github", "merge_pull_request", { environment: "dev" }, "require_approval", "risky", "registry:github/merge_pull_request"],
      ["claude-code", "Read", {}, "allow", "read", "registry:claude-code/Read"],
      ["claude-code", "Edit", {}, "allow", "write", "registry:claude-code/Edit"],
      ["claude-code", "Bash", { command: "ls" }, "require_approval", "risky", "registry:claude-code/Bash"],
      // escalation raises write -> risky when every pattern matches; otherwise the base class stands
      ["github", "update_branch_protection", { branch: "main" }, "require_approval", "risky", "registry:github/update_branch_protection#escalate:0"],
      ["github", "update_branch_protection", { branch: "release/1.2" }, "require_approval", "risky", "registry:github/update_branch_protection#escalate:0"],
      ["github", "update_branch_protection", { branch: "feature/x" }, "allow", "write", "registry:github/update_branch_protection"],
      ["github", "update_branch_protection", {}, "allow", "write", "registry:github/update_branch_protection"],
      // Astra round-2 bypass names: unreviewed, so never allowed, whatever the arguments say
      ["deploy", "get_then_deploy", { environment: "production" }, "require_approval", "unreviewed", "unreviewed:deploy/get_then_deploy"],
      ["s3", "wipe_bucket", {}, "require_approval", "unreviewed", "unreviewed:s3/wipe_bucket"],
      ["ec2", "terminate_instance", {}, "require_approval", "unreviewed", "unreviewed:ec2/terminate_instance"],
      ["github", "push_to_main", {}, "require_approval", "unreviewed", "unreviewed:github/push_to_main"],
      ["deploy", "deploy_production", { environment: "dev" }, "require_approval", "unreviewed", "unreviewed:deploy/deploy_production"],
      ["deploy", "deploy_app", { environment: "dev", target: "prod" }, "require_approval", "unreviewed", "unreviewed:deploy/deploy_app"],
      ["mail", "get_then_transfer_funds", {}, "require_approval", "unreviewed", "unreviewed:mail/get_then_transfer_funds"],
      ["mail", "reply_to_email", {}, "require_approval", "unreviewed", "unreviewed:mail/reply_to_email"],
    ];
    it.each(cases)("%s/%s(%j) → %s/%s via %s", (server, tool, args, verdict, risk, ruleId) => {
      expect(decide(registry, server, tool, args)).toMatchObject({ verdict, risk, ruleId });
    });
    it("no unreviewed call is ever allowed", () => {
      for (const [server, tool, args] of cases) {
        const d = decide(registry, server, tool, args);
        if (d.risk === "unreviewed") expect(d.verdict, `${server}/${tool}`).toBe("require_approval");
      }
    });
    it("the evaluator ignores an escalation that would lower the class, even if one slipped past the loader", () => {
      const reg: ToolRegistry = { version: 1, servers: { s: { trusted: true, tools: { t: { class: "risky", reviewedBy: "ryan", reviewedAt: "2026-09-29", escalateWhen: [{ argPattern: { environment: "^dev$" }, to: "write" }] } } } } };
      expect(validate(reg).length).toBe(1);
      expect(decide(reg, "s", "t", { environment: "dev" })).toMatchObject({ verdict: "require_approval", risk: "risky", ruleId: "registry:s/t" });
    });
  });
});
