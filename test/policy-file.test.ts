import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

describe("policies/default.yaml", () => {
  const p = parse(readFileSync("policies/default.yaml", "utf8"));
  it("is version 1 with a default verdict", () => {
    expect(p.version).toBe(1);
    expect(p.defaultVerdict).toBe("allow");
  });
  it("requires approval for the five risky action types", () => {
    const ids = p.rules.filter((r: { verdict: string }) => r.verdict === "require_approval").map((r: { id: string }) => r.id);
    expect(ids).toEqual(["risky-delete", "risky-payment", "risky-external-message", "risky-iam-change", "risky-prod-deploy"]);
  });
  it("has unique rule ids", () => {
    const ids = p.rules.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
