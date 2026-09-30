import { describe, it, expect } from "vitest";
import * as approvals from "../src/approvals/contract.js";
import { SLACK_ACTION_IDS, SLACK_BLOCK_ID_PREFIX, SLACK_BUTTON_VALUE_RE, SLACK_LIMITS, SLACK_NONCE_BYTES, type SlackApprovalReply, type SlackApprovalRequest, type SlackChannel } from "../src/approvals/contract.js";
import type { ApprovalResult } from "../src/types/index.js";

// Shape-only (ADR-002). The Slack facts behind these shapes were verified 2026-09-29 against docs.slack.dev
// (Socket Mode, block_actions payload, button element, actions block, chat.postMessage, chat.update).
describe("Slack approval channel contract (ADR-006)", () => {
  const channel: SlackChannel = {
    kind: "slack", channelId: "C0123456789", timeoutMs: 300_000, transport: "socket-mode",
    botToken: { kind: "env", name: "SLACK_BOT_TOKEN" }, appToken: { kind: "env", name: "SLACK_APP_TOKEN" }, approvers: ["U0123456789", "U0987654321"],
  };
  it("the channel carries Socket Mode, two secret references and an approver allowlist; never token values", () => {
    expect(channel.transport).toBe("socket-mode");
    expect(channel.botToken).toEqual({ kind: "env", name: "SLACK_BOT_TOKEN" });
    expect(channel.approvers.length).toBeGreaterThan(0);
    expect(JSON.stringify(channel)).not.toMatch(/xox|xapp-/);
  });
  it("Block Kit identifiers stay within Slack's limits and carry the callId", () => {
    expect(SLACK_ACTION_IDS).toEqual({ approve: "agent-ledger:approve", deny: "agent-ledger:deny" });
    expect(SLACK_BLOCK_ID_PREFIX).toBe("agent-ledger:call:");
    expect(SLACK_LIMITS).toEqual({ buttonValueChars: 2_000, actionIdChars: 255, blockIdChars: 255, actionsBlockElements: 25 });
    const callId = "call_" + "x".repeat(200);
    const nonce = "a".repeat(SLACK_NONCE_BYTES * 2); // hex of SLACK_NONCE_BYTES CSPRNG bytes
    const req: SlackApprovalRequest = {
      callId, channelId: channel.channelId, blockId: `${SLACK_BLOCK_ID_PREFIX}${callId}`, nonce, expiresAt: "2026-09-29T00:05:00Z",
      summary: { agentId: "astra", server: "github", tool: "delete_repo", risk: "risky", reason: "reviewed risky", argsPreview: "{ repo: [redacted] }" },
    };
    expect(req.blockId.length).toBeLessThanOrEqual(SLACK_LIMITS.blockIdChars);
    // Astra P2 (2026-09-30): the button value is `<callId>:<nonce>`, so a guessed callId alone can never settle an approval
    const buttonValue = `${callId}:${nonce}`;
    expect(buttonValue).toMatch(SLACK_BUTTON_VALUE_RE);
    expect(`${callId}:${"a".repeat(31)}`).not.toMatch(SLACK_BUTTON_VALUE_RE);
    expect(callId).not.toMatch(SLACK_BUTTON_VALUE_RE);
    expect(buttonValue.length).toBeLessThanOrEqual(SLACK_LIMITS.buttonValueChars);
    for (const id of Object.values(SLACK_ACTION_IDS)) expect(id.length).toBeLessThanOrEqual(SLACK_LIMITS.actionIdChars);
    expect(2).toBeLessThanOrEqual(SLACK_LIMITS.actionsBlockElements); // approve + deny
  });
  it("a reply is bound to the callId, nonce and message ts, and carries the Slack user id, channel and envelope id", () => {
    const reply: SlackApprovalReply = { callId: "c1", nonce: "b".repeat(32), actionId: "agent-ledger:approve", userId: "U0123456789", messageTs: "1727568000.000100", channelId: "C0123456789", envelopeId: "env-1", receivedAt: "2026-09-29T00:01:00Z" };
    expect(reply.callId).toBe("c1");
    expect(reply.nonce).toHaveLength(SLACK_NONCE_BYTES * 2);
    expect(channel.approvers).toContain(reply.userId);
    // @ts-expect-error only the two emitted action ids are legal replies
    const bad: SlackApprovalReply = { ...reply, actionId: "agent-ledger:maybe" };
    expect(bad.actionId).toBe("agent-ledger:maybe");
    const result: ApprovalResult = { callId: reply.callId, decision: "approved", approver: reply.userId, reason: "Approve", decidedAt: reply.receivedAt, channel: "slack" };
    expect(result.approver).toMatch(/^U/); // a Slack member id, never a display name
  });
  it("the module exposes requestApproval, validateSlackChannel and the one-per-process router as stubs (ADR-002)", () => {
    expect(() => approvals.requestApproval(undefined as never, undefined as never, channel)).toThrow(/^not implemented: approvals.requestApproval/);
    expect(() => approvals.validateSlackChannel(channel)).toThrow(/^not implemented: approvals.validateSlackChannel/);
    expect(() => approvals.getSlackApprovalRouter(channel)).toThrow(/^not implemented: approvals.getSlackApprovalRouter/);
  });
});
