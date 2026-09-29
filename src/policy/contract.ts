import type { PolicyDecision, Risk, ToolCall, Verdict } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
/**
 * Patterns are case-insensitive regexes. `tool` and `server` test the name; `argPattern[key]` tests String(args[key])
 * and a missing arg never matches. `unless` is an exception: the rule does NOT match when every unless pattern
 * matches its argument, so the call falls through to the later rules.
 */
export interface PolicyRule {
  id: string;
  match: { server?: string; tool?: string; argPattern?: Record<string, string>; unless?: { argPattern: Record<string, string> } };
  verdict: Verdict; risk: Risk; reason: string;
}
/** Rules are evaluated in file order; the first match wins. defaultDecision applies when none match. */
export interface Policy { version: 1; rules: PolicyRule[]; defaultDecision: PolicyDecision; }
export function loadPolicy(path: string): Promise<Policy> { throw notImplemented("policy.loadPolicy"); }
export function evaluate(policy: Policy, call: ToolCall): PolicyDecision { throw notImplemented("policy.evaluate"); }
