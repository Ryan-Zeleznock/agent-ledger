import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { ToolRegistry } from "../src/policy/contract.js";
import { SLACK_HOOK_TIMING, DEFAULT_HOOK_TIMING } from "../src/hooks/contract.js";
import { BUILTIN_CODEX_SERVER, CODEX_MCP_NOT_PROXIED_REASON, CODEX_PROXY_SERVER_NAME_MIN_LENGTH, CODEX_PROXY_SERVER_NAME_RE } from "../src/types/index.js";
import { checkHookTiming, codexHookToolName, decide, routeCodexHookCall, validate } from "./helpers/registry-eval.js";

// ADR-006 through the TEST-ONLY helpers (ADR-002: product functions stay stubs). The Codex naming helper mirrors
// openai/codex source read 2026-09-29 (sanitize → collision hash → trim `_` at the `__` join → `mcp__` prefix).
const registry = parse(readFileSync("policies/tools.example.yaml", "utf8")) as ToolRegistry;
const PROXY = registry.proxy!.codex!.serverName;

describe("Codex MCP identity (ADR-006; Astra P1 2026-09-29)", () => {
  it("the example registry names the proxy in Codex's hook-visible form and validates", () => {
    expect(validate(registry)).toEqual([]);
    expect(PROXY).toMatch(CODEX_PROXY_SERVER_NAME_RE);
    expect(PROXY.length).toBeGreaterThanOrEqual(CODEX_PROXY_SERVER_NAME_MIN_LENGTH);
    expect(codexHookToolName(PROXY, "list_repos")).toBe(`mcp__${PROXY}__list_repos`);
  });

  it("Astra's collision: github_/list_repos and github/_list_repos fire the SAME hook name", () => {
    const a = codexHookToolName("github_", "list_repos");
    const b = codexHookToolName("github", "_list_repos");
    const c = codexHookToolName("github", "list_repos");
    expect(a).toBe("mcp__github__list_repos");
    expect(b).toBe(a);
    expect(c).toBe(a);
    // a reviewed `github/list_repos` read row exists, yet under Codex the hook name never reaches it
    expect(decide(registry, "github", "list_repos")).toMatchObject({ verdict: "allow", risk: "read" });
    for (const name of [a, b, c]) {
      const route = routeCodexHookCall(name, PROXY);
      expect(route.kind).toBe("deny-not-proxied");
      expect(route.kind === "deny-not-proxied" && route.decision).toBe("deny");
      expect(route.kind === "deny-not-proxied" && route.ruleId).toBe("codex-mcp-not-proxied:github/list_repos");
      expect(route.kind === "deny-not-proxied" && route.reason).toBe(CODEX_MCP_NOT_PROXIED_REASON);
    }
  });

  it.each(["mcp__x__y", "mcp__github__create_issue", "mcp__filesystem__read_file", "mcp__brave_search__search", "mcp__plugin_db__query"])(
    "a non-proxy MCP call %s under Codex is denied whatever the registry says, with the routing reason", (name) => {
      const route = routeCodexHookCall(name, PROXY);
      expect(route).toMatchObject({ kind: "deny-not-proxied", decision: "deny" });
      expect(route.kind === "deny-not-proxied" && route.reason).toMatch(/route this MCP server through the Agent Ledger proxy/);
    });

  it("a call to one of the proxy's tools is allow + governed-by-proxy: the proxy decided and recorded it, the hook writes nothing", () => {
    for (const tool of ["list_repos", "delete_repo", "anything_at_all"]) {
      expect(routeCodexHookCall(`mcp__${PROXY}__${tool}`, PROXY)).toEqual({ kind: "governed-by-proxy", decision: "allow" });
    }
  });

  it("with no proxy configured every Codex MCP call is denied, including the would-be proxy name", () => {
    expect(routeCodexHookCall(`mcp__${PROXY}__list_repos`, undefined)).toMatchObject({ kind: "deny-not-proxied" });
    expect(routeCodexHookCall("mcp__github__list_repos", undefined)).toMatchObject({ kind: "deny-not-proxied" });
  });

  it("built-ins still land on builtin:codex and go to the registry, untouched by the proxy rule", () => {
    expect(routeCodexHookCall("Bash", PROXY)).toEqual({ kind: "builtin", server: BUILTIN_CODEX_SERVER, tool: "Bash" });
    expect(routeCodexHookCall("apply_patch", PROXY)).toEqual({ kind: "builtin", server: BUILTIN_CODEX_SERVER, tool: "apply_patch" });
    expect(decide(registry, BUILTIN_CODEX_SERVER, "Bash")).toMatchObject({ verdict: "require_approval", risk: "risky" });
  });

  it("RESIDUAL, stated: a local server named <proxy>_ or <proxy>- yields the proxy's hook names; only the managed mcp_servers allowlist closes it", () => {
    // codex-rs trims trailing `_` at the join, so these impersonators are indistinguishable from the proxy by name alone
    for (const impostor of [`${PROXY}_`, `${PROXY}-`, `${PROXY}__`]) {
      expect(codexHookToolName(impostor, "delete_repo")).toBe(`mcp__${PROXY}__delete_repo`);
      expect(routeCodexHookCall(codexHookToolName(impostor, "delete_repo"), PROXY)).toMatchObject({ kind: "governed-by-proxy" });
    }
    // a name that collides only after sanitising (`-` → `_`) is the same story: requirements.toml identity, not the name, is the guard
    expect(codexHookToolName(PROXY.replace(/_/g, "-"), "x")).toBe(codexHookToolName(PROXY, "x"));
  });

  describe("proxy.codex.serverName validation (the loader refuses these)", () => {
    const withProxy = (serverName: string): ToolRegistry => ({ ...registry, proxy: { codex: { serverName } } });
    it("accepts a long, alphanumeric-with-underscore name that is not an upstream key", () => {
      expect(validate(withProxy("agentledger_proxy_7f3a9c2e1b04"))).toEqual([]);
    });
    it.each([
      ["trailing underscore (Codex trims it: could never match itself)", "agentledger_proxy_7f3a9c2e1b_"],
      ["leading underscore", "_agentledger_proxy_7f3a9c2e1b"],
      ["hyphen (not Codex's sanitised form)", "agentledger-proxy-7f3a9c2e1b04"],
      ["colon", "agentledger:proxy:7f3a9c2e1b04"],
    ])("refuses %s", (_why, name) => {
      expect(validate(withProxy(name))).toContain("proxy.codex.serverName: must be [A-Za-z0-9_] with no leading or trailing _ (Codex trims those)");
    });
    it("refuses a short (guessable) name", () => {
      expect(validate(withProxy("proxy"))).toContain(`proxy.codex.serverName: shorter than ${CODEX_PROXY_SERVER_NAME_MIN_LENGTH}`);
      expect(validate(withProxy("agentledger"))).toContain(`proxy.codex.serverName: shorter than ${CODEX_PROXY_SERVER_NAME_MIN_LENGTH}`);
    });
    it("refuses a name that normalises to a builtin namespace", () => {
      expect(validate(withProxy("builtin_codex_proxy_0000"))).toEqual([]); // honest: `builtincodexproxy0000` is not reserved
      expect(validate(withProxy("builtin_codex"))).toContain("proxy.codex.serverName: collides with the builtin namespace");
    });
    it("refuses a name equal (case-insensitively) to an upstream servers key", () => {
      const r: ToolRegistry = { ...registry, servers: { ...registry.servers, agentledger_proxy_7f3a9c2e1b04: { trusted: false, tools: {} } }, proxy: { codex: { serverName: "AgentLedger_Proxy_7f3a9c2e1b04" } } };
      expect(validate(r)).toContain("proxy.codex.serverName: equals a servers key (the proxy is not an upstream)");
    });
    it("refuses proxy.codex without a serverName", () => {
      expect(validate({ ...registry, proxy: { codex: {} as { serverName: string } } })).toContain("proxy.codex.serverName: missing");
    });
  });
});

