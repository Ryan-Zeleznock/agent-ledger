import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadSuggestions, suggestClass, type ToolClass } from "../src/policy/contract.js";

// Suggestions are advice during review; this table exercises the production implementation.
describe("policies/suggestions.yaml (suggestions only, never authority)", () => {
  const raw = readFileSync("policies/suggestions.yaml", "utf8");
  const rulesPromise = loadSuggestions("policies/suggestions.yaml");

  it("says so in its header", () => {
    expect(raw.split("\n")[0]).toContain("SUGGESTIONS ONLY, NEVER AUTHORITY (ADR-004)");
  });
  it("is version 1, has unique ids, and defaults to risky so unknown names get a second look", async () => {
    const rules = await rulesPromise;
    expect(rules.version).toBe(1);
    const ids = rules.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rules.default.class).toBe("risky");
  });
  it("carries no verdicts, no unless, and no argument patterns: it cannot decide anything", async () => {
    const rules = await rulesPromise;
    expect(raw).not.toMatch(/verdict|defaultDecision|unless|argPattern/);
    for (const r of rules.rules) expect(Object.keys(r).sort()).toEqual(["class", "id", "reason", "tool"]);
  });

  const cases: [string, ToolClass, string][] = [
    // the names Astra used to break the old regex authority now at least SUGGEST risky
    ["get_then_deploy", "risky", "risky-deploy"],
    ["get_then_transfer_funds", "risky", "risky-payment"],
    ["wipe_bucket", "risky", "risky-delete"],
    ["truncate_table", "risky", "risky-delete"],
    ["kill_instance", "risky", "risky-delete"],
    ["terminate_instance", "risky", "risky-delete"],
    ["undeploy_service", "risky", "risky-delete"],
    ["reply_to_email", "risky", "risky-external-message"],
    ["forward_email", "risky", "risky-external-message"],
    ["revoke_all_tokens", "risky", "risky-iam-change"],
    ["rotate_keys", "risky", "risky-iam-change"],
    ["push_to_main", "risky", "risky-deploy"],
    ["publish_package", "risky", "risky-deploy"],
    ["deploy_production", "risky", "risky-deploy"],
    ["get_and_delete_record", "risky", "risky-delete"],
    ["pay_invoice", "risky", "risky-payment"],
    ["send_email", "risky", "risky-external-message"],
    ["attach_role_policy", "risky", "risky-iam-change"],
    ["merge_pull_request", "risky", "risky-deploy"],
    // reads and writes
    ["list_roles", "read", "read-only"],
    ["get_deploy_status", "read", "read-only"],
    ["search_payments", "read", "read-only"],
    ["list_tweets", "read", "read-only"],
    ["create_ticket", "write", "write"],
    ["update_user_profile", "risky", "risky-iam-change"], // conservative: "user" after a mutating verb
    // unknown -> default risky, a reviewer must look
    ["frobnicate", "risky", "default"],
    ["deployment", "risky", "risky-deploy"], // a noun-only name still draws a risky suggestion; acceptable for advice
    ["calendar_sync", "risky", "default"],
  ];
  it.each(cases)("%s suggests %s via %s", async (tool, cls, id) => {
    const rules = await rulesPromise;
    const reason = id === "default" ? rules.default.reason : rules.rules.find(r => r.id === id)!.reason;
    expect(suggestClass({ server: "s", name: tool }, { rules, serverTrusted: false }))
      .toEqual({ class: cls, reason, sources: id === "default" ? [] : ["name-pattern"] });
  });
});
