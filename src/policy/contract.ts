import type { PolicyDecision, Risk, ToolCall, Verdict } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface PolicyRule { id: string; match: { server?: string; tool?: string; argPattern?: Record<string, string> }; verdict: Verdict; risk: Risk; reason: string; }
export interface Policy { version: 1; rules: PolicyRule[]; defaultVerdict: Verdict; }
export function loadPolicy(path: string): Promise<Policy> { throw notImplemented("policy.loadPolicy"); }
export function evaluate(policy: Policy, call: ToolCall): PolicyDecision { throw notImplemented("policy.evaluate"); }