describe("hook timing invariants: approval < watchdog deadline < hook timeout (ADR-006)", () => {
  it("both shipped profiles are valid", () => {
    expect(checkHookTiming(DEFAULT_HOOK_TIMING)).toEqual([]);
    expect(checkHookTiming(SLACK_HOOK_TIMING)).toEqual([]);
  });
  it("an approval timeout that leaves less than the margin before the deadline is refused", () => {
    expect(checkHookTiming({ approvalTimeoutMs: 306_000, deadlineMs: 310_000, hookTimeoutS: 320 })).toEqual(["approval-not-below-deadline"]);
    expect(checkHookTiming({ approvalTimeoutMs: 310_000, deadlineMs: 310_000, hookTimeoutS: 320 })).toEqual(["approval-not-below-deadline"]);
    expect(checkHookTiming({ approvalTimeoutMs: 305_000, deadlineMs: 310_000, hookTimeoutS: 320 })).toEqual([]); // exactly the margin is fine
  });
  it("a deadline that leaves less than the margin before the hook timeout is refused", () => {
    expect(checkHookTiming({ deadlineMs: 319_000, hookTimeoutS: 320 })).toEqual(["deadline-not-below-hook-timeout"]);
    expect(checkHookTiming({ deadlineMs: 30_000, hookTimeoutS: 30 })).toEqual(["deadline-not-below-hook-timeout"]);
    expect(checkHookTiming({ deadlineMs: 28_000, hookTimeoutS: 30 })).toEqual([]);
  });
  it("the Slack default under the no-Slack deadline is refused: the handler cannot wait longer than the watchdog lets it", () => {
    expect(checkHookTiming({ approvalTimeoutMs: SLACK_HOOK_TIMING.approvalTimeoutMs, deadlineMs: DEFAULT_HOOK_TIMING.deadlineMs, hookTimeoutS: DEFAULT_HOOK_TIMING.hookTimeoutS }))
      .toEqual(["approval-not-below-deadline"]);
  });
  it.each([NaN, Infinity, 0, -1, 1.5])("a deadline of %s is refused before the margins are even checked", (deadlineMs) => {
    expect(checkHookTiming({ deadlineMs, hookTimeoutS: 30 })).toEqual(["deadlineMs"]);
  });
  it("a bad approval timeout or hook timeout is named", () => {
    expect(checkHookTiming({ approvalTimeoutMs: 0, deadlineMs: 25_000, hookTimeoutS: 30 })).toEqual(["approvalTimeoutMs"]);
    expect(checkHookTiming({ deadlineMs: 25_000, hookTimeoutS: 0.5 })).toEqual(["hookTimeoutS"]);
  });
  it("both violations are reported together", () => {
    expect(checkHookTiming({ approvalTimeoutMs: 400_000, deadlineMs: 319_000, hookTimeoutS: 320 })).toEqual(["approval-not-below-deadline", "deadline-not-below-hook-timeout"]);
  });
});
