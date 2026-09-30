import type { ApprovalChannel, ApprovalResult, CallHandler, HookAgent, HookDecision, IncomingCall, LedgerRecord, Outcome, PolicyDecision, ToolCall, ToolResult, UnsealedRecord } from "../types/index.js";
import { BUILTIN_SERVER_KEYS, CODEX_MCP_NOT_PROXIED_REASON, HANDOFF_TO_PROXY_REASON, HANDOFF_TO_PROXY_RULE_PREFIX } from "../types/index.js";
import type { IdentityService } from "../identity/contract.js";
import type { ToolRegistry } from "../policy/contract.js";
import { clearArgFields, evaluate } from "../policy/contract.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { Upstream } from "../upstream/contract.js";
import { requestApproval, validateSlackChannel } from "../approvals/contract.js";
import { APPROVAL_MIN_MARGIN_MS, MAX_REASON_CHARS, WATCHDOG_DEADLINE_AT_ENV, WATCHDOG_DEADLINE_ENV, WATCHDOG_MIN_MARGIN_MS, validateHookTiming } from "../hooks/contract.js";
import { createHmac, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";

/**
 * `registry` is the reviewed tool registry (ADR-004); the pipeline never sees the suggestion rules.
 * `approvals` is required and a union: `{ kind: "slack", ... }` asks in Slack; `{ kind: "hook-ask" }` (local mode,
 * no channel) hands `require_approval` back to Claude Code as `ask`, and under Codex resolves to a recorded
 * `no-channel` deny. Proxy mode with `hook-ask` is a config error: there is no terminal to ask in, so `createPipeline`
 * refuses it when `handle` would be used.
 * `hookAgent` is set in decide-only mode from the hook's own configuration (never from the event) and selects the
 * Codex rules below; absent means proxy mode (`handle`), where MCP identity is raw and the registry is the authority.
 * `argsHmacKey` (ADR-009, amended 2026-09-30; interface pin 1): the per-ledger key, at least ARGS_HMAC_KEY_MIN_BYTES
 * bytes; `createPipeline` throws if shorter. Stored `call.args` are the projection of the raw args: fields listed by
 * `policy.clearArgFields(registry, server, tool)` are kept (and still redacted by the ledger, defence in depth); every
 * other top-level field becomes `"hmac-sha256:" + hex(HMAC-SHA256(key, JCS(value)))`, JCS being RFC 8785 (the
 * `canonicalize` package the ledger hashes with). Unreviewed tools have no clear fields. The policy is evaluated on the
 * RAW args (escalation patterns need real values); only the record carries the projection.
 */
export interface PipelineDeps { identity: IdentityService; registry: ToolRegistry; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalChannel; hookAgent?: HookAgent; argsHmacKey: Uint8Array; }

export const ARGS_HMAC_KEY_MIN_BYTES = 32;
export const ARGS_HMAC_PREFIX = "hmac-sha256:" as const;

export interface Pipeline {
  /**
   * Proxy mode (MCP front). Identity → policy → approval → intent record → upstream.execute → outcome record.
   * Builds the ToolCall by explicit field projection (callId, sessionId, agentId, onBehalfOf, declaredPlan, server,
   * tool, args, receivedAt). Never spread the IncomingCall: that keeps `credential` on the object at runtime.
   * Registry lookups are own-property only (`Object.hasOwn`): `github/constructor` is unreviewed, not a hit.
   * The proxy refuses an upstream that is not on its configured allowlist (spec §9) before any of this runs.
   */
  handle: CallHandler;
  /**
   * Decide-only mode (hook collector). Same steps up to and including the intent record, then STOPS: nothing is
   * executed, because the agent runtime runs the tool itself after reading our answer.
   *
   * The approval channel is resolved BEFORE the intent record is persisted, so the record carries the FINAL decision:
   * - verdict allow → `allow`, kind `decided`;
   * - verdict deny → `deny`;
   * - require_approval + slack → `approvals.requestApproval` first; the intent record then carries `approved` (with
   *   approver and reason) or `denied` / `timeout` / `unavailable`; `allow` is returned only for `approved` AND only
   *   after the append succeeded (a failed append is a deny, spec §7);
   * - require_approval + hook-ask under Claude Code → intent record with `delegated`, answer `ask`;
   * - require_approval + hook-ask under Codex → intent record with `no-channel` and its reason, a `blocked` outcome
   *   record, answer `deny`. Nothing is ever left as a dangling `delegated` under Codex.
   *
   * Codex MCP identity (ADR-006), applied before the registry is consulted, for any IncomingCall whose server is not
   * a `builtin:*` key while `hookAgent === "codex"`:
   * - `server === registry.proxy.codex.serverName` → append a small `handoff-to-proxy` INTENT record first
   *   (`handoff: { kind: "to-proxy", proxyServerName }`, `policy: { verdict: "allow", risk: "unreviewed", ruleId:
   *   "handoff-to-proxy:<proxyServerName>", reason: HANDOFF_TO_PROXY_REASON }`, no approval), then return
   *   `{ decision: "allow", kind: "governed-by-proxy" }`. The record classifies nothing (the proxy decides and records
   *   the real decision with raw upstream identity), but it proves the hook SAW the call: a call cancelled before the
   *   proxy sees it, or an alias that reaches the hook without reaching the proxy, still leaves a trace, and
   *   `report.reconcileHandoffs` flags every handoff with no proxy record for the same callId (Astra P1, 2026-09-30).
   *   A failed append here is a `deny`, like every other failed intent append (spec §7);
   * - anything else → intent record with `policy: { verdict: "deny", risk: "unreviewed", ruleId:
   *   "codex-mcp-not-proxied:<server>/<tool>", reason: CODEX_MCP_NOT_PROXIED_REASON }`, a `blocked` outcome record,
   *   answer `deny`. A registry row for that server name changes nothing: hook names are not identities under Codex.
   * Under Claude Code, MCP hook names are consulted against the registry as before (its `mcp_server.source`
   * provenance is the trust anchor there, per its docs).
   */
  decide(incoming: IncomingCall): Promise<HookDecision>;
  /**
   * Decide-only mode, second half: PostToolUse (status ok) or PostToolUseFailure (status error) reports what
   * happened; the pipeline appends the outcome record for `callId`. An unknown callId is an orphan outcome, kept.
   * A `governed-by-proxy` call's hook outcome chains to its `handoff-to-proxy` intent record; the decision and the
   * upstream outcome themselves arrive through the proxy's records for the same callId.
   */
  recordOutcome(callId: string, outcome: Outcome): Promise<void>;
}

/** What an orphan outcome (no intent record for the callId in this ledger) is recorded against; never an authority. */
export const ORPHAN_OUTCOME_RULE_PREFIX = "orphan-outcome:" as const;
export const CODEX_NO_CHANNEL_REASON = "Codex cannot ask and no Slack channel is configured" as const;
export const DELEGATED_REASON = "delegated to the Claude Code terminal prompt (hook-ask); the outcome record says whether it ran" as const;

// ---------- args projection (ADR-009 + pin 1) ----------

/**
 * Keeps the reviewed clear fields and replaces every other top-level field with `hmac-sha256:<hex>` of
 * HMAC-SHA256(key, JCS(value)) (RFC 2104 via node:crypto; RFC 8785 via `canonicalize`). Own enumerable keys only; the
 * result is a fresh object. A value JCS cannot serialise (never from JSON input) makes the call fail closed.
 */
export function projectArgs(args: Record<string, unknown>, clear: readonly string[], key: Uint8Array): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keep = new Set(clear);
  for (const k of Object.keys(args)) {
    const value = args[k];
    if (keep.has(k)) { Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true }); continue; }
    const jcs = canonicalize(value);
    if (typeof jcs !== "string") throw new Error(`pipeline: argument ${JSON.stringify(k)} has no canonical JSON form`);
    const mac = createHmac("sha256", key).update(jcs, "utf8").digest("hex");
    Object.defineProperty(out, k, { value: `${ARGS_HMAC_PREFIX}${mac}`, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

// ---------- helpers ----------

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const now = () => new Date().toISOString();
const isBuiltinKey = (server: string) => (BUILTIN_SERVER_KEYS as readonly string[]).includes(server);
const clip = (s: string) => (s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS - 1)}…` : s);
/** Reads a watchdog env var as a positive integer, or null. */
function envInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
/** The stored call for a record: explicit projection of the authenticated call, never a spread of the IncomingCall. */
function toolCall(incoming: IncomingCall, sessionId: string, agentId: string, args: Record<string, unknown>): ToolCall {
  const call: ToolCall = { callId: incoming.callId, sessionId, agentId, server: incoming.server, tool: incoming.tool, args, receivedAt: incoming.receivedAt };
  if (incoming.onBehalfOf !== undefined) call.onBehalfOf = incoming.onBehalfOf;
  if (incoming.declaredPlan !== undefined) call.declaredPlan = incoming.declaredPlan;
  return call;
}
const intentRecord = (call: ToolCall, policy: PolicyDecision, approval?: ApprovalResult): UnsealedRecord => {
  const r: UnsealedRecord = { id: randomUUID(), phase: "intent", call, policy };
  if (approval !== undefined) r.approval = approval;
  return r;
};
const outcomeRecord = (call: ToolCall, policy: PolicyDecision, outcome: Outcome): UnsealedRecord => ({ id: randomUUID(), phase: "outcome", call, policy, outcome });

interface Decided { decision: HookDecision; call?: ToolCall; policy?: PolicyDecision }

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { identity, registry, ledger, upstream, approvals, hookAgent } = deps;
  if (!(deps.argsHmacKey instanceof Uint8Array) || deps.argsHmacKey.length < ARGS_HMAC_KEY_MIN_BYTES) {
    throw new Error(`pipeline: argsHmacKey must be a Uint8Array of at least ${ARGS_HMAC_KEY_MIN_BYTES} bytes (ADR-009)`);
  }
  const hmacKey = Uint8Array.from(deps.argsHmacKey);
  if (!approvals || (approvals.kind !== "slack" && approvals.kind !== "hook-ask")) throw new Error("pipeline: approvals channel is required (slack or hook-ask)");
  if (hookAgent !== undefined && hookAgent !== "claude-code" && hookAgent !== "codex") throw new Error("pipeline: unknown hookAgent");
  const decideOnly = hookAgent !== undefined;
  if (!decideOnly && approvals.kind === "hook-ask") throw new Error("pipeline: hook-ask is not a channel proxy mode can use (no terminal to ask in); configure a slack channel");

  // Decide-only mode: the watchdog's absolute deadline is mandatory, so a late start can never wait past it.
  let deadlineAt: number | undefined;
  if (decideOnly) {
    const at = envInt(WATCHDOG_DEADLINE_AT_ENV);
    if (at === null) throw new Error(`pipeline: ${WATCHDOG_DEADLINE_AT_ENV} must be a positive integer (epoch ms); the handler must run under the watchdog`);
    if (at <= Date.now()) throw new Error(`pipeline: ${WATCHDOG_DEADLINE_AT_ENV} is already past`);
    deadlineAt = at;
    if (approvals.kind === "slack") {
      const deadlineMs = envInt(WATCHDOG_DEADLINE_ENV);
      if (deadlineMs === null) throw new Error(`pipeline: ${WATCHDOG_DEADLINE_ENV} must be a positive integer when a slack channel is configured`);
      // The handler does not know the agent's hook timeout; a consistent one is derived so only the approval clock is judged here.
      const hookTimeoutS = Math.ceil((deadlineMs + WATCHDOG_MIN_MARGIN_MS) / 1000);
      const violations = validateHookTiming({ approvalTimeoutMs: approvals.timeoutMs, deadlineMs, hookTimeoutS });
      if (violations.length > 0) throw new Error(`pipeline: slack timeoutMs breaks the hook clocks: ${violations.join("; ")}`);
    }
  }
  // `createPipeline` is synchronous and the Slack validator is not: it starts here and its verdict gates every call.
  const slackProblems: Promise<string[]> = approvals.kind === "slack"
    ? Promise.resolve().then(() => validateSlackChannel(approvals)).catch((e: unknown) => [`validateSlackChannel failed: ${message(e)}`])
    : Promise.resolve([]);

  /** callId → what the intent record said, for outcome records in the same process (proxy mode); the ledger is the fallback. */
  const intents = new Map<string, { call: ToolCall; policy: PolicyDecision }>();

  const deny = (callId: string, reason: string): HookDecision => ({ decision: "deny", reason: clip(reason), callId, kind: "decided" });
  const appendIntent = async (record: UnsealedRecord): Promise<{ ok: true } | { ok: false; error: string }> => {
    try { await ledger.append(record); intents.set(record.call.callId, { call: record.call, policy: record.policy }); return { ok: true }; }
    catch (e) { return { ok: false, error: message(e) }; }
  };
  /** Best effort: a blocked outcome after a deny. Its failure changes nothing (the answer is already deny). */
  const appendBlocked = async (call: ToolCall, policy: PolicyDecision) => {
    try { await ledger.append(outcomeRecord(call, policy, { status: "blocked" })); } catch { /* deny stands */ }
  };
  const ledgerDenied = (callId: string, error: string) => deny(callId, `agent-ledger: denied: ledger unavailable (${error}); fail closed (spec §7)`);

  async function decideInternal(incoming: IncomingCall): Promise<Decided> {
    const callId = typeof incoming?.callId === "string" ? incoming.callId : "";
    if (!callId || typeof incoming.server !== "string" || typeof incoming.tool !== "string" || typeof incoming.args !== "object" || incoming.args === null) {
      return { decision: deny(callId, "agent-ledger: denied: malformed call") };
    }
    const problems = await slackProblems;
    if (problems.length > 0) return { decision: deny(callId, `agent-ledger: denied: slack channel misconfigured (${problems.join("; ")})`) };

    let agentId: string;
    try { agentId = await identity.resolveAgent(incoming.credential); }
    catch (e) { return { decision: deny(callId, `agent-ledger: denied: unknown agent (${message(e)})`) }; }
    let sessionId: string;
    try { sessionId = await identity.startSession(agentId, incoming.onBehalfOf); }
    catch (e) { return { decision: deny(callId, `agent-ledger: denied: session refused (${message(e)})`) }; }

    // Policy sees the raw args; the ledger sees the projection (ADR-009).
    const rawCall = toolCall(incoming, sessionId, agentId, incoming.args);
    let call: ToolCall;
    try { call = toolCall(incoming, sessionId, agentId, projectArgs(incoming.args, clearArgFields(registry, incoming.server, incoming.tool), hmacKey)); }
    catch (e) { return { decision: deny(callId, `agent-ledger: denied: arguments cannot be recorded (${message(e)})`) }; }

    // ADR-006: under Codex an mcp__ server segment is not an identity.
    if (hookAgent === "codex" && !isBuiltinKey(call.server)) {
      const proxyName = registry.proxy?.codex?.serverName;
      if (proxyName !== undefined && call.server === proxyName) {
        const policy: PolicyDecision = { verdict: "allow", risk: "unreviewed", ruleId: `${HANDOFF_TO_PROXY_RULE_PREFIX}${proxyName}`, reason: HANDOFF_TO_PROXY_REASON };
        const record: UnsealedRecord = { ...intentRecord(call, policy), handoff: { kind: "to-proxy", proxyServerName: proxyName } };
        const r = await appendIntent(record);
        if (!r.ok) return { decision: ledgerDenied(callId, r.error), call, policy };
        return { decision: { decision: "allow", reason: HANDOFF_TO_PROXY_REASON, callId, kind: "governed-by-proxy" }, call, policy };
      }
      const policy: PolicyDecision = { verdict: "deny", risk: "unreviewed", ruleId: `codex-mcp-not-proxied:${call.server}/${call.tool}`, reason: CODEX_MCP_NOT_PROXIED_REASON };
      const r = await appendIntent(intentRecord(call, policy));
      if (!r.ok) return { decision: ledgerDenied(callId, r.error), call, policy };
      await appendBlocked(call, policy);
      return { decision: deny(callId, `agent-ledger: denied (${policy.ruleId}): ${CODEX_MCP_NOT_PROXIED_REASON}`), call, policy };
    }

    const policy = evaluate(registry, rawCall);
    const tag = `${policy.risk}; ${policy.ruleId}`;
    if (policy.verdict === "allow") {
      const r = await appendIntent(intentRecord(call, policy));
      if (!r.ok) return { decision: ledgerDenied(callId, r.error), call, policy };
      return { decision: { decision: "allow", reason: clip(`agent-ledger: allowed (${tag}): ${policy.reason}`), callId, kind: "decided" }, call, policy };
    }
    if (policy.verdict === "deny") {
      const r = await appendIntent(intentRecord(call, policy));
      if (!r.ok) return { decision: ledgerDenied(callId, r.error), call, policy };
      await appendBlocked(call, policy);
      return { decision: deny(callId, `agent-ledger: denied (${tag}): ${policy.reason}`), call, policy };
    }
    // require_approval: the channel is resolved BEFORE the intent record is persisted.
    if (approvals.kind === "hook-ask") {
      if (hookAgent === "claude-code") {
        const approval: ApprovalResult = { callId, decision: "delegated", reason: DELEGATED_REASON, decidedAt: now(), channel: "hook-ask" };
        const r = await appendIntent(intentRecord(call, policy, approval));
        if (!r.ok) return { decision: ledgerDenied(callId, r.error), call, policy };
        return { decision: { decision: "ask", reason: clip(`agent-ledger: approval required (${tag}): ${policy.reason}`), callId, kind: "decided" }, call, policy };
      }
      const approval: ApprovalResult = { callId, decision: "no-channel", reason: CODEX_NO_CHANNEL_REASON, decidedAt: now(), channel: "hook-ask" };
      const r = await appendIntent(intentRecord(call, policy, approval));
      if (!r.ok) return { decision: ledgerDenied(callId, r.error), call, policy };
      await appendBlocked(call, policy);
      return { decision: deny(callId, `agent-ledger: denied (${tag}): ${CODEX_NO_CHANNEL_REASON}`), call, policy };
    }
    let approval: ApprovalResult;
    try {
      approval = await requestApproval(call, policy, approvals, deadlineAt);
      if (!approval || approval.callId !== callId || approval.channel !== "slack") throw new Error("approval result is not bound to this call");
    } catch (e) {
      approval = { callId, decision: "unavailable", reason: `Slack unreachable: ${message(e)}`, decidedAt: now(), channel: "slack" };
    }
    const r = await appendIntent(intentRecord(call, policy, approval));
    if (!r.ok) return { decision: ledgerDenied(callId, r.error), call, policy };
    if (approval.decision === "approved") {
      return { decision: { decision: "allow", reason: clip(`agent-ledger: approved by ${approval.approver ?? "?"} (${tag}): ${approval.reason ?? ""}`), callId, kind: "decided" }, call, policy };
    }
    await appendBlocked(call, policy);
    return { decision: deny(callId, `agent-ledger: denied (approval ${approval.decision}; ${tag}): ${approval.reason ?? ""}`), call, policy };
  }

  /** The intent this outcome belongs to: same process first, then the ledger (last intent record with that callId). */
  async function findIntent(callId: string): Promise<{ call: ToolCall; policy: PolicyDecision } | undefined> {
    const cached = intents.get(callId);
    if (cached) return cached;
    let found: LedgerRecord | undefined;
    for await (const rec of ledger.read({ from: "1970-01-01T00:00:00.000Z", to: new Date(Date.now() + 86_400_000).toISOString() })) {
      if (rec.phase === "intent" && rec.call.callId === callId) found = rec;
    }
    return found ? { call: found.call, policy: found.policy } : undefined;
  }

  const pipeline: Pipeline = {
    async decide(incoming) {
      return (await decideInternal(incoming)).decision;
    },
    async recordOutcome(callId, outcome) {
      if (typeof callId !== "string" || callId.length === 0) throw new Error("pipeline.recordOutcome: callId required");
      const status = outcome?.status;
      if (status !== "ok" && status !== "error" && status !== "blocked") throw new Error("pipeline.recordOutcome: invalid outcome");
      const clean: Outcome = { status };
      if (typeof outcome.errorClass === "string") clean.errorClass = outcome.errorClass;
      if (typeof outcome.durationMs === "number" && Number.isFinite(outcome.durationMs) && outcome.durationMs >= 0) clean.durationMs = outcome.durationMs;
      const intent = await findIntent(callId);
      if (intent) { await ledger.append(outcomeRecord(intent.call, intent.policy, clean)); return; }
      const call: ToolCall = { callId, sessionId: "unknown", agentId: "unknown", server: "unknown", tool: "unknown", args: {}, receivedAt: now() };
      const policy: PolicyDecision = { verdict: "require_approval", risk: "unreviewed", ruleId: `${ORPHAN_OUTCOME_RULE_PREFIX}${callId}`, reason: "outcome reported for a callId with no intent record in this ledger" };
      await ledger.append(outcomeRecord(call, policy, clean));
    },
    async handle(incoming): Promise<ToolResult> {
      if (decideOnly) throw new Error("pipeline.handle: not available in decide-only mode (hookAgent set, hook-ask or hook clocks configured)");
      const d = await decideInternal(incoming);
      if (d.decision.decision !== "allow" || d.call === undefined || d.policy === undefined) {
        return { content: [{ type: "text", text: d.decision.reason }], isError: true };
      }
      const started = Date.now();
      let result: ToolResult;
      try { result = await upstream.execute(d.call); }
      catch (e) {
        try { await ledger.append(outcomeRecord(d.call, d.policy, { status: "error", errorClass: e instanceof Error ? e.name : "upstream-error", durationMs: Date.now() - started })); } catch { /* the error result is returned regardless */ }
        return { content: [{ type: "text", text: `agent-ledger: upstream failed: ${message(e)}` }], isError: true };
      }
      const outcome: Outcome = { status: result?.isError ? "error" : "ok", durationMs: Date.now() - started };
      if (outcome.status === "error") outcome.errorClass = "tool-error";
      try { await ledger.append(outcomeRecord(d.call, d.policy, outcome)); } catch { /* the tool already ran; the outcome could not be recorded */ }
      return result;
    },
  };
  return pipeline;
}
