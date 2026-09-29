import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { SuggestionRules, ToolClass } from "../src/policy/contract.js";

// SUGGESTION TESTS. These patterns only feed policy.suggestClass during registry review (ADR-004). A wrong
// suggestion costs a reviewer a second look; it can never allow a call. The table therefore checks that the
// patterns are useful, not that they are a security boundary. Test-only first-match helper, as before.
const re = (p: string) => new RegExp(p, "i");
const suggest = (rules: SuggestionRules, tool: string): { class: ToolClass; id: string } => {
  const r = rules.rules.find((x) => re(x.tool).test(tool));
  return r ? { class: r.class, id: r.id } : { class: rules.default.class, id: "default" };
};

describe("policies/suggestions.yaml (suggestions only, never authority)", () => {
  const raw = readFileSync("policies/suggestions.yaml", "utf8");
  const rules = parse(raw) as SuggestionRules;

  it("says so in its header", () => {
    expect(raw.split("\n")[0]).toContain("SUGGESTIONS ONLY, NEVER AUTHORITY (ADR-004)");
  });
  it("is version 1, has unique ids, and defaults to risky so unknown names get a second look", () => {
    expect(rules.version).toBe(1);
    const ids = rules.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rules.default.class).toBe("risky");
  });
  it("carries no verdicts, no unless, and no argument patterns: it cannot decide anything", () => {
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
  it.each(cases)("%s suggests %s via %s", (tool, cls, id) => {
    expect(suggest(rules, tool)).toEqual({ class: cls, id });
  });
});
