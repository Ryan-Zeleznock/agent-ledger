import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BUILTIN_SERVER, MCP_TOOL_PREFIX, type PostToolUseEvent, type PreToolUseEvent, type PreToolUseOutput } from "../src/hooks/contract.js";
import type { HookDecision } from "../src/types/index.js";

// Format-drift guard. The fixtures are the example blocks from https://code.claude.com/docs/en/hooks (read
// 2026-09-29). If Claude Code renames a field, re-fetch the docs, update the fixture, and this test tells you
// what else must change. Shape only: no parsing logic lives here (ADR-002).
const load = (name: string) => JSON.parse(readFileSync(`test/fixtures/${name}.json`, "utf8")) as Record<string, unknown>;
const COMMON: Record<string, string> = { session_id: "string", transcript_path: "string", cwd: "string", hook_event_name: "string" };

describe("Claude Code hook fixtures", () => {
  const pre = load("claude-code-pretooluse");
  const post = load("claude-code-posttooluse");

  it.each(Object.entries(COMMON))("both events carry common field %s as %s", (field, type) => {
    expect(typeof pre[field], field).toBe(type);
    expect(typeof post[field], field).toBe(type);
  });
  it("PreToolUse has tool_name, tool_input (object), tool_use_id and no tool_response", () => {
    expect(pre["hook_event_name"]).toBe("PreToolUse");
    expect(typeof pre["tool_name"]).toBe("string");
    expect(typeof pre["tool_input"]).toBe("object");
    expect(typeof pre["tool_use_id"]).toBe("string");
    expect("tool_response" in pre).toBe(false);
    const typed: PreToolUseEvent = pre as unknown as PreToolUseEvent;
    expect(typed.tool_input["command"]).toBe("npm test");
  });
  it("PostToolUse adds tool_response and shares session_id, tool_input and tool_use_id with its PreToolUse", () => {
    expect(post["hook_event_name"]).toBe("PostToolUse");
    expect("tool_response" in post).toBe(true);
    expect(post["session_id"]).toBe(pre["session_id"]);
    expect(post["tool_use_id"]).toBe(pre["tool_use_id"]);
    expect(post["tool_input"]).toEqual(pre["tool_input"]);
    const typed: PostToolUseEvent = post as unknown as PostToolUseEvent;
    expect(typeof typed.tool_response).toBe("string"); // the documented Bash example; objects are allowed too
  });
  it("uses the documented names for camelCase-free wire fields (no sessionId / toolName drift)", () => {
    for (const bad of ["sessionId", "toolName", "toolInput", "toolUseId", "hookEventName"]) {
      expect(bad in pre, bad).toBe(false);
      expect(bad in post, bad).toBe(false);
    }
  });
  it("pins the server-mapping constants and the MCP tool-name convention", () => {
    expect(BUILTIN_SERVER).toBe("claude-code");
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
