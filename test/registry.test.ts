import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { clearArgFields, evaluate, loadRegistry, CLASS_DECISION, CLASS_RANK, type Escalation, type ToolClass, type ToolRegistry } from "../src/policy/contract.js";
import { BUILTIN_CODEX_SERVER, BUILTIN_SERVER, BUILTIN_SERVER_KEYS, MCP_SERVER_NAME_RE, RESERVED_KEYS, RESERVED_SERVER_NAMES } from "../src/types/index.js";
import { decide as helperDecide, isReservedKey, isReservedServerName, normalise, splitToolName, validate, type Args } from "./helpers/registry-eval.js";

// Real policy owns the decision table; retain the helper as an independent parity oracle.
const registry = await loadRegistry("policies/tools.example.yaml");
const decide: typeof helperDecide = (registry, server, tool, args = {}) => evaluate(registry, {
  callId: "test", sessionId: "session", agentId: "agent", receivedAt: "2026-09-30T00:00:00Z", server, tool, args,
});
const row = (cls: ToolClass = "read", extra: object = {}) => ({ class: cls, reviewedBy: "ryan", reviewedAt: "2026-09-29", ...extra });
const reg = (servers: ToolRegistry["servers"]): ToolRegistry => ({ version: 1, servers });

describe("policies/tools.example.yaml (ADR-004 registry)", () => {
  it("parses as version 1 with the github server and the two builtin pseudo-servers (Claude Code, Codex)", () => {
    expect(registry.version).toBe(1);
    expect(Object.keys(registry.servers).sort()).toEqual([BUILTIN_SERVER, BUILTIN_CODEX_SERVER, "github"]);
    expect(BUILTIN_SERVER).toBe("builtin:claude-code");
    expect(BUILTIN_CODEX_SERVER).toBe("builtin:codex");
    expect(BUILTIN_SERVER_KEYS).toEqual(["builtin:claude-code", "builtin:codex"]);
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
    const gh = registry.servers["github"]!.tools, cc = registry.servers[BUILTIN_SERVER]!.tools;
    expect(gh["list_repos"]!.class).toBe("read");
    expect(gh["create_issue"]!.class).toBe("write");
    expect(gh["delete_repo"]!.class).toBe("risky");
    expect(gh["merge_pull_request"]!.class).toBe("risky");
    for (const t of ["Read", "Grep", "Glob", "WebFetch"]) expect(cc[t]!.class, t).toBe("read");
    for (const t of ["Edit", "Write"]) expect(cc[t]!.class, t).toBe("write");
    expect(cc["Bash"]!.class).toBe("risky");
    expect(cc["Bash"]!.note).toMatch(/shell/i);
    // Codex (ADR-005): names as Codex's hooks send them; Edit/Write are matcher aliases, the event says apply_patch
    const cx = registry.servers[BUILTIN_CODEX_SERVER]!.tools;
    expect(Object.keys(cx).sort()).toEqual(["Bash", "apply_patch", "update_plan"]);
    expect(cx["update_plan"]!.class).toBe("read");
    expect(cx["apply_patch"]!.class).toBe("write");
    expect(cx["Bash"]!.class).toBe("risky");
    expect(cx["Bash"]!.note).toMatch(/cannot "ask"/);
    for (const alias of ["Edit", "Write"]) expect(alias in cx, alias).toBe(false);
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
  it.each([
    ["github", "list_repos", ["owner"]],
    ["github", "create_issue", ["owner", "repo", "title"]],
    [BUILTIN_SERVER, "Read", ["file_path"]],
    [BUILTIN_SERVER, "Bash", []],
    [BUILTIN_CODEX_SERVER, "Bash", []],
  ] as const)("declares clear argument fields for %s/%s (ADR-009)", (server, tool, fields) => {
    expect(registry.servers[server]!.tools[tool]!.storeArgs).toEqual(fields);
    expect(clearArgFields(registry, server, tool)).toEqual(fields);
  });

  describe("schema rejects downgrades (the loader refuses these registries)", () => {
    const withEscalation = (cls: ToolClass, to: Escalation["to"]) => reg({ s: { trusted: false, tools: { t: row(cls, { escalateWhen: [{ argPattern: { env: "dev" }, to }] }) } } });
    it("write -> write is refused (no-op escalation)", () => { expect(validate(withEscalation("write", "write"))).toEqual(["s/t#escalate:0: to must rank above write"]); });
    it("risky -> write is refused (would lower)", () => { expect(validate(withEscalation("risky", "write"))).toEqual(["s/t#escalate:0: to must rank above risky"]); });
    it("risky -> risky is refused", () => { expect(validate(withEscalation("risky", "risky")).length).toBe(1); });
    it("`to: read` is not a legal escalation target at all", () => {
      expect(validate(withEscalation("write", "read" as unknown as Escalation["to"])).length).toBe(1);
    });
    it("read -> write and write -> risky are accepted", () => {
      expect(validate(withEscalation("read", "write"))).toEqual([]);
      expect(validate(withEscalation("write", "risky"))).toEqual([]);
    });
    it("a row without reviewer or date is refused", () => {
      expect(validate(reg({ s: { trusted: true, tools: { t: { class: "read", reviewedBy: "", reviewedAt: "" } } } }))).toEqual(["s/t: review"]);
    });
  });

  describe("schema rejects identity tricks (Astra spec v2 findings 1 and 3)", () => {
    it("the builtin namespace uses a separator MCP server names cannot contain", () => {
      expect(BUILTIN_SERVER).toContain(":");
      expect(MCP_SERVER_NAME_RE.test(BUILTIN_SERVER)).toBe(false);
      for (const ok of ["github", "brave-search", "plugin_my-plugin_db", "GitHub", "a_b-c9"]) expect(MCP_SERVER_NAME_RE.test(ok), ok).toBe(true);
      for (const bad of ["builtin:claude-code", "my server", "a.b", "x/y", ""]) expect(MCP_SERVER_NAME_RE.test(bad), bad).toBe(false);
    });
    it.each([
      "claude-code", "Claude-Code", "claude_code", "CLAUDE_CODE", "builtin_claude-code", "builtin-claude-code", "builtin:claude-code", "claudecode",
      // ADR-005: the Codex namespace is reserved the same way, and `builtin_codex` is exactly what Codex's sanitiser makes of `builtin:codex`
      "codex", "Codex", "CODEX", "builtin_codex", "builtin-codex", "builtin:codex", "builtincodex",
    ])("an MCP server key %s collides with a builtin namespace and is refused", (name) => {
      expect(isReservedServerName(name)).toBe(true);
      if (!(BUILTIN_SERVER_KEYS as readonly string[]).includes(name)) {
        expect(validate(reg({ [name]: { trusted: true, tools: { Read: row() } } }))).toContain(`${name}: collides with the builtin namespace`);
      }
    });
    it("normalisation is lowercase + strip non-alphanumerics, and honest names survive it", () => {
      expect(normalise("Builtin:Claude-Code")).toBe("builtinclaudecode");
      expect(normalise("builtin_codex")).toBe("builtincodex");
      expect(RESERVED_SERVER_NAMES).toEqual(["claudecode", "builtinclaudecode", "codex", "builtincodex"]);
      for (const ok of ["github", "claude-code-helper", "codex-helper", "codex_tools", "builtin-tools", "builtin_codex_a1b2c3"]) expect(isReservedServerName(ok), ok).toBe(false);
    });
    it("only the two exact builtin keys may contain a colon", () => {
      expect(validate(reg({ [BUILTIN_SERVER]: { trusted: true, tools: { Read: row() } } }))).toEqual([]);
      expect(validate(reg({ [BUILTIN_CODEX_SERVER]: { trusted: true, tools: { Bash: row("risky") } } }))).toEqual([]);
      expect(validate(reg({ "builtin:cursor": { trusted: true, tools: { Read: row() } } }))).toEqual(["builtin:cursor: not an MCP server name"]);
      expect(validate(reg({ "Builtin:claude-code": { trusted: true, tools: { Read: row() } } }))).toEqual([
        "Builtin:claude-code: not an MCP server name", "Builtin:claude-code: collides with the builtin namespace",
      ]);
      expect(validate(reg({ "Builtin:codex": { trusted: true, tools: { Bash: row() } } }))).toEqual([
        "Builtin:codex: not an MCP server name", "Builtin:codex: collides with the builtin namespace",
      ]);
    });
    it("a Codex sanitiser output with a collision hash suffix is its own unreviewed server, never a builtin", () => {
      // codex-rs appends a hash when two raw namespaces sanitise to the same string; the result is not reserved and not a builtin key
      expect(validate(reg({ builtin_codex_a1b2c3: { trusted: true, tools: { Bash: row("read") } } }))).toEqual([]);
      expect(decide(registry, "builtin_codex_a1b2c3", "Bash")).toMatchObject({ verdict: "require_approval", risk: "unreviewed" });
    });
    it("two server keys or two tool keys that differ only by case are refused; lookups stay case-sensitive", () => {
      expect(validate(reg({ github: { trusted: true, tools: { list_repos: row() } }, GitHub: { trusted: true, tools: { x: row() } } })))
        .toEqual(["GitHub: differs only by case from github"]);
      expect(validate(reg({ s: { trusted: true, tools: { Read: row(), read: row("risky") } } }))).toEqual(["s/read: differs only by case from Read"]);
      expect(decide(registry, "GitHub", "list_repos")).toMatchObject({ verdict: "require_approval", risk: "unreviewed", ruleId: "unreviewed:GitHub/list_repos" });
      expect(decide(registry, "github", "List_Repos")).toMatchObject({ verdict: "require_approval", risk: "unreviewed" });
    });
    it.each([...RESERVED_KEYS, "toString", "hasOwnProperty", "valueOf"])("%s is refused as a server key and as a tool key", (key) => {
      expect(isReservedKey(key)).toBe(true);
      expect(validate(reg({ [key]: { trusted: true, tools: { t: row() } } }))).toContain(`${key}: reserved key`);
      expect(validate(reg({ s: { trusted: true, tools: { [key]: row() } } }))).toContain(`s/${key}: reserved key`);
    });
    it("a YAML `__proto__` server parses as an own property (yaml 2.9.1) and is still refused", () => {
      const r = parse("version: 1\nservers:\n  __proto__:\n    trusted: true\n    tools: { t: { class: read, reviewedBy: ryan, reviewedAt: 2026-09-29 } }\n") as ToolRegistry;
      expect(Object.hasOwn(r.servers, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(r.servers)).toBe(Object.prototype);
      expect(validate(r)).toContain("__proto__: reserved key");
    });
  });

  describe("decision table (real evaluator)", () => {
    const cases: [string, string, Args, string, string, string][] = [
      // unknown server -> unreviewed
      ["aws", "list_buckets", {}, "require_approval", "unreviewed", "unreviewed:aws/list_buckets"],
      // unknown tool on a known server -> unreviewed, even when the server is trusted
      ["github", "list_branches", {}, "require_approval", "unreviewed", "unreviewed:github/list_branches"],
      [BUILTIN_SERVER, "NotebookEdit", {}, "require_approval", "unreviewed", "unreviewed:builtin:claude-code/NotebookEdit"],
      // reviewed rows
      ["github", "list_repos", {}, "allow", "read", "registry:github/list_repos"],
      ["github", "create_issue", {}, "allow", "write", "registry:github/create_issue"],
      ["github", "delete_repo", {}, "require_approval", "risky", "registry:github/delete_repo"],
      ["github", "merge_pull_request", { environment: "dev" }, "require_approval", "risky", "registry:github/merge_pull_request"],
      [BUILTIN_SERVER, "Read", {}, "allow", "read", "registry:builtin:claude-code/Read"],
      [BUILTIN_SERVER, "Edit", {}, "allow", "write", "registry:builtin:claude-code/Edit"],
      [BUILTIN_SERVER, "Bash", { command: "ls" }, "require_approval", "risky", "registry:builtin:claude-code/Bash"],
      // ADR-005: Codex built-ins, and the Codex-side impersonations (what Codex's sanitiser makes of `codex` / `builtin:codex`)
      [BUILTIN_CODEX_SERVER, "Bash", { command: "ls" }, "require_approval", "risky", "registry:builtin:codex/Bash"],
      [BUILTIN_CODEX_SERVER, "apply_patch", { command: "*** Begin Patch" }, "allow", "write", "registry:builtin:codex/apply_patch"],
      [BUILTIN_CODEX_SERVER, "update_plan", {}, "allow", "read", "registry:builtin:codex/update_plan"],
      [BUILTIN_CODEX_SERVER, "spawn_agent", {}, "require_approval", "unreviewed", "unreviewed:builtin:codex/spawn_agent"],
      [BUILTIN_CODEX_SERVER, "Edit", {}, "require_approval", "unreviewed", "unreviewed:builtin:codex/Edit"],
      ["codex", "Bash", {}, "require_approval", "unreviewed", "unreviewed:codex/Bash"],
      ["builtin_codex", "Bash", {}, "require_approval", "unreviewed", "unreviewed:builtin_codex/Bash"],
      ["Builtin:codex", "Bash", {}, "require_approval", "unreviewed", "unreviewed:Builtin:codex/Bash"],
      // a Codex Read never inherits the Claude Code row, and vice versa: the two builtin keys are distinct servers
      [BUILTIN_CODEX_SERVER, "Read", {}, "require_approval", "unreviewed", "unreviewed:builtin:codex/Read"],
      [BUILTIN_SERVER, "apply_patch", {}, "require_approval", "unreviewed", "unreviewed:builtin:claude-code/apply_patch"],
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
      // Astra spec v2 finding 1: an MCP server named like the builtins never inherits the builtin rows
      ["claude-code", "Read", {}, "require_approval", "unreviewed", "unreviewed:claude-code/Read"],
      ["claude-code", "Edit", {}, "require_approval", "unreviewed", "unreviewed:claude-code/Edit"],
      ["builtin_claude-code", "Bash", {}, "require_approval", "unreviewed", "unreviewed:builtin_claude-code/Bash"],
      ["Builtin:claude-code", "Read", {}, "require_approval", "unreviewed", "unreviewed:Builtin:claude-code/Read"],
      // Astra spec v2 finding 3: prototype names are unreviewed, not hits
      ["github", "constructor", {}, "require_approval", "unreviewed", "unreviewed:github/constructor"],
      ["github", "__proto__", {}, "require_approval", "unreviewed", "unreviewed:github/__proto__"],
      ["github", "toString", {}, "require_approval", "unreviewed", "unreviewed:github/toString"],
      ["constructor", "Read", {}, "require_approval", "unreviewed", "unreviewed:constructor/Read"],
      ["__proto__", "Read", {}, "require_approval", "unreviewed", "unreviewed:__proto__/Read"],
      ["prototype", "Read", {}, "require_approval", "unreviewed", "unreviewed:prototype/Read"],
    ];
    it.each(cases)("%s/%s(%j) → %s/%s via %s", (server, tool, args, verdict, risk, ruleId) => {
      expect(decide(registry, server, tool, args)).toMatchObject({ verdict, risk, ruleId });
    });
    it.each(cases)("real evaluate equals the helper: %s/%s(%j)", (server, tool, args) => {
      expect(decide(registry, server, tool, args)).toEqual(helperDecide(registry, server, tool, args));
    });
    it("no unreviewed call is ever allowed", () => {
      for (const [server, tool, args] of cases) {
        const d = decide(registry, server, tool, args);
        if (d.risk === "unreviewed") expect(d.verdict, `${server}/${tool}`).toBe("require_approval");
      }
    });
    it("the evaluator ignores an escalation that would lower the class, even if one slipped past the loader", () => {
      const r = reg({ s: { trusted: true, tools: { t: row("risky", { escalateWhen: [{ argPattern: { environment: "^dev$" }, to: "write" }] }) } } });
      expect(validate(r).length).toBe(1);
      expect(decide(r, "s", "t", { environment: "dev" })).toMatchObject({ verdict: "require_approval", risk: "risky", ruleId: "registry:s/t" });
    });
    it("an argPattern key that is a prototype name only matches an own argument", () => {
      const r = reg({ s: { trusted: true, tools: { t: row("write", { escalateWhen: [{ argPattern: { constructor: ".*" }, to: "risky" }] }) } } });
      expect(decide(r, "s", "t", { x: 1 })).toMatchObject({ verdict: "allow", risk: "write" });
      expect(decide(r, "s", "t", { constructor: "y" })).toMatchObject({ verdict: "require_approval", risk: "risky" });
    });
  });

  describe("hook tool-name split feeding the registry (spec §6)", () => {
    it("built-ins land on the reserved namespace, MCP names on their own server, and the two never meet", () => {
      expect(splitToolName("Bash")).toEqual({ server: BUILTIN_SERVER, tool: "Bash" });
      expect(splitToolName("mcp__github__create_issue")).toEqual({ server: "github", tool: "create_issue" });
      expect(splitToolName("mcp__plugin_my-plugin_db__query")).toEqual({ server: "plugin_my-plugin_db", tool: "query" });
      expect(splitToolName("mcp__srv__a__b")).toEqual({ server: "srv", tool: "a__b" });
    });
    it.each(["mcp__claude-code__Read", "mcp__claude-code__Edit", "mcp__builtin_claude-code__Bash", "mcp__Claude_Code__Bash", "mcp__builtin:claude-code__Read"])(
      "%s is refused by the collector (throw → watchdog deny); the reachable spellings are unreviewed anyway", (name) => {
        expect(() => splitToolName(name)).toThrow(/impersonates/);
        const server = name.slice("mcp__".length, name.indexOf("__", "mcp__".length));
        // A `:` cannot survive Claude Code's name sanitisation, so only the throw defends that spelling; every
        // spelling MCP can actually produce also misses the builtin rows by key.
        if (server.includes(":")) return;
        expect(server).not.toBe(BUILTIN_SERVER);
        expect(decide(registry, server, "Read")).toMatchObject({ verdict: "require_approval", risk: "unreviewed" });
      });
    it("a name with mcp_server provenance but no mcp__ prefix is refused", () => {
      expect(() => splitToolName("Read", true)).toThrow(/mcp_server/);
      expect(splitToolName("Read", false)).toEqual({ server: BUILTIN_SERVER, tool: "Read" });
    });
    it("under the codex agent, bare names land on builtin:codex and MCP names split the same way (ADR-005)", () => {
      expect(splitToolName("Bash", false, "codex")).toEqual({ server: BUILTIN_CODEX_SERVER, tool: "Bash" });
      expect(splitToolName("apply_patch", false, "codex")).toEqual({ server: BUILTIN_CODEX_SERVER, tool: "apply_patch" });
      expect(splitToolName("update_plan", false, "codex")).toEqual({ server: BUILTIN_CODEX_SERVER, tool: "update_plan" });
      expect(splitToolName("mcp__filesystem__read_file", false, "codex")).toEqual({ server: "filesystem", tool: "read_file" });
      expect(splitToolName("mcp__memory__create_entities", false, "codex")).toEqual({ server: "memory", tool: "create_entities" });
    });
    it.each(["mcp__codex__Bash", "mcp__builtin_codex__Bash", "mcp__Codex__apply_patch", "mcp__claude_code__Read", "mcp__builtin_claude_code__Bash"])(
      "%s is refused under BOTH agents: a Codex server named like either builtin namespace never reaches a builtin row", (name) => {
        expect(() => splitToolName(name, false, "codex")).toThrow(/impersonates/);
        expect(() => splitToolName(name, false, "claude-code")).toThrow(/impersonates/);
        const server = name.slice("mcp__".length, name.indexOf("__", "mcp__".length));
        expect(decide(registry, server, "Bash")).toMatchObject({ verdict: "require_approval", risk: "unreviewed" });
      });
    it("a malformed MCP name is refused rather than guessed", () => {
      for (const bad of ["mcp__", "mcp____x", "mcp__srv", "mcp__srv__"]) expect(() => splitToolName(bad), bad).toThrow(/malformed/);
    });
  });
});
