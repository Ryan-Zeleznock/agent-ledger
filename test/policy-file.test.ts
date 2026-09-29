import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

interface Rule { id: string; match: { tool?: string; server?: string; argPattern?: Record<string, string> }; verdict: string; risk: string; reason: string; }

describe("policies/default.yaml", () => {
  const p = parse(readFileSync("policies/default.yaml", "utf8"));
  const rules: Rule[] = p.rules;
  const ids = rules.map((r) => r.id);
  const byId = (id: string) => rules.find((r) => r.id === id)!;

  it("is version 1 with a complete default decision", () => {
    expect(p.version).toBe(1);
    expect(p.defaultVerdict).toBeUndefined();
    expect(p.defaultDecision).toEqual({ verdict: "allow", risk: "write", ruleId: "default", reason: "Unclassified action, logged" });
  });
  it("requires approval for the five risky action types", () => {
    const risky = rules.filter((r) => r.verdict === "require_approval").map((r) => r.id);
    expect(risky).toEqual(["risky-delete", "risky-payment", "risky-external-message", "risky-iam-change", "risky-prod-deploy"]);
    for (const r of rules) expect(r.risk === "risky", r.id).toBe(r.verdict === "require_approval");
  });
  it("has unique rule ids", () => {
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("classifies read tools before any risky rule can escalate them", () => {
    const read = byId("read-only");
    expect(read).toMatchObject({ verdict: "allow", risk: "read" });
    expect(read.match.tool).toBe("^(get|list|read|search|describe|fetch|query)_");
    const firstRisky = rules.findIndex((r) => r.risk === "risky");
    expect(ids.indexOf("read-only")).toBeLessThan(firstRisky);
    for (const tool of ["list_roles", "get_deploy_status", "describe_iam_policy", "search_payments"]) {
      expect(new RegExp(read.match.tool!).test(tool), tool).toBe(true);
    }
  });
  it("allows only a known nonprod environment through before risky-prod-deploy", () => {
    const nonprod = byId("nonprod-deploy");
    expect(nonprod).toMatchObject({ verdict: "allow", risk: "write" });
    expect(ids.indexOf("nonprod-deploy")).toBeLessThan(ids.indexOf("risky-prod-deploy"));
    const env = new RegExp(nonprod.match.argPattern!.environment!);
    for (const ok of ["dev", "development", "test", "staging", "sandbox"]) expect(env.test(ok), ok).toBe(true);
    for (const bad of ["prod", "production", "staging-prod", "", "Prod"]) expect(env.test(bad), bad).toBe(false);
  });
  it("risky-prod-deploy has no argPattern, so a missing environment still requires approval", () => {
    const prod = byId("risky-prod-deploy");
    expect(prod.match.argPattern).toBeUndefined();
    expect(prod.match.tool).toBe(byId("nonprod-deploy").match.tool);
    expect(prod).toMatchObject({ verdict: "require_approval", risk: "risky" });
  });
});
