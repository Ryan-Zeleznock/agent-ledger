import type { ApprovalChannel, ApprovalResult, PolicyDecision, ToolCall } from "../types/index.js";
import { requestApprovalImpl, validateSlackChannelImpl, getRouter } from "./slack.js";
export { configureSlackApprovals, probeSlack, closeSlackApprovals, SLACK_API_BASE_URL, SLACK_PROXY_MAX_TIMEOUT_MS, SLACK_HTTP_TIMEOUT_MS } from "./slack.js";
export type { SlackApprovalsConfig, WebSocketLike } from "./slack.js";

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

/**
 * Block Kit identifiers we emit. `block_id` carries the callId; every button `value` carries `<callId>:<nonce>`, where
 * the nonce (SLACK_NONCE_BYTES of CSPRNG, hex) is minted per approval request and remembered together with the posted
 * message's `ts`. A click is valid only if callId, nonce AND `message.ts` all match the pending request (Astra P2,
 * 2026-09-30): a callId alone is guessable from a hook event or a ledger line, so a forged or replayed `block_actions`
 * payload naming a real callId must not settle it.
 */
export const SLACK_ACTION_IDS = { approve: "agent-ledger:approve", deny: "agent-ledger:deny" } as const;
export const SLACK_BLOCK_ID_PREFIX = "agent-ledger:call:" as const;
export const SLACK_NONCE_BYTES = 16;
export const SLACK_BUTTON_VALUE_RE = /^[^:]+:[0-9a-f]{32}$/;
/** Slack limits we must stay under (verified 2026-09-29): button `value` 2,000 chars, `action_id`/`block_id` 255 chars, 25 elements per actions block. */
export const SLACK_LIMITS = { buttonValueChars: 2_000, actionIdChars: 255, blockIdChars: 255, actionsBlockElements: 25 } as const;

/** What one approval message asks. Shape only; the Block Kit JSON is built from it after Gate 2. */
export interface SlackApprovalRequest {
  callId: string;
  channelId: string;
  /** Rendered from the ToolCall: agent, server/tool, redacted args preview, policy reason and risk. No secrets, no raw args. */
  summary: { agentId: string; server: string; tool: string; risk: PolicyDecision["risk"]; reason: string; argsPreview: string };
  /** `agent-ledger:call:<callId>`; each button's `value` is `<callId>:<nonce>`. */
  blockId: `${typeof SLACK_BLOCK_ID_PREFIX}${string}`;
  /** Per-request CSPRNG nonce (hex, SLACK_NONCE_BYTES). Never logged, never stored in a ledger record. */
  nonce: string;
  expiresAt: string; // ISO 8601: postedAt + effective wait; shown in the message
}
/** The click, reduced to what the decision needs. `userId` is `block_actions.user.id`, the Slack member id. */
export interface SlackApprovalReply {
  callId: string;              // from actions[0].value before the `:`; MUST equal the request's callId
  nonce: string;               // from actions[0].value after the `:`; MUST equal the request's nonce (anti-forgery)
  actionId: (typeof SLACK_ACTION_IDS)[keyof typeof SLACK_ACTION_IDS];
  userId: string;
  messageTs: string;           // `message.ts`; MUST equal the ts chat.postMessage returned for this request (anti-replay); used for chat.update
  channelId: string;           // `channel.id`, must equal the request's channel
  envelopeId: string;          // Socket Mode `envelope_id`; acked once, a duplicate envelope is acked again and ignored
  receivedAt: string;
}

/**
 * One pending approval and its atomic settlement (Astra P2, 2026-09-30). State is `pending` until exactly ONE
 * terminal transition wins: the first valid click (`approved` | `denied`), the timer (`timeout`), or a transport
 * failure (`unavailable`). `settle()` is a compare-and-set on a single in-process record: it returns true for the
 * transition that won and false for every later attempt, so two approvers clicking in the same instant, a click
 * racing the timeout, a late click after settlement, and a duplicate Socket Mode envelope (Slack retries until acked)
 * all resolve to one recorded decision. Every envelope is still acked; a losing click gets an ephemeral "already
 * decided by <user> at <time>" reply and changes nothing. After settlement the pending entry is removed from the
 * router, so a click with a valid nonce for a settled call is a no-op, never a second decision.
 */
