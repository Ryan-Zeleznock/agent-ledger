import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Policy, PolicyRule } from "../src/policy/contract.js";
import type { PolicyDecision } from "../src/types/index.js";

// TEST-ONLY first-match-wins evaluator over the real YAML. The product evaluator, src/policy evaluate(), stays a
// stub until Gate 2 (ADR-002); when it lands, the verdict table below moves onto it and this helper goes away.
// It ignores `server` because no default rule uses it.
type Args = Record<string, unknown>;
const re = (pattern: string) => new RegExp(pattern, "i");
const argsMatch = (patterns: Record<string, string> | undefined, args: Args): boolean =>
  patterns === undefined || Object.entries(patterns).every(([k, p]) => k in args && re(p).test(String(args[k])));
function ruleMatches(rule: PolicyRule, tool: string, args: Args): boolean {
  if (rule.match.tool !== undefined && !re(rule.match.tool).test(tool)) return false;
  if (!argsMatch(rule.match.argPattern, args)) return false;
  if (rule.match.unless !== undefined && argsMatch(rule.match.unless.argPattern, args)) return false;
  return true;
}
function decide(policy: Policy, tool: string, args: Args = {}): PolicyDecision {
  const rule = policy.rules.find((r) => ruleMatches(r, tool, args));
  return rule ? { verdict: rule.verdict, risk: rule.risk, ruleId: rule.id, reason: rule.reason } : policy.defaultDecision;
}

const RISKY = ["risky-delete", "risky-payment", "risky-external-message", "risky-iam-change", "risky-prod-deploy"];

describe("policies/default.yaml", () => {
  const p = parse(readFileSync("policies/default.yaml", "utf8")) as Policy;
  const rules = p.rules;
  const ids = rules.map((r) => r.id);
  const byId = (id: string) => rules.find((r) => r.id === id)!;

  it("is version 1 with a complete default decision", () => {
    expect(p.version).toBe(1);
    expect((p as unknown as Record<string, unknown>).defaultVerdict).toBeUndefined();
    expect(p.defaultDecision).toEqual({ verdict: "allow", risk: "write", ruleId: "default", reason: "Unclassified action, logged" });
  });
  it("has unique rule ids", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("requires approval for exactly the five risky action types, and risk is risky iff approval is required", () => {
    expect(rules.filter((r) => r.verdict === "require_approval").map((r) => r.id)).toEqual(RISKY);
    for (const r of rules) expect(r.risk === "risky", r.id).toBe(r.verdict === "require_approval");
  });
  it("orders the five risky rules first, then read-only, then default-write", () => {
    expect(ids).toEqual([...RISKY, "read-only", "default-write"]);
    expect(byId("read-only")).toMatchObject({ verdict: "allow", risk: "read" });
    expect(byId("default-write")).toMatchObject({ verdict: "allow", risk: "write" });
  });
  it("keeps the destructive-verb pattern unanchored", () => {
    const tool = byId("risky-delete").match.tool!;
    for (const t of ["delete_repo", "get_and_delete_record", "list_and_remove_users", "remove_label", "purgeCache"]) expect(re(tool).test(t), t).toBe(true);
  });
  it("puts the nonprod exception on risky-prod-deploy only, as an unless, and no rule uses argPattern", () => {
    expect(rules.filter((r) => r.match.unless !== undefined).map((r) => r.id)).toEqual(["risky-prod-deploy"]);
    expect(rules.some((r) => r.match.argPattern !== undefined)).toBe(false);
    expect(ids).not.toContain("nonprod-deploy");
    const env = re(byId("risky-prod-deploy").match.unless!.argPattern.environment!);
    for (const ok of ["dev", "development", "test", "staging", "sandbox", "Staging"]) expect(env.test(ok), ok).toBe(true);
    for (const bad of ["prod", "production", "staging-prod", "", "dev2", "prod-staging"]) expect(env.test(bad), bad).toBe(false);
  });

  describe("verdict table (test-only first-match evaluator)", () => {
    const cases: [string, Args, string, string, string][] = [
      // read-prefix bypass (Astra re-review P1 #1): destructive verb later in the name still needs approval
      ["get_and_delete_record", {}, "require_approval", "risky", "risky-delete"],
      ["list_and_remove_users", {}, "require_approval", "risky", "risky-delete"],
      // nonprod exception bypass (P1 #2): the exception applies to deploys only
      ["delete_deployment", { environment: "staging" }, "require_approval", "risky", "risky-delete"],
      ["grant_deploy_permission", { environment: "dev" }, "require_approval", "risky", "risky-iam-change"],
      // deploys: missing, prod, or unknown environment requires approval; a known nonprod one is a plain write
      ["deploy_production", {}, "require_approval", "risky", "risky-prod-deploy"],
      ["deploy_app", { environment: "prod" }, "require_approval", "risky", "risky-prod-deploy"],
      ["deploy_app", { environment: "blue" }, "require_approval", "risky", "risky-prod-deploy"],
      ["merge_pull_request", {}, "require_approval", "risky", "risky-prod-deploy"],
      ["trigger_release", {}, "require_approval", "risky", "risky-prod-deploy"],
      ["deploy_app", { environment: "staging" }, "allow", "write", "default-write"],
      ["Deploy_App", { environment: "STAGING" }, "allow", "write", "default-write"],
      // read tools are never escalated by the risky rules
      ["list_roles", {}, "allow", "read", "read-only"],
      ["get_policy", {}, "allow", "read", "read-only"],
      ["describe_iam_policy", {}, "allow", "read", "read-only"],
      ["get_deploy_status", {}, "allow", "read", "read-only"],
      ["list_releases", {}, "allow", "read", "read-only"],
      ["search_payments", {}, "allow", "read", "read-only"],
      ["get_refund", {}, "allow", "read", "read-only"],
      ["list_tweets", {}, "allow", "read", "read-only"],
      // the other risky types still fire on mutating names
      ["pay_invoice", {}, "require_approval", "risky", "risky-payment"],
      ["charge_card", {}, "require_approval", "risky", "risky-payment"],
      ["create_refund", {}, "require_approval", "risky", "risky-payment"],
      ["get_and_transfer_funds", {}, "require_approval", "risky", "risky-payment"],
      ["send_email", {}, "require_approval", "risky", "risky-external-message"],
      ["post_tweet", {}, "require_approval", "risky", "risky-external-message"],
      ["attach_role_policy", {}, "require_approval", "risky", "risky-iam-change"],
      ["invite_user", {}, "require_approval", "risky", "risky-iam-change"],
      ["remove_label", {}, "require_approval", "risky", "risky-delete"], // conservative, accepted
      // writes and the default
      ["create_ticket", {}, "allow", "write", "default-write"],
      ["frobnicate", {}, "allow", "write", "default"],
    ];
    it.each(cases)("%s(%j) → %s/%s via %s", (tool, args, verdict, risk, ruleId) => {
      expect(decide(p, tool, args)).toMatchObject({ verdict, risk, ruleId });
    });
    it("frobnicate gets the full defaultDecision", () => {
      expect(decide(p, "frobnicate")).toEqual(p.defaultDecision);
    });
  });
});
