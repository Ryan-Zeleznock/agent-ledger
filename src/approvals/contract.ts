import type { ApprovalChannel, ApprovalResult, PolicyDecision, ToolCall } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";

export type { ApprovalChannel };
/** The only channel that actually asks anyone: `hook-ask` is resolved inside the pipeline and never reaches this module. */
export type SlackChannel = Extract<ApprovalChannel, { kind: "slack" }>;

// ---------- Slack, Socket Mode, Block Kit (ADR-006). Facts verified 2026-09-29 against docs.slack.dev ----------
//
// Transport: Socket Mode. "Socket Mode allows your app to use the Events API and interactive features — without
// exposing a public HTTP Request URL." The WebSocket URL comes from `apps.connections.open` (app-level `xapp-` token,
// scope `connections:write`: "Grants permission to generate websocket URIs and connect to Socket Mode"); it "is not
// static ... and it refreshes regularly"; at most 10 concurrent connections per app; Socket Mode apps cannot be listed
// in the Slack Marketplace (irrelevant: this is a private workspace app). Every envelope carries `envelope_id` and must
// be acknowledged ("Your app still needs to acknowledge receiving each event so that Slack knows whether to retry").
// Message: `chat.postMessage` (bot `xoxb-` token, scope `chat:write`, `chat:write.public` for channels the bot is not
// in) with a `blocks` array: a `section` describing the call and an `actions` block (max 25 elements) holding two
// `button` elements (`action_id` ≤ 255 chars, unique within the block; `value` ≤ 2,000 chars; `style` primary|danger;
// optional `confirm` dialog). The reply is a `block_actions` payload with `user.id` ("The user who interacted to
// trigger this request"), `actions[].action_id`, `actions[].block_id`, `actions[].value`, `message.ts`, `channel.id`,
// `response_url`. Update after a decision: `chat.update` (bot `chat:write`; "Only messages posted by the authenticated
// user are able to be updated", so the bot updates its own message by `channel` + `ts`), or `response_url` with
// `replace_original: true`.

/** Block Kit identifiers we emit. `block_id` and every `value` carry the callId so a click can be bound to one call. */
export const SLACK_ACTION_IDS = { approve: "agent-ledger:approve", deny: "agent-ledger:deny" } as const;
export const SLACK_BLOCK_ID_PREFIX = "agent-ledger:call:" as const;
/** Slack limits we must stay under (verified 2026-09-29): button `value` 2,000 chars, `action_id`/`block_id` 255 chars, 25 elements per actions block. */
export const SLACK_LIMITS = { buttonValueChars: 2_000, actionIdChars: 255, blockIdChars: 255, actionsBlockElements: 25 } as const;

/** What one approval message asks. Shape only; the Block Kit JSON is built from it after Gate 2. */
export interface SlackApprovalRequest {
  callId: string;
  channelId: string;
  /** Rendered from the ToolCall: agent, server/tool, redacted args preview, policy reason and risk. No secrets, no raw args. */
  summary: { agentId: string; server: string; tool: string; risk: PolicyDecision["risk"]; reason: string; argsPreview: string };
  /** `agent-ledger:call:<callId>`; also each button's `value` is the callId. */
  blockId: `${typeof SLACK_BLOCK_ID_PREFIX}${string}`;
  expiresAt: string; // ISO 8601: postedAt + channel.timeoutMs; shown in the message
}
/** The click, reduced to what the decision needs. `userId` is `block_actions.user.id`, the Slack member id. */
export interface SlackApprovalReply {
  callId: string;              // from actions[0].value; MUST equal the request's callId (anti-replay)
  actionId: (typeof SLACK_ACTION_IDS)[keyof typeof SLACK_ACTION_IDS];
  userId: string;
  messageTs: string;           // `message.ts`, used for chat.update
  channelId: string;           // `channel.id`, must equal the request's channel
  receivedAt: string;
}

/**
 * Posts the call to Slack and waits up to `channel.timeoutMs`. Resolves, never rejects. Flow (spec §6):
 * 1. Open Socket Mode (apps.connections.open with `appToken`); failure → `unavailable`.
 * 2. `chat.postMessage` to `channel.channelId` with the SlackApprovalRequest blocks; non-ok → `unavailable`.
 * 3. Wait for a `block_actions` envelope; ack every envelope by `envelope_id` at once, then filter:
 *    - `actions[0].value !== call.callId` or `channel.id !== channel.channelId` → ignore (another call, or a replay);
 *    - `user.id` not in `channel.approvers` → ignore for the decision; `chat.update`/thread reply says who may approve;
 *    - first matching click wins: `agent-ledger:approve` → `approved`, `agent-ledger:deny` → `denied`, with
 *      `approver = user.id` and `reason` from the click (button label, optional confirm text).
 * 4. Nobody answered in `timeoutMs` → `timeout`. Any transport or API error before a decision → `unavailable`.
 * 5. `chat.update` the message with the outcome (decision, approver, time); a failed update does not change the decision.
 * The result is bound to `call.callId`; a click can never be reused for another call because the callId is compared,
 * not the message. `timeout`, `unavailable`, `denied` all mean deny in the pipeline (spec §7).
 */
export function requestApproval(call: ToolCall, decision: PolicyDecision, channel: SlackChannel): Promise<ApprovalResult> { throw notImplemented("approvals.requestApproval"); }

/**
 * Validates a Slack channel config at init (called by the handler and the proxy before any call is served). Problems
 * are returned, and the caller refuses to start on a non-empty list (hook: init failure → watchdog deny + exit 2):
 * `channelId` must look like a Slack channel id (`^[CG][A-Z0-9]{8,}$`); `timeoutMs` a finite integer > 0; `transport`
 * exactly `socket-mode`; `approvers` non-empty, each a Slack user id (`^[UW][A-Z0-9]{8,}$`); both secrets resolvable
 * through `secrets` (env var set, or file readable), value never returned.
 */
export function validateSlackChannel(channel: SlackChannel): Promise<string[]> { throw notImplemented("approvals.validateSlackChannel"); }