export interface PendingApproval {
  callId: string; nonce: string; messageTs: string; channelId: string;
  state: "pending" | "settled";
  settle(result: ApprovalResult): boolean;
}

/**
 * ONE Socket Mode connection and dispatcher per process (Astra P2, 2026-09-30). Slack allows at most 10 concurrent
 * Socket Mode connections per app, and each `block_actions` envelope is delivered to ONE connection: a separate
 * socket per pending approval would see the clicks meant for the other approvals dropped or acked by the wrong
 * waiter. So the process holds a single router: it opens the WebSocket once (reconnecting on Slack's
 * `disconnect`/refresh), acks every envelope by `envelope_id`, parses the button `value` into `<callId>:<nonce>`,
 * looks the callId up in its pending map, checks nonce, `message.ts`, `channel.id` and the approver allowlist, and
 * hands the click to that entry's `settle`. Unknown callId, wrong nonce, wrong ts, non-approver → acked and ignored.
 * `requestApproval` registers with the router and never opens its own socket; the router closes when the last
 * pending approval settles. In the hook handler that is one approval per process; in the proxy it is many.
 */
export interface SlackApprovalRouter {
  register(p: PendingApproval): void;
  /** Number of approvals currently pending; the socket is open iff > 0. */
  readonly pendingCount: number;
}
export function getSlackApprovalRouter(channel: SlackChannel): SlackApprovalRouter { return getRouter(channel); }

/**
 * Posts the call to Slack and waits up to the EFFECTIVE wait: `channel.timeoutMs`, capped by `deadlineAt` when the
 * caller passes one (decide-only mode: `min(timeoutMs, deadlineAt - now - APPROVAL_MIN_MARGIN_MS)`; ≤ 0 → `timeout`
 * at once, no Slack round trip). Resolves, never rejects. Flow (spec §6):
 * 1. Mint the nonce; register a PendingApproval with the process's ONE SlackApprovalRouter (which opens Socket Mode
 *    with `appToken` if it is not open yet); failure to open → `unavailable`.
 * 2. `chat.postMessage` to `channel.channelId` with the SlackApprovalRequest blocks (button values `<callId>:<nonce>`);
 *    non-ok → `unavailable`; the returned `ts` is stored on the pending entry as the only acceptable `message.ts`.
 * 3. The router acks every envelope by `envelope_id` at once, then filters:
 *    - callId not pending, `nonce` mismatch, `message.ts !== ts`, or `channel.id !== channel.channelId` → ignore
 *      (another call, a forged value, or a replay of an older message);
 *    - `user.id` not in `channel.approvers` → ignore for the decision; an ephemeral reply says who may approve;
 *    - the first click that wins `settle()`: `agent-ledger:approve` → `approved`, `agent-ledger:deny` → `denied`, with
 *      `approver = user.id` and `reason` from the click (button label, optional confirm text). Later valid clicks,
 *      competing clicks and duplicate envelopes lose the compare-and-set and change nothing.
 * 4. Nobody answered within the effective wait → the timer's `settle(timeout)`; a click arriving after that loses. Any
 *    transport or API error before settlement → `settle(unavailable)`.
 * 5. `chat.update` the message with the outcome (decision, approver, time); a failed update does not change the decision.
 * The result is bound to `call.callId` AND this request's nonce and message; a click can never be reused for another
 * call or another request for the same call. `timeout`, `unavailable`, `denied` all mean deny in the pipeline (spec §7).
 */
export function requestApproval(call: ToolCall, decision: PolicyDecision, channel: SlackChannel, deadlineAt?: number): Promise<ApprovalResult> { return requestApprovalImpl(call, decision, channel, deadlineAt); }

/**
 * Validates a Slack channel config at init (called by the handler and the proxy before any call is served). Problems
 * are returned, and the caller refuses to start on a non-empty list (hook: init failure → watchdog deny + exit 2):
 * `channelId` must look like a Slack channel id (`^[CG][A-Z0-9]{8,}$`); `timeoutMs` a finite integer > 0; `transport`
 * exactly `socket-mode`; `approvers` non-empty, each a Slack user id (`^[UW][A-Z0-9]{8,}$`); both secrets resolvable
 * through `secrets` (env var set, or file readable), value never returned.
 */
export function validateSlackChannel(channel: SlackChannel): Promise<string[]> { return validateSlackChannelImpl(channel); }
