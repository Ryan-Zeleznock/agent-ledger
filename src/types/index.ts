export type AgentId = string;
export type SessionId = string;

export interface ToolCall {
  callId: string; sessionId: SessionId; agentId: AgentId;
  onBehalfOf?: string; declaredPlan?: string;
  server: string; tool: string;
  args: Record<string, unknown>;
  receivedAt: string;
}

export const VERDICTS = ["allow", "deny", "require_approval"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Risk = "read" | "write" | "risky";
export interface PolicyDecision { verdict: Verdict; ruleId: string; reason: string; risk: Risk; }

export interface ApprovalResult {
  decision: "approved" | "denied" | "timeout";
  approver?: string; decidedAt: string; channel: "slack";
}

export type Phase = "intent" | "outcome";
export interface Outcome { status: "ok" | "error" | "blocked"; errorClass?: string; durationMs?: number; }

export interface LedgerRecord {
  id: string; phase: Phase; call: ToolCall;
  policy: PolicyDecision; approval?: ApprovalResult; outcome?: Outcome;
  prevHash: string; hash: string; writtenAt: string;
}
export type UnsealedRecord = Omit<LedgerRecord, "prevHash" | "hash" | "writtenAt">;
export interface VerifyResult { ok: boolean; checked: number; brokenAt?: string; }

export interface ToolInfo { server: string; name: string; description?: string; inputSchema?: unknown; }
export interface ToolResult { content: unknown; isError: boolean; }
export interface DateRange { from: string; to: string; }
export type CallHandler = (call: ToolCall) => Promise<ToolResult>;
