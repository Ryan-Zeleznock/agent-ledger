import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BUILTIN_SERVER, CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_S, DEFAULT_DEADLINE_MS, HOOK_EVENT_NAMES, HOOK_TIMEOUT_S, MCP_TOOL_PREFIX,
  type PostToolUseEvent, type PostToolUseFailureEvent, type PreToolUseEvent, type PreToolUseOutput, type SupervisedOutput,
} from "../src/hooks/contract.js";
import type { HookDecision, Outcome } from "../src/types/index.js";

// Format-drift guard. The fixtures are the example blocks from https://code.claude.com/docs/en/hooks (read
// 2026-09-29). If Claude Code renames a field, re-fetch the docs, update the fixture, and this test tells you
// what else must change. Shape only: no parsing logic lives here (ADR-002).
const load = (name: string) => JSON.parse(readFileSync(`test/fixtures/${name}.json`, "utf8")) as Record<string, unknown>;
const COMMON: Record<string, string> = { session_id: "string", transcript_path: "string", cwd: "string", hook_event_name: "string" };

describe("Claude Code hook fixtures", () => {
  const pre = load("claude-code-pretooluse");
  const post = load("claude-code-posttooluse");
  const fail = load("claude-code-posttoolusefailure");
  const all = { pre, post, fail };

  it.each(Object.entries(COMMON))("all three events carry common field %s as %s", (field, type) => {
    for (const [n, ev] of Object.entries(all)) expect(typeof ev[field], `${n}.${field}`).toBe(type);
  });
  it("all three carry tool_name, tool_input (object) and tool_use_id", () => {
    for (const [n, ev] of Object.entries(all)) {
      expect(typeof ev["tool_name"], n).toBe("string");
      expect(typeof ev["tool_input"], n).toBe("object");
      expect(typeof ev["tool_use_id"], n).toBe("string");
    }
  });
  it("the three event names are exactly the ones the collector accepts", () => {
    expect(HOOK_EVENT_NAMES).toEqual(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
    expect([pre, post, fail].map((e) => e["hook_event_name"])).toEqual([...HOOK_EVENT_NAMES]);
  });
  it("PreToolUse has no tool_response and no error", () => {
    expect("tool_response" in pre).toBe(false);
    expect("error" in pre).toBe(false);
    const typed: PreToolUseEvent = pre as unknown as PreToolUseEvent;
    expect(typed.tool_input["command"]).toBe("npm test");
    expect(typed.mcp_server).toBeUndefined(); // Bash is built-in; the object appears only for MCP tools (≥ 2.1.274)
  });
  it("PostToolUse adds tool_response and shares session_id, tool_input and tool_use_id with its PreToolUse", () => {
    expect("tool_response" in post).toBe(true);
    expect("error" in post).toBe(false);
    expect(post["session_id"]).toBe(pre["session_id"]);
    expect(post["tool_use_id"]).toBe(pre["tool_use_id"]);
    expect(post["tool_input"]).toEqual(pre["tool_input"]);
    const typed: PostToolUseEvent = post as unknown as PostToolUseEvent;
    expect(typeof typed.tool_response).toBe("string"); // the documented Bash example; objects are allowed too
  });
  it("PostToolUseFailure adds error (string), optional is_interrupt and duration_ms, and no tool_response", () => {
    expect("tool_response" in fail).toBe(false);
    expect(typeof fail["error"]).toBe("string");
    expect(typeof fail["is_interrupt"]).toBe("boolean");
    expect(typeof fail["duration_ms"]).toBe("number");
    expect(fail["tool_use_id"]).toBe(pre["tool_use_id"]); // same call as the PreToolUse fixture, so recordOutcome finds it
    const typed: PostToolUseFailureEvent = fail as unknown as PostToolUseFailureEvent;
    expect(typed.error.split("\n")[0]).toMatch(/^Exit code \d+$/); // Bash: first line is `Exit code N` when the command ran
    expect(typed.is_interrupt).toBe(false);
    expect(typed.duration_ms).toBe(4187);
  });
  it("the documented outcome mapping compiles: PostToolUse → ok, PostToolUseFailure → error with errorClass and durationMs", () => {
    const ok: Outcome = { status: "ok" };
    const typed = fail as unknown as PostToolUseFailureEvent;
    const err: Outcome = { status: "error", errorClass: typed.is_interrupt ? "interrupt" : typed.error.split("\n")[0], durationMs: typed.duration_ms };
    expect(ok.status).toBe("ok");
    expect(err).toEqual({ status: "error", errorClass: "Exit code 1", durationMs: 4187 });
    expect(JSON.stringify(err)).not.toContain("express"); // the error text is display text, never stored
  });
  it("uses the documented names for camelCase-free wire fields (no sessionId / toolName drift)", () => {
    for (const bad of ["sessionId", "toolName", "toolInput", "toolUseId", "hookEventName", "isInterrupt", "durationMs"]) {
      for (const [n, ev] of Object.entries(all)) expect(bad in ev, `${n}.${bad}`).toBe(false);
    }
  });
  it("pins the server-mapping constants and the MCP tool-name convention", () => {
    expect(BUILTIN_SERVER).toBe("builtin:claude-code");
    expect(MCP_TOOL_PREFIX).toBe("mcp__");
    expect("mcp__github__create_issue".startsWith(MCP_TOOL_PREFIX)).toBe(true);
    expect((pre["tool_name"] as string).startsWith(MCP_TOOL_PREFIX)).toBe(false); // Bash is built-in
  });
  it("the PreToolUse output shape is the documented hookSpecificOutput block", () => {
    const d: HookDecision = { decision: "deny", reason: "Destructive command blocked by hook", callId: "toolu_01ABC123..." };
    const out: PreToolUseOutput = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.decision, permissionDecisionReason: d.reason } };
    expect(JSON.parse(JSON.stringify(out))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Destructive command blocked by hook" },
    });
    expect(Object.keys(out.hookSpecificOutput)).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  });
});

describe("fail-closed supervisor constants (spec §7)", () => {
  it("our internal deadline sits below the hook timeout we configure, which sits far below Claude Code's default", () => {
    expect(CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_S).toBe(600); // verified 2026-09-29, hooks reference "Common fields"
    expect(HOOK_TIMEOUT_S).toBeLessThan(CLAUDE_CODE_DEFAULT_HOOK_TIMEOUT_S);
    expect(DEFAULT_DEADLINE_MS).toBeLessThan(HOOK_TIMEOUT_S * 1000);
    expect(HOOK_TIMEOUT_S * 1000 - DEFAULT_DEADLINE_MS).toBeGreaterThanOrEqual(1000); // at least a second of margin
  });
  it("the failure-path output is a deny AND exit 2, since exit 2 blocks even if stdout were lost", () => {
    const denied: SupervisedOutput = {
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "supervisor:deadline" } }),
      stderr: "supervisor:deadline",
      exitCode: 2,
    };
    expect(denied.exitCode).toBe(2);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const decided: SupervisedOutput = { stdout: "{}", stderr: "", exitCode: 0 };
    // @ts-expect-error the supervisor never exits 1: that code lets the tool call continue
    const never: SupervisedOutput = { stdout: "", stderr: "", exitCode: 1 };
    expect([decided.exitCode, never.exitCode]).toEqual([0, 1]);
  });
});
