# Agent Ledger: Framework Spec (v2.1)

**Date:** 2026-09-30 · **Status: v2.1 FROZEN (2026-09-30)** · **Author:** Ryan + Fable
**Changes after freeze require an ADR** (`~/Desktop/AgentLedger/decisions/`, ADR-007 records the freeze). Remaining hardening is implementation-time work, listed as tests in `test/todo/`; findings found while building become tests or §7 residual limits, not spec rounds.
**Brain:** `~/Desktop/AgentLedger/` (read `_state.md` first)
**Changed in v2.1 (2026-09-30, after Astra's re-review parts A+B, all 7 prior findings verified fixed):** an explicit **trust-boundary statement** (§3): local mode = visibility + tamper-evident logging + best-effort gating on a machine its user controls; server mode = the enforcement boundary. Every open finding is now either an implementation test (`test/todo/`) or a §7 residual limit: the watchdog's output writes are non-blocking and time-bounded, its group kill tolerates ESRCH and never reuses a PGID, and it hands the handler an **absolute** deadline (`AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS`); the hook writes a **`handoff-to-proxy`** intent record for Codex proxy calls and the report reconciles it with the proxy's record; Slack approvals carry a per-request **nonce** bound to callId + `message.ts`, settle **atomically** (competing, late and duplicate clicks), and share **one Socket Mode router per process**; the proxy name refuses internal `__`; two stale sentences fixed (§6 Codex `delegated`; the exit-1 comment in `hooks/contract.ts`). §12 holds only market questions for the Gate 1 calls.
**Changed in v2:** ADR-004 reviewed allowlist (§7, §8); MCP 2026-07-28 (§3, §4); hook collector for coding agents (§3, §4, §6); RFC 8785 hashing and IETF draft field alignment (§5). Every external format below was checked against its primary source on 2026-09-29; the URLs are inline and the findings are in the vault (`diligence-2026-09-28.md`, "Verified by Fable").
**Changed in the v2 fix round (2026-09-29, after Astra's gate FAIL):** built-in tools moved to the reserved `builtin:claude-code` namespace and the loader refuses impersonating or case-twin keys (§6, §8); fail-closed hook supervisor and an honest list of what it cannot catch (§7); own-property registry lookups and refused prototype keys (§8); `ApprovalChannel` union with `hook-ask`, `unavailable` → deny, allow only after the intent record persists (§5, §6, §7); `PostToolUseFailure` event and `error` outcome mapping (§3, §6); the IETF draft alignment is now stated as conceptual, not byte-compatible (§5).
**Changed in the watchdog round (2026-09-29, after Astra's re-review):** the in-process supervisor is replaced by a **two-process watchdog** that owns stdout, kills a stalled handler on its own timer, validates and re-serialises the handler's payload, and exits 2 on every deny and every failure path, config errors included (§7); **Codex** joins local mode through the same `src/hooks/` module with an `agent` discriminator and the reserved `builtin:codex` namespace (ADR-005; §3, §4, §6, §8); Codex's unsupported `ask` maps to `deny` (§6). Verifications: `diligence-2026-09-28.md`, "Verified by Fable (supervisor + Codex)".
**Changed in the watchdog-fix + ADR-006 round (2026-09-30, after Astra's second gate FAIL):** the watchdog accepts an allow only after the handler's `exit` **and** `close`, spawns the handler in its own process group and kills the whole group, loops every write to completion, and reads stdin asynchronously (§7); the exit-code table now says exit 1 *without valid decision JSON* continues (§7). **Codex hook names are not MCP identities** (codex-rs trims `_` at the `__` join after hashing), so under Codex every MCP server is an upstream of the Agent Ledger proxy, the proxy is Codex's one configured MCP server, its tools are `governed-by-proxy`, and any other Codex `mcp__*` call is denied (§3, §5, §6, §8). **Slack (Socket Mode, Block Kit buttons) is the Codex approval channel**, bound to callId with an approver allowlist; the final decision (approved / denied / timeout / unavailable / no-channel) is resolved *before* the intent record is written, so nothing is left `delegated` under Codex; the three clocks (approval < watchdog deadline < hook timeout) are configurable and validated at init (§5, §6, §7). Verifications: `diligence-2026-09-28.md`, "Verified by Fable (watchdog fixes + ADR-006, 2026-09-29)".

## 1. What this is

A control point between an AI agent and its tools. Every tool call is identified, classified against a
reviewed tool registry, sent for human approval when risky or unknown, and recorded in a tamper-evident
ledger. The ledger exports as SOC 2 evidence (CC6.1 access, CC7.2 monitoring, CC8.1 change management).

**Buyer:** Head of GRC or CISO at a company with 200-2,000 employees, agents in production, and an
annual SOC 2 audit.
**Success for the MVP:** a design partner's auditor accepts one generated report.

## 2. Scope of THIS phase: framework only

ADR-002 still holds, so this phase delivers **no business logic**. It delivers:

- The repo layout below, with each module's README (its job, dependencies, and what it doesn't do).
- A contract file per module (`contract.ts`): exported types and function signatures whose bodies
  `throw notImplemented(...)`.
- Shared types in `src/types/`. This is the one place where the data shapes are final.
- A test list per module (`test/todo/<module>.todo.md`) so development after Gate 2 starts test-first.
- An example tool registry, the suggestion patterns, real hook fixtures, and the Docker Compose skeleton (not runnable yet).

## 3. Deployment modes (one codebase)

| Mode | Collector | Runs where | Ledger backend | Evidence strength |
|---|---|---|---|---|
| **Local** | **Hook collector** for **Claude Code** (`PreToolUse`/`PostToolUse`/`PostToolUseFailure`) and **Codex** (`PreToolUse`/`PostToolUse`), **plus** MCP proxy over stdio | Developer laptop | Append-only JSONL file | **Visibility + tamper-evident logging + best-effort gating.** Per-user hooks can be edited; admin-managed hooks cannot be disabled from inside the agent's own configuration (Claude Code managed settings; Codex `requirements.toml`), but the machine's user can still bypass them (below). |
| **Server** | MCP proxy over Streamable HTTP | Docker container anywhere: laptop, homelab, VM, or the customer's cloud | Postgres | **Enforcement.** The proxy holds the credentials and the agent cannot reach the tools directly, so a call that is not recorded is a call that did not happen. The basis for audit-grade evidence claims. |

**Trust boundary (v2.1; the sentence every other section is read under).** **LOCAL MODE** runs hooks and a local proxy on a
machine its user controls. It gives **visibility, tamper-evident logging, and best-effort gating**: a user who controls the
machine can bypass it, by editing or removing settings, killing the watchdog or the proxy, or shaping the launch environment
(`NODE_OPTIONS=--import=…` preloads code into any Node process, our "approved" proxy included; `PATH` and interpreter
swaps do the same for scripts). Managed configuration (§7) raises the cost of a bypass and the ledger makes one *visible*
(a session with tool calls and no heartbeat, a handoff with no proxy record, a gap in the chain), but nothing in local mode
*prevents* it. Local-mode records are evidence of what the agent did **through the governed paths**, and the report says so.
**SERVER MODE** is **the enforcement boundary**: the proxy holds the upstream credentials, the agent has none, and every
tool call has to pass through the proxy to happen at all. Only server-mode records support the claim "no risky action ran
without a recorded approval". Everything §7 lists as a residual limit is a local-mode limit; server mode has none of them,
because the bypass would need the credentials the agent does not have. Any sentence elsewhere in this spec that says a
bypass "cannot" happen means "cannot happen through the agent's own configuration or through our code": on a user-controlled
machine it is always qualified by this paragraph.

**Why two collectors in local mode.** An MCP proxy never sees a coding agent's built-in tools (Claude Code's
Bash, Edit, Write, WebFetch; Codex's Bash, apply_patch). Hooks fire for built-in and MCP tools in both agents and
can be enforced by an admin, so the hook collector is the primary local collector and the MCP proxy covers agents
that only speak MCP. Sources: https://code.claude.com/docs/en/hooks and https://learn.chatgpt.com/docs/hooks (read 2026-09-29).

**Both coding agents, one module (ADR-005).** `src/hooks/` serves Claude Code and Codex through an
`agent: "claude-code" | "codex"` argument on `parseHookInput`, `toIncomingCall`, `toOutcome` and
`formatPreToolUseOutput`, and one watchdog (§7). Verified 2026-09-29 against https://learn.chatgpt.com/docs/hooks
and the generated schemas in openai/codex (`codex-rs/hooks/schema/generated`): Codex hooks are **enabled by default**,
run for `PreToolUse`, `PostToolUse`, `PermissionRequest` (and session events), name tools `Bash`, `apply_patch`
(`Edit`/`Write` are matcher aliases only), `mcp__<server>__<tool>`, and are enforceable through `requirements.toml`
(`allow_managed_hooks_only = true`, `[features].hooks = true`). **Differences from Claude Code that the adapter
handles:** `model`, `turn_id`, `permission_mode` are required; `transcript_path` may be null; `tool_input` is any JSON
value; there is **no `PostToolUseFailure`** (a failed command still arrives as `PostToolUse`); and
**`permissionDecision: "ask"` is unsupported: Codex "marks the hook run as failed, reports the error, and continues
the tool call"**, so the adapter never emits it (§6). Codex MCP names reach a hook with both segments sanitised to
`[A-Za-z0-9_]`, which is what keeps `builtin:codex` unreachable (§8). Codex also warns that "some specialized tool
paths can opt out of the default hook path" and that hosted tools (`WebSearch`) never fire hooks: local mode under
Codex is visibility over the hooked paths, not a complete boundary, exactly as for Claude Code (§7 residual limits).

**Codex MCP goes through the proxy (ADR-006).** A Codex hook's `mcp__<server>__<tool>` is **not** an MCP identity. Verified
2026-09-29 in openai/codex `codex-rs/core/src/tools/handlers/mcp.rs`: `join_tool_name` computes
`namespace.trim_end_matches('_') + "__" + name.trim_start_matches('_')` **after** `codex-mcp/src/tools.rs` has sanitised both
parts and hash-suffixed collisions, so server `github_` with tool `list_repos` and server `github` with tool `_list_repos`
both fire as `mcp__github__list_repos` and would inherit a reviewed `github/list_repos` row. Therefore, under Codex: the hook
gates **built-ins only** (`Bash`, `apply_patch`, `update_plan`, `spawn_agent`, …); every MCP server Codex uses is configured as
an **upstream of the Agent Ledger proxy**, and the proxy is Codex's **single** configured MCP server, under the name in
`registry.proxy.codex.serverName`. A hook call for one of the proxy's tools is answered `allow` with
`kind: "governed-by-proxy"` after the hook writes a small **`handoff-to-proxy` intent record** (callId, proxy server name, no
classification): the proxy decides and records the call with raw upstream identity (§6, §9), and the report reconciles
every handoff with the proxy's record for the same callId, flagging the ones with none (a call cancelled before the proxy
saw it, or an alias that reached the hook but not the proxy, is visible either way; v2.1). Any other Codex `mcp__*` call is
a **recorded deny**, reason "route this MCP server through the Agent Ledger
proxy". Claude Code keeps the direct hook path for MCP (its docs make `mcp_server.source` the trust anchor, and its names
are not aliased this way).

**MCP protocol version: 2026-07-28** (https://modelcontextprotocol.io/specification/2026-07-28/changelog).
The transport is stateless: no `initialize` handshake, no `Mcp-Session-Id`; every POST carries
`MCP-Protocol-Version`, `Mcp-Method`, and (for `tools/call`) `Mcp-Name`, so a gateway can route on headers.
Servers MUST validate `Origin` (403 on mismatch) and SHOULD bind to 127.0.0.1 locally
(https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http). Our `sessionId`
is **ours** (created by `identity.startSession`), not an MCP session; MCP no longer has one.

Build order after Gate 2: **local mode first** (hook collector, then stdio proxy; dogfood on Fable and Astra),
then server mode for design partners.
**Not in scope yet:** a Terraform module for AWS, written when a design partner needs it.

## 4. Components

| # | Folder | Job (exactly one) | Depends on |
|---|---|---|---|
| 1 | `src/front/` | MCP server (2026-07-28) the agent connects to (stdio + Streamable HTTP with `bindHost`, `allowedOrigins`); lists tools, hands each call to an injected `CallHandler` as an unauthenticated `IncomingCall` | types (the handler is injected) |
| 1b | `src/hooks/` | Parse a Claude Code or Codex hook event into an `IncomingCall` (PreToolUse) or an `Outcome` (PostToolUse; Claude Code's PostToolUseFailure); format a `HookDecision` as the documented `hookSpecificOutput` JSON per agent; define the two-process watchdog the agent executes (§7) | types (the watchdog itself imports only node built-ins) |
| 2 | `src/upstream/` | MCP clients to the real tool servers; combines their tool lists (with annotations) | types, secrets |
| 3 | `src/identity/` | Authenticate the agent; create and track sessions | types |
| 4 | `src/secrets/` | Hand upstream credentials to `upstream/` only. Backends: env/file (local), Secrets Manager (later). | types |
| 5 | `src/policy/` | Classify a ToolCall from the reviewed registry (`evaluate`); propose classes for review (`suggestClass`) | types |
| 6 | `src/approvals/` | Ask a human in **Slack** (Socket Mode + Block Kit buttons, bound to callId, approver allowlist) and return the FINAL ApprovalResult; `timeout` and `unavailable` both mean deny. The `hook-ask` channel never reaches this module (§6). Required under Codex; optional for Claude Code | types (secrets at init) |
| 7 | `src/ledger/` | Redact, hash-chain (RFC 8785 + SHA-256), append, verify | types, `canonicalize` |
| 8 | `src/anchor/` | Record the chain head daily somewhere hard to edit. Backends: local file (now), S3 Object Lock (later). | types (it receives the head hash) |
| 9 | `src/report/` | Turn ledger records for a date range into PDF + CSV mapped to SOC 2 criteria | types, ledger |
| n/a | `src/pipeline/` | Wire 3 → 5 → 6 → 7 → 2 → 7 for one call (the only module that knows the order). `createPipeline(deps)` returns `{ handle, decide, recordOutcome }` | identity, policy, approvals, ledger, upstream, types |

**Later, not scaffolded now:** 10, intent-vs-action drift detection (v2: `declare_plan` tool, rules, an
LLM judge, baselines); 11, the Terraform module; 12, a Codex `PermissionRequest` adapter (allow/deny Codex's own approval
prompts; it carries no `tool_use_id`, so it cannot join the intent/outcome chain yet).

## 5. Shared contracts (`src/types/`)

```ts
type AgentId = string; type SessionId = string;

interface AgentCredential { kind: "api_key" | "local"; value: string; }   // never stored

interface IncomingCall {          // what `front` or `hooks` produces: unauthenticated
  callId: string; credential: AgentCredential;
  server: string; tool: string; args: Record<string, unknown>; receivedAt: string;
  onBehalfOf?: string; declaredPlan?: string;
}
type CallHandler = (incoming: IncomingCall) => Promise<ToolResult>;   // built by pipeline, run by front

interface ToolCall {              // authenticated by the pipeline; carries no credential
  callId: string; sessionId: SessionId; agentId: AgentId;
  onBehalfOf?: string; declaredPlan?: string;
  server: string; tool: string; args: Record<string, unknown>; receivedAt: string;
}

type Verdict = "allow" | "deny" | "require_approval";
type Risk = "read" | "write" | "risky" | "unreviewed";          // unreviewed = not in the registry (ADR-004)
interface PolicyDecision { verdict: Verdict; ruleId: string; reason: string; risk: Risk; }

type SecretRef = { kind: "env"; name: string } | { kind: "file"; path: string };   // config carries references, never values
type ApprovalChannel =                                                              // required in PipelineDeps: "no channel" is said out loud
  | { kind: "slack"; channelId: string; timeoutMs: number; transport: "socket-mode";
      botToken: SecretRef /* xoxb-, chat:write */; appToken: SecretRef /* xapp-, connections:write */; approvers: readonly string[] /* Slack user ids */ }
  | { kind: "hook-ask" };
interface ApprovalResult {                       // the FINAL decision as the intent record stores it
  callId: string;                                // bound to one call: a Slack click for another callId is ignored
  decision: "approved" | "denied" | "timeout" | "unavailable" | "no-channel" | "delegated";
  //         ^ only `approved` can become an allow; `no-channel` = Codex + hook-ask (cannot ask); `delegated` only under Claude Code hook-ask
  approver?: string;                             // Slack user id (block_actions.user.id), never a display name
  reason?: string;                               // why: the click, "no approver answered within N ms", "Slack unreachable: …", "Codex cannot ask and no Slack channel is configured"
  decidedAt: string; channel: ApprovalChannel["kind"];
}

type Phase = "intent" | "outcome";
interface LedgerRecord {
  id: string; phase: Phase; call: ToolCall;   // args redacted before hashing
  policy: PolicyDecision; approval?: ApprovalResult;
  outcome?: { status: "ok" | "error" | "blocked"; errorClass?: string; durationMs?: number };
  handoff?: { kind: "to-proxy"; proxyServerName: string };   // v2.1: only on the hook's handoff-to-proxy intent record (Codex)
  parentRecordId: string | null;              // previous record's id; null on genesis
  prevHash: string;                           // previous record's hash; "0" on genesis
  hash: string;                               // SHA-256 hex of JCS(record without `hash`)
  writtenAt: string;
}

interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; }
interface ToolInfo { server: string; name: string; description?: string; inputSchema?: unknown; annotations?: ToolAnnotations; }

interface HookDecision { decision: "allow" | "deny" | "ask"; reason: string; callId: string; kind: "decided" | "governed-by-proxy"; }
//   governed-by-proxy (Codex only): the proxy decides and records this call; the hook says allow and writes only a
//   handoff-to-proxy intent record (ruleId "handoff-to-proxy:<proxyServerName>", reason HANDOFF_TO_PROXY_REASON; ADR-006, v2.1)

interface IdentityService { resolveAgent(cred: AgentCredential): Promise<AgentId>; startSession(agentId: AgentId, onBehalfOf?: string): Promise<SessionId>; }
interface PipelineDeps { identity: IdentityService; registry: ToolRegistry; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalChannel; hookAgent?: HookAgent; }

// Codex MCP identity (ADR-006, §3, §8). The proxy's name in Codex's mcp_servers: hook-visible form, unguessable, never an upstream key.
const CODEX_PROXY_SERVER_NAME_RE = /^[A-Za-z0-9](?!.*__)[A-Za-z0-9_]*[A-Za-z0-9]$/;   // [A-Za-z0-9_], no leading/trailing `_` (Codex trims them at the join), no internal `__` (the hook name splits there; v2.1)
const CODEX_PROXY_SERVER_NAME_MIN_LENGTH = 16;
interface ProxyIdentity { codex?: { serverName: string } }                     // ToolRegistry.proxy

// The three clocks of a hook call (ADR-006, §7): approvalTimeoutMs + 5 s ≤ deadlineMs ≤ hookTimeoutS × 1000 − 2 s, validated at init
interface HookTiming { approvalTimeoutMs?: number; deadlineMs: number; hookTimeoutS: number; }
const DEFAULT_HOOK_TIMING = { deadlineMs: 25_000, hookTimeoutS: 30 };                            // no Slack
const SLACK_HOOK_TIMING = { approvalTimeoutMs: 300_000, deadlineMs: 310_000, hookTimeoutS: 320 }; // Slack approvals (Codex)
const WATCHDOG_DEADLINE_ENV = "AGENT_LEDGER_WATCHDOG_DEADLINE_MS";                                // watchdog → handler: the DURATION, for the static clock check
const WATCHDOG_DEADLINE_AT_ENV = "AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS";                          // watchdog → handler: the ABSOLUTE deadline (epoch ms); the handler budgets its Slack wait from this (v2.1)
const WATCHDOG_WRITE_BUDGET_MS = 1_000;                                                            // output writes are non-blocking and time-bounded; zero progress within the budget = write failure = exit 2 (v2.1)

// Slack approvals (v2.1): button value = `<callId>:<nonce>`; a click settles only if callId, nonce AND message.ts match the pending request
const SLACK_NONCE_BYTES = 16;                                                                       // CSPRNG, hex; minted per request, never stored in a record
interface PendingApproval { callId: string; nonce: string; messageTs: string; state: "pending" | "settled"; settle(r: ApprovalResult): boolean; }   // compare-and-set: one terminal transition wins
interface SlackApprovalRouter { register(p: PendingApproval): void; readonly pendingCount: number; }                                              // ONE per process; one Socket Mode connection

// Server identity (§8). Neither agent lets a `:` through to the mcp__<server>__<tool> name a hook sees: Claude Code
// allows [A-Za-z0-9_-] in MCP server names and rewrites the rest to `_`; Codex sanitises every hook-visible MCP name
// to [A-Za-z0-9_]. So no MCP call can ever carry a `:` in its server segment.
type HookAgent = "claude-code" | "codex";
const BUILTIN_NAMESPACE = "builtin:";
const BUILTIN_SERVERS = { "claude-code": "builtin:claude-code", codex: "builtin:codex" };   // BUILTIN_SERVER = the first
const BUILTIN_SERVER_KEYS = ["builtin:claude-code", "builtin:codex"];
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
const RESERVED_SERVER_NAMES = ["claudecode", "builtinclaudecode", "codex", "builtincodex"];   // after lowercase + strip non-[a-z0-9]
const RESERVED_KEYS = ["__proto__", "constructor", "prototype"];      // plus anything `in Object.prototype`
```

`AgentCredential` appears only in `IncomingCall`. `ToolCall` and `LedgerRecord` have no field for it. The type
alone does not enforce this at runtime (a spread `{ ...incoming, agentId, sessionId }` would keep `credential`
on the object), so the pipeline builds `ToolCall` by **explicit field projection** and never spreads
`IncomingCall`: `{ callId, sessionId, agentId, onBehalfOf, declaredPlan, server, tool, args, receivedAt }`, each
copied by name. A runtime test pins this (`test/todo/pipeline.todo.md`).

**Hashing (RFC 8785).** `hash = SHA-256(JCS(record without hash))`, lowercase hex, where JCS is the JSON
Canonicalization Scheme of RFC 8785 (https://www.rfc-editor.org/rfc/rfc8785, read 2026-09-29): keys sorted by
UTF-16 code units, ECMAScript number formatting, no whitespace. The ledger uses the `canonicalize` npm package
(5.1.0, exact-pinned; README claims RFC 8785 conformance and ships types) and never hand-rolls canonical JSON.
`test/jcs.test.ts` proves two key orders hash identically.

**Alignment with draft-sharif-agent-audit-trail-06 is conceptual, not byte-compatible**
(https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/, dated 2026-09-29, individual Internet-Draft, text
re-read 2026-09-29). Both chains use JCS + SHA-256, but the draft's §6.1 defines
`prev_hash(N) = hex(SHA-256(JCS(record(N-1))))` over the **complete previous record as stored, including all of its
fields** (its own `prev_hash`, any signature; only a detached `batch` object is removed, §6.3). Ours is
`prevHash(N) = hash(N-1)` where `hash = SHA-256(JCS(record without its own hash field))`, and our records carry a `hash`
field the draft's do not, use camelCase names, and write `"0"` rather than `null` on genesis. A draft verifier fed our
records byte-for-byte would fail at record 1, and renaming fields cannot fix that: the two hash inputs differ. So:
our chain is verified by **our** `ledger.verify()`; the mapping table below is a vocabulary bridge for reports and
conversations with auditors, nothing more. **Future work, not current behavior:** an export that re-emits records in the
draft's schema and **re-hashes** them into a fresh draft-conformant chain, anchored separately from our own chain, so
that either chain can be verified by its own rules. We keep camelCase and our vocabulary; the report module can emit
the draft's names from this table:

| Ours | Draft | Note |
|---|---|---|
| `id` | `record_id` | ours is any unique string, theirs UUIDv4 |
| `parentRecordId` | `parent_record_id` | **adopted in v2**; null on genesis in both |
| `prevHash` | `prev_hash` | ours `"0"` on genesis, theirs `null` |
| `phase: intent / outcome` | `record_phase: pre_execution / post_execution` | same meaning; "intent" is our product vocabulary |
| `call.sessionId`, `call.agentId` | `session_id`, `agent_id` | |
| `call.tool`, `call.server` | `action_detail.tool_name`, `tool_server` | |
| `call.args` (redacted) | `parameters_hash` | not adopted: we store redacted args as evidence, not only a hash |
| `outcome.status ok / error / blocked` | `outcome success / failure / denied` | `blocked` covers denied + timeout |
| `outcome.durationMs` | `latency_ms` | |
| `approval` | `human_override` / `authorization_record_id` | ours is bound to `callId` |
| (none) | `trust_level`, `agent_version`, `action_type`, `signature` | not adopted; signatures are a later feature |

## 6. Flow of one tool call

**Proxy mode** (`pipeline.handle`, run by `front`):

1. `front` receives an `IncomingCall` (credential attached). The pipeline calls `deps.identity.resolveAgent(credential)`
   and `startSession(...)`, then builds the authenticated `ToolCall` by explicit field projection (§5, never a spread).
   An unknown agent is denied before any other step.
2. `policy.evaluate(registry, call)` returns `allow`, `deny`, or `require_approval` with a risk class (§8). Lookups are
   exact, case-sensitive, own-property only.
3. If `require_approval`: `approvals.requestApproval(call, decision, channel)` on a `slack` channel. `timeout` (nobody
   answered in `timeoutMs`) and `unavailable` (channel configured but unreachable or erroring) both count as denied.
   Proxy mode with `hook-ask` is a configuration error: there is no terminal to ask in, so `createPipeline` refuses it.
4. `ledger.append(intent record)`, carrying the `ApprovalResult` when there is one. **This happens before execution**,
   so there's never an unlogged risky action. **An approved risky call proceeds only after this append has succeeded**;
   if the append fails, the call is blocked (§7), approval or not.
5. If allowed: `upstream.execute(call)` using credentials from `secrets`.
6. `ledger.append(outcome record)` → the result is returned to the agent.

**Decide-only mode** (`pipeline.decide`, run by the handler process that the watchdog spawns, §7; `agent` is fixed by the
hook's own configuration, never read from the event):

1. `hooks.parseHookInput(stdin, agent)` → `PreToolUseEvent` (Claude Code) or `CodexPreToolUseEvent` (Codex; `model`,
   `turn_id`, `permission_mode` required, `transcript_path` nullable, `tool_input` any JSON). `hooks.toIncomingCall(ev,
   credential, agent)` sets `callId = tool_use_id`, `args = tool_input` (Codex: a `tool_input` that is not a plain object is
   refused → deny), and names the server:
   - `mcp__<server>__<tool>` → `<server>/<tool>`, split at the first `__` after the prefix, server segment verbatim (plugin
     form `plugin_<plugin>_<server>` included). If the server segment, lowercased and stripped of everything outside
     `[a-z0-9]`, is `claudecode`, `builtinclaudecode`, `codex` or `builtincodex`, the collector **throws** (→ deny) under
     either agent: an MCP server is impersonating a built-in namespace. `mcp__claude-code__Read` therefore never resolves to
     the built-in `Read` row; if it somehow reached the registry it would be server `claude-code`, an unreviewed MCP server,
     and `require_approval`. Same for `mcp__builtin_codex__Bash`, which is exactly what Codex makes of a server named `builtin:codex`.
   - Claude Code only: a name without the prefix but with an `mcp_server` provenance object (≥ 2.1.274) → throw (malformed).
   - any other name → built-in tool on server **`builtin:claude-code`** or **`builtin:codex`** (`BUILTIN_SERVERS[agent]`).
     Neither agent can produce a `:` in a server segment (Claude Code: only `[A-Za-z0-9_-]` in MCP server names, the rest
     rewritten to `_`, https://code.claude.com/docs/en/mcp; Codex: `sanitize_responses_api_tool_name` keeps only
     `[A-Za-z0-9_]`, codex-rs/codex-mcp/src/mcp/mod.rs; both verified 2026-09-29), so these keys are unreachable from MCP by
     construction. Codex built-in names as the hook sends them: `Bash` (shell and `exec_command`), `apply_patch` (all file
     edits; the event never says `Edit`/`Write`), `update_plan`, `spawn_agent`.
   - **Codex only (ADR-006), before the registry is consulted, for any `mcp__` name:** if the server segment equals
     `registry.proxy.codex.serverName`, `decide` appends a **`handoff-to-proxy` intent record** (`handoff: { kind: "to-proxy",
     proxyServerName }`, `policy: { verdict: "allow", risk: "unreviewed", ruleId: "handoff-to-proxy:<proxyServerName>" }`, no
     approval; a failed append is a deny like any other), then returns `{ decision: "allow", kind: "governed-by-proxy" }`. The
     record classifies nothing (the proxy decides and records the call with raw identity; classifying it again would
     double-count the decision) but proves the hook saw the call; `report.reconcileHandoffs` flags every handoff with no
     proxy record for the same callId within the range plus `HANDOFF_RECONCILE_GRACE_MS` (v2.1, Astra 2026-09-30). Any other
     server → intent record `{ verdict: "deny", risk: "unreviewed", ruleId: "codex-mcp-not-proxied:<server>/<tool>", reason:
     CODEX_MCP_NOT_PROXIED_REASON }`, a `blocked` outcome record, answer `deny`. A registry row for that server name changes
     nothing under Codex: the name is not an identity (§3). With no `proxy.codex` configured, every Codex MCP call is that deny.
2. Steps 1-4 above, then **stop**: nothing is executed, the agent runs the tool itself. **The approval channel is resolved
   before the intent record is persisted**, so the record carries the final decision (§5 `ApprovalResult`):
   - `slack`: `approvals.requestApproval(call, decision, channel)` posts a Block Kit message (`chat.postMessage`, bot token,
     `chat:write`) with an `actions` block of two buttons, `agent-ledger:approve` / `agent-ledger:deny`, whose `block_id` carries
     the callId and whose `value` is **`<callId>:<nonce>`**, the nonce being `SLACK_NONCE_BYTES` of CSPRNG minted for this
     request (a callId alone is guessable from a hook event or a ledger line, so it is not enough to settle an approval; v2.1);
     the `ts` that `chat.postMessage` returns is remembered as the only acceptable `message.ts`. The wait runs over **Socket
     Mode** (app-level token, `connections:write`, `apps.connections.open`; no public Request URL, which suits a homelab or a
     private network) through **one `SlackApprovalRouter` per process**: one WebSocket, one dispatcher, a pending map keyed by
     callId, because Slack delivers each envelope to one of at most 10 connections and a socket per pending approval would
     lose the clicks meant for the others. The router acks every envelope by `envelope_id`, then ignores a click whose callId is
     not pending, whose nonce or `message.ts` differ from the pending request, whose `channel.id ≠ channelId`, or whose
     `user.id` is not in `approvers`. **Settlement is atomic**: a `PendingApproval` goes `pending → settled` through one
     compare-and-set, so competing clicks, a click racing the timeout, a late click after settlement, and a redelivered envelope
     all resolve to exactly one recorded decision (`approved` / `denied` with `approver = user.id`, or `timeout`, or
     `unavailable`); losers are acked and answered "already decided". The wait is `min(timeoutMs, deadlineAt − now −
     APPROVAL_MIN_MARGIN_MS)` with `deadlineAt` from `WATCHDOG_DEADLINE_AT_ENV` (≤ 0 → `timeout` with no round trip).
     `chat.update` closes the message. Transport or API failure before settlement → `unavailable`. All Slack facts verified
     2026-09-29 (docs.slack.dev; `diligence-2026-09-28.md`).
   - `hook-ask` under **Claude Code** → `delegated`, answer `ask` (unchanged). Under **Codex** → `no-channel` with the reason
     "Codex cannot ask and no Slack channel is configured", a `blocked` outcome, answer `deny`. **Nothing is ever left as a
     dangling `delegated` under Codex.**
3. `hooks.formatPreToolUseOutput(decision, agent)` produces one line
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask","permissionDecisionReason":"..."}}`
   which the watchdog validates and prints (exit 0 for allow/ask, exit 2 for deny, §7). Mapping:
   - `allow` ↔ verdict allow; or verdict `require_approval` + Slack `approved`, **only after the intent record carrying that
     approval has persisted** (a failed append is a `deny`, never a silent allow);
   - `deny` ↔ verdict deny; approval `denied`, `timeout`, or `unavailable`; or any internal failure (§7);
   - `ask` ↔ verdict `require_approval` with `approvals: { kind: "hook-ask" }` (local mode, no channel). The intent record is
     written first with `approval.decision = "delegated"`, then **Claude Code** prompts the human in the terminal. We do not
     see the human's answer directly: if they allow, the tool runs and `PostToolUse`/`PostToolUseFailure` produce the outcome
     record; if they deny, no outcome arrives (Claude Code fires `PermissionDenied`, an adapter for it is future work) and
     the intent record stands alone as "asked, not run". We never emit `defer`.
     **Codex cannot ask.** Its docs (read 2026-09-29) list `permissionDecision: "ask"` as "parsed but not supported yet.
     Codex marks the hook run as failed, reports the error, and continues the tool call": an `ask` sent to Codex is an
     allow. So `formatPreToolUseOutput(d, "codex")` rewrites `ask` to **`deny`** with `CODEX_ASK_UNSUPPORTED_REASON`
     (tells the user to approve out of band or have the tool reviewed). Since ADR-006 the pipeline never produces `ask` under
     Codex in the first place (`hook-ask` resolves to a recorded `no-channel` deny before the append, step 2), so this rewrite is
     a belt-and-braces guard and **no Codex intent record ever carries `delegated`**. Under Codex, a `require_approval` becomes an allow only through a `slack`
     channel; with `hook-ask` configured it is always a deny, and the setup guide must say so. (Codex's `PermissionRequest`
     hook can allow/deny Codex's own approval prompts, but it fires only when Codex would prompt anyway and has no
     `tool_use_id`; not adopted, §4.)
4. On `PostToolUse`, `pipeline.recordOutcome(tool_use_id, { status: "ok" })`. On **`PostToolUseFailure`** (Claude Code; fires
   when a tool that started executing fails; verified 2026-09-29, it does **not** fire for permission denials or validation
   rejections), `pipeline.recordOutcome(tool_use_id, { status: "error", errorClass, durationMs: duration_ms })`, where
   `errorClass` is `interrupt` when `is_interrupt` is true, else the `Exit code N` first line of `error` when present, else
   `tool-error`. The `error` text itself is display text (may carry secrets, format unstable) and is not stored.
   **Codex has no failure event**: `PostToolUse` "also runs after commands that exit with a non-zero status" and its
   `tool_response` has no stable shape, so a Codex outcome is always `{ status: "ok" }`, meaning "the tool ran and returned",
   not "succeeded". Reading an exit code out of `tool_response` is future work, stated as such in the report vocabulary.
   Fixtures: `test/fixtures/claude-code-{pretooluse,posttooluse,posttoolusefailure}.json`,
   `test/fixtures/codex-{pretooluse,posttooluse}.json` (composed from the Codex field tables and generated schemas; the Codex
   page has no PreToolUse example block).

A call that is denied (by policy, a human, a timeout, an unavailable channel, or an internal failure) gets one record with
`phase: "outcome"` and `outcome.status: "blocked"`, and it never reaches `upstream`. Blocked attempts are evidence too.

## 7. Failure behavior

Behavior depends on the call's risk class, which comes from the registry row or is `unreviewed` when there is none
(so every call has one).

**Ledger unavailable**, by risk class:

| Risk | Behavior |
|---|---|
| `read` | Allowed; record buffered locally and replayed when the ledger returns |
| `write` | **Blocked** (fail-closed) |
| `risky` | **Blocked** (fail-closed) |
| `unreviewed` | **Blocked**, same as risky: an unknown tool during an outage is the worst case, not a grey area |

**Other failures:**

| Failure | Behavior |
|---|---|
| Approvals `unavailable` (Slack configured but unreachable, non-2xx, auth failure) | `ApprovalResult.decision = "unavailable"` → **deny**; `risky` and `unreviewed` calls blocked (read and write calls never need approval). Distinct from "no channel", which is the explicit `hook-ask` kind, not an absence |
| Approval `approved` but the intent record fails to persist | **deny**. An allow is emitted only after the append succeeded (§6) |
| Registry file invalid (unknown field, bad class, missing reviewer, downgrading escalation, reserved or impersonating key, case-twin keys, §8) | Proxy refuses to start. Hook: the handler fails inside the watchdog, which emits a JSON `deny` **and** exit 2, never a plain exit 1 |
| Upstream error / `PostToolUseFailure` (Claude Code) | Outcome recorded as `error` (Codex: `ok`, see §6) |
| Hook handler crashes, exits non-zero, stalls, writes junk or too much, or the watchdog's own config is invalid | The **watchdog** emits a JSON `deny` **and** exit 2 (below) |

**Two-process fail-closed watchdog.** What the agents actually do with a PreToolUse hook, verified 2026-09-29
(Claude Code: https://code.claude.com/docs/en/hooks #exit-code-2, #other-exit-codes, #timeouts, #json-output; Codex:
https://learn.chatgpt.com/docs/hooks #pretooluse, #common-output-fields):

| Hook outcome | Claude Code | Codex |
|---|---|---|
| exit 2 (any stdout) | **Blocks**: "exit 2 blocks whether or not you print JSON: even a JSON permissionDecision of "allow" can't override it". Message = JSON deny reason if any, else stderr; Claude sees it [V] | **Blocks**: "You can also use exit code 2 and write the blocking reason to stderr" [V]. Whether JSON on exit 2 is read is undocumented [H], so we always send the deny JSON too |
| exit 0 + JSON `permissionDecision: "deny"` | **Blocks** [V] | **Blocks** [V] (also legacy `{"decision":"block"}`) |
| exit 0 + JSON `allow` | Allow [V] | Allow [V] |
| exit 0 + JSON `ask` | Prompts the user [V] | **Not supported: hook marked failed, call CONTINUES** [V] |
| exit 0 without a decision, or plain text | **Continues** [V] | **Continues** ("Exit 0 with no output is treated as success and Codex continues") [V] |
| exit 1 or any other code **without valid decision JSON** | **Continues** (non-blocking error notice): "Without valid JSON on stdout, Claude Code treats exit code 1 as a non-blocking error and proceeds with the action" [V] | Reported as a hook failure; **continues** [H, inferred from the failure wording] |
| exit 1 or any other code **with valid decision JSON** | The JSON decides: "With a parsed object that passes schema validation … Claude Code ignores the exit code and the JSON alone decides the outcome" (so exit 1 + a valid `deny` blocks) [V, re-read 2026-09-29]. **We never rely on it**: our policy stays exit 2 on every deny and every failure | Undocumented [H]; same policy |
| stdout fails JSON parsing or schema validation (exit ≠ 2); two JSON lines | **Continues** [V]; only `{...}` start/end is parsed as JSON | Unsupported fields → failed hook, **continues** [V] |
| hook reaches its `timeout` (default 600 s in both) | Output discarded, **continues**: "don't count on a stalled hook to act as a gate" [V] | Hook terminated; no decision, **continues** [H] |
| hook binary missing or not executable (exit 127) | **Continues** [V] | **Continues** [H] |
| stdout size | plain stdout and context strings capped at 10,000 characters, spilled to a file above that [V] | model-visible output spilled above ~2,500 tokens [V]; effect on a decision payload undocumented [H] |

So without help, every internal failure of our hook is an allow, in both agents. Astra's re-review showed that an
in-process supervisor cannot close this: a timer on the handler's own event loop never fires while a synchronous loop
spins, and a deny written to a stdout the handler shares can be destroyed by an early `console.log`, an oversized payload,
or truncation. The fix is a second process. The agent's hook entry runs the **watchdog** (`hooks.runWatchdog(opts)`), not
the handler:

- **Minimal by construction.** The watchdog imports only `node:child_process`, `node:fs`, `node:process`: no registry, no
  YAML, no pipeline. Its own event loop does nothing but wait for the child and the timer, so **almost** nothing can block it:
  the one synchronous step is `spawn()` itself (fork/exec inside libuv), which cannot be interrupted; the timer fires as soon
  as it returns. Everything else, stdin included, is asynchronous.
- **Reads its own stdin asynchronously and bounded** (`process.stdin` data/end events, never `fs.readFileSync(0)`, which would
  hang forever on a stdin the agent never closes), capped at `MAX_STDIN_BYTES` = 4 MiB (over → deny `stdin-too-large`, handler
  never spawned). No EOF by the deadline → deny `deadline:stdin` (never-EOF regression in `test/todo/hooks.todo.md`).
- **Spawns the handler `detached: true`**, i.e. as the leader of its own process group (Node: "the child process will be made
  the leader of a new process group and session"), with piped stdio and no shell, `AGENT_LEDGER_WATCHDOG_DEADLINE_MS` (the
  duration) **and `AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS` (the absolute deadline, epoch ms, taken when the watchdog's timer
  started, before stdin was read)** in its env, so the handler budgets its Slack wait from `deadlineAt − now` and never gets
  the full duration after a late start (Astra P2, v2.1), forwards the hook event on its stdin, and **captures the handler's
  stdout and stderr into bounded buffers**: stdout up
  to `maxOutputBytes` (+1 byte to detect overflow; default `DEFAULT_MAX_OUTPUT_BYTES` = 8,192, legal range 512–65,536, kept
  under Claude Code's 10,000-character spill limit), stderr up to `MAX_HANDLER_STDERR_BYTES` = 16 KiB. **The watchdog
  exclusively owns its stdout**; the handler never writes to the agent.
- **Accepts an allow only after `exit` (code 0) AND `close`.** Node's child_process docs (read 2026-09-29): "When the 'exit'
  event is triggered, child process stdio streams might still be open"; "The 'close' event is emitted after a process has ended
  *and* the stdio streams of a child process have been closed … since multiple processes might share the same stdio streams."
  A grandchild that inherited the pipes can therefore append to stdout after the handler exits 0; validating at `exit` would
  accept an incomplete or later-polluted buffer (Astra P1). The deadline keeps running while the pipes are open: `exit` 0 but
  no `close` by the deadline → deny `deadline:pipes-open`. A non-zero `exit` denies at once, without waiting for `close`.
- **Enforces `deadlineMs` with its own timer**, started before stdin is read or the child spawned. At the deadline it
  **SIGKILLs the handler's whole process group** (`process.kill(-pid, "SIGKILL")`; kill(2): "If pid is less than -1, then sig
  is sent to every process in the process group whose ID is -pid"), not SIGTERM, which a stalled process may ignore, and not
  the handler pid alone, which would leave grandchildren alive (Astra P2); writes the deny; exits 2 at once. It never awaits
  `exit` or `close` after the kill; unfinished handler work is abandoned. **Every failure path that follows a spawn also
  group-kills** before exiting, so no descendant *in the group* survives a deny. `ESRCH` from the kill means the group is
  already gone and is not an error; the kill uses the PGID from spawn exactly once per failure path and never again after the
  group has disappeared, because the kernel may hand that PGID to an unrelated process (v2.1). A descendant that calls
  `setsid()` leaves the group and is out of reach: a stated residual (below). The deadline is configurable (`HookTiming`, §5):
  `DEFAULT_DEADLINE_MS` = 25 s under the 30 s hook `timeout` (no Slack), 310 s under a 320 s `timeout` with Slack approvals;
  in both cases at least `WATCHDOG_MIN_MARGIN_MS` = 2 s below the agent's `timeout` (their own 600 s default must not be
  relied on), and at least `APPROVAL_MIN_MARGIN_MS` = 5 s above `approvals.timeoutMs`, validated at init (`validateHookTiming`,
  violation → exit 2). Both agents take `timeout` in seconds with no upper clamp on PreToolUse (Codex source:
  `timeout_sec.unwrap_or(600).max(1)`; only SessionEnd/Interrupt clamp to 3 s; verified 2026-09-29).
- **Writes are non-blocking, looped, and time-bounded.** A blocking `fs.writeSync` to a pipe whose reader has stopped
  draining never returns and would stall the watchdog past its own deadline (Astra P1, v2.1), so fds 1 and 2 are switched to
  non-blocking mode (`setNonBlocking`) before the first write. `fs.writeSync` "Returns: <number> The number of bytes
  written", so a short write is legal; `writeAllSync` loops on that count and retries `EAGAIN` with a short sleep, bounded by
  **time** (`WATCHDOG_WRITE_BUDGET_MS` = 1 s, under `WATCHDOG_MIN_MARGIN_MS`), not only by a count; zero progress for the whole
  budget is a failure. Any error, the budget running out, or a failed mode switch, including inside the failure reporter, is
  still **exit 2** (`write` reason on whichever fd still works, best effort, within the same budget). Nothing is lost to an
  unflushed stream: every write is synchronous and followed by `process.exit`.
- **Emits exit 2 for EVERY deny and EVERY failure path**, always with the reason on stderr (`watchdog:<class>`) AND a deny
  JSON on stdout: handler crash or non-zero exit (`handler-exit:<code>`, `handler-signal:<sig>`), oversized or invalid output
  (`output:too-large`, `output:not-json`, `output:not-object`, `output:multiple`, `output:extra-key:<key>`,
  `output:missing-key:<key>`, `output:bad-value:<key>`, `output:empty`), deadline, spawn failure (`spawn:<code>`), stdin too
  large, the handler's own init failure (`init`; the registry refusing to load happens INSIDE the handler and surfaces this
  way), the watchdog's own uncaught error (`internal`), and a valid deny from the handler (`handler-deny`, re-emitted with
  the handler's reason). This relies on the verified rule that exit 2 blocks regardless of JSON in Claude Code; for Codex the
  deny JSON covers the undocumented case. **A plain exit 1 is never used**: both agents treat it as "continue".
- **Config and init validation happen inside supervision and also deny with exit 2**: a `deadlineMs` that is non-finite,
  non-integer, ≤ 0, or leaves less than `WATCHDOG_MIN_MARGIN_MS` before `timeoutS * 1000`; a `maxOutputBytes` outside its
  range; an unknown `agent`; an empty `handlerCommand`. Reason `watchdog:config:<field>`. Misconfiguration is a block, not a
  crash the agent ignores.
- **Only a validated allow (or ask) is exit 0.** `hooks.validateHandlerOutput(raw, agent)` accepts the handler's stdout only
  if it is within the size bound, exactly one JSON object, with exactly the top-level key `hookSpecificOutput` whose value has
  exactly the keys `hookEventName: "PreToolUse"`, `permissionDecision` (allow | deny; `ask` for Claude Code only) and
  `permissionDecisionReason` (string ≤ `MAX_REASON_CHARS` = 1,000). Anything else (`updatedInput`, `additionalContext`,
  `systemMessage`, `continue`, a second object, whitespace tricks) is a deny. On success the watchdog **re-serialises** the
  parsed payload as one line; the handler's raw bytes never reach the agent. All watchdog writes are synchronous
  (`fs.writeSync` on fds 1 and 2) and followed by `process.exit`, so no verdict is lost to an unflushed stream. Its exit code
  is only ever 0 or 2. Runtime tests: `test/todo/hooks.todo.md`.

**Residual limits, stated honestly (all local-mode; see the trust boundary in §3).** Each limit below names its mitigation;
none is closed by our code, and the honest summary is: local mode is visibility, tamper-evident logging and best-effort
gating; enforcement is server mode. Items added in v2.1 (Astra 2026-09-30) are marked.
- **Protected launch environment (v2.1).** Codex's managed `mcp_servers` matcher checks the executable and its arguments, not
  the environment or the working directory, so `NODE_OPTIONS=--import=/tmp/evil.mjs codex` preloads attacker code into the
  "approved" proxy process, and `PATH`/interpreter swaps do the same for any script. *Mitigation:* launch the proxy and the
  watchdog through a wrapper that clears `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE` and pins the interpreter
  by absolute path, or ship them as a compiled single binary (no interpreter to redirect), and point the managed matcher at
  that wrapper or binary; the heartbeat record names the resolved interpreter and `NODE_OPTIONS` state so a preload is at
  least visible. *Enforcement:* server mode, where the proxy is not on the user's machine.
- **`setsid()` escape (v2.1).** A handler descendant that calls `setsid()` starts its own session and group; the group kill
  does not reach it and the watchdog does not walk the process tree. *Mitigation:* the deadline still fires and the deny is
  still emitted (the escapee cannot change the verdict, only linger), the handler command is ours and spawns nothing that
  calls `setsid`, and the orphan is bounded by the agent's own hook timeout only if it inherited the hook's group, which by
  definition it did not. Recorded as a residual, tested as such (`hooks.todo.md`).
- **Output the agent never reads (v2.1).** If the agent stops draining the hook's stdout, the time-bounded write gives up
  after `WATCHDOG_WRITE_BUDGET_MS` and exits 2; the exit code still blocks in Claude Code, and in Codex the stderr reason may
  be partial. *Mitigation:* the verdict never depends on the JSON alone (exit 2 on every deny).
- **`<proxy>_` impersonation without managed config.** Below, under Codex.

The watchdog is a process too; whatever prevents *it* from writing output is outside
its reach, and in every such case **both agents continue**: the watchdog binary is missing, not executable, or its
interpreter is gone (exit 127); the watchdog itself is killed by the OS (OOM, SIGKILL) before writing; the user removes or
edits the hook entry in their own settings (Claude Code `settings.json`; Codex `hooks.json`/`config.toml`, where changing a
non-managed hook also resets its trust hash and Codex skips it until re-trusted); `disableAllHooks` / `[features].hooks =
false` in non-managed config (neither can disable *managed* hooks); and, Codex only, "some specialized tool paths can opt
out of the default hook path" and hosted tools (`WebSearch`) never fire hooks. **Orphaning:** if the watchdog itself is
SIGKILLed (OOM, or the agent's timeout after a deadline misconfiguration), nobody kills the detached handler group and it runs
on as an orphan. Codex kills the *hook's* process group at its timeout (verified in `codex-rs/hooks/src/engine/command_runner.rs`:
`process_mode(NewSession)`, `kill_process_group` on drop), but the detached handler is a different group, so that kill does not
reach it either; Claude Code's process-tree behaviour at timeout is undocumented [H]. Hence the deadline must sit below the hook
timeout (validated at init) and the orphan is a stated residual, not a covered case. **Codex MCP impersonation (ADR-006):**
a locally configured MCP server named `<proxyServerName>_` or `<proxyServerName>-` produces the proxy's exact hook names
(codex-rs trims `_` at the join, `-` sanitises to `_`), so the hook alone would answer `governed-by-proxy`. Our own mitigations:
the proxy's name is long and random (unguessable, `CODEX_PROXY_SERVER_NAME_MIN_LENGTH` = 16, refused if it ends in `_`), and
the proxy refuses any upstream not on its allowlist (§9), so an impostor gains a hook allow but no credentials. The **closer**
lives in Codex's managed configuration, below. Mitigations live in the agents' configuration, not in our code:
- **Claude Code:** deploy the hook through **managed settings** (`managed-settings.json`, MDM, or server-managed settings)
  with **`allowManagedHooksOnly: true`**, so user, project, local, and plugin hooks are blocked and the user cannot remove
  ours (https://code.claude.com/docs/en/settings-reference#allowmanagedhooksonly, verified 2026-09-29; precedence:
  https://code.claude.com/docs/en/settings). Managed hooks merge with, and cannot be disabled by, lower levels.
- **Codex:** deploy through **`requirements.toml`** (`/etc/codex/requirements.toml`, MDM, or cloud-managed) with
  **`allow_managed_hooks_only = true`**, **`[features].hooks = true`** pinned, and the hook under `[[hooks.PreToolUse]]` with
  `timeout = 30` (`320` with Slack approvals), scripts installed under `[hooks].managed_dir` (https://learn.chatgpt.com/docs/hooks
  #managed-hooks-from-requirementstoml, verified 2026-09-29). Managed hooks are "trusted by policy and can't be disabled from the
  user hook browser". **And an `mcp_servers` allowlist in the same `requirements.toml`** (verified 2026-09-29,
  https://learn.chatgpt.com/docs/enterprise/managed-configuration: "The local client enables an MCP server only when both its
  name and identity match an approved entry; otherwise, the client disables it"; "If `mcp_servers` is present but empty, the
  local client disables all MCP servers") with exactly one entry, the proxy. Identity is the stdio `command` or the HTTP `url`;
  source (`codex-rs/config/src/mcp_requirements.rs`) shows the simple form `identity = { command = "node" }` compares the
  executable string only, so use the **structured matcher**, which also pins the args:
  `identity = { command = { executable = "/usr/local/bin/node", args = [{ match = "exact", value = "/opt/agent-ledger/proxy.js" }] } }`
  (or `identity = { url = "https://…/mcp" }` for the HTTP proxy). Then `<proxyServerName>_` cannot be enabled *through Codex's
  configuration*, and the name-impersonation residual is narrowed to what the matcher does not see: the launch environment
  (above) and anything the machine's user does outside Codex. Unmanaged installs keep the full residual, stated in the setup guide.
- A **health check** in both: a `SessionStart` hook that verifies the watchdog runs and writes a heartbeat record (with the
  resolved interpreter path and whether `NODE_OPTIONS` was set); the report flags a session that has tool calls but no
  heartbeat, a heartbeat but a gap in `PreToolUse` intent records, and (v2.1) every `handoff-to-proxy` record with no proxy
  record for its callId.
- Server mode has none of this: the proxy holds the credentials, so a dead hook, an escaped process, or a preloaded module on
  the agent's machine cannot let a call through, because the call has to reach the proxy to happen at all (§3 trust boundary).

The read/write split is an assumption to test in Phase 1 calls (open question in `_state.md`).

## 8. Policy: the reviewed tool registry (ADR-004)

Three Astra review rounds kept finding bypasses in name-regex classification (`get_then_deploy`, `wipe_bucket`,
`deploy_production({environment:"dev"})`), and unknown names fell through to allow. Regexes do not converge as an
authorization boundary, so ADR-004 replaced them. **Authority is a reviewed registry** (`policies/tools.yaml`;
example in `policies/tools.example.yaml`):

```yaml
version: 1
servers:
  github:
    trusted: true                       # may this server's MCP annotations SUGGEST a class at review time?
    tools:
      list_repos:   { class: read,  reviewedBy: ryan, reviewedAt: 2026-09-29 }
      create_issue: { class: write, reviewedBy: ryan, reviewedAt: 2026-09-29 }
      delete_repo:  { class: risky, reviewedBy: ryan, reviewedAt: 2026-09-29 }
      update_branch_protection:
        class: write
        reviewedBy: ryan
        reviewedAt: 2026-09-29
        escalateWhen: [{ argPattern: { branch: "^(main|master|release/.*)$" }, to: risky }]
  "builtin:claude-code":                # Claude Code's built-in tools (hook collector); reserved namespace, see below
    trusted: true
    tools: { Read: {class: read, ...}, Edit: {class: write, ...}, Bash: {class: risky, note: "a shell can do anything", ...} }
```

**Server identity.** Registry keys are matched **exactly, case-sensitively, by own property** (`Object.hasOwn`, or a
`Map` the loader builds). A key is one of two things:
- **`builtin:claude-code`** or **`builtin:codex`** (`BUILTIN_SERVER_KEYS`), the only legal keys containing `:`. Built-in
  tools live here because MCP can never reach them:
  - Claude Code accepts only `[A-Za-z0-9_-]` in an MCP server name (`claude mcp add`), and in every `mcp__<server>__<tool>`
    callable name any other character is replaced with `_` (https://code.claude.com/docs/en/mcp, verified 2026-09-29). A
    plugin server registers as `plugin:<plugin>:<server>` internally, yet its tools appear as `mcp__plugin_<plugin>_<server>__`.
  - Codex's `codex mcp add` accepts `[A-Za-z0-9_:@/.-]`, so **`builtin:codex` is a legal raw server name there**, but the
    hook sees the model-visible name: `sanitize_responses_api_tool_name` keeps only ASCII alphanumerics and `_`, replaces
    everything else (`:`, `-`, `@`, `/`, `.`) with `_`, appends a hash suffix on collisions, and `mcp__` is prepended
    (openai/codex `codex-rs/codex-mcp/src/mcp/mod.rs`, `codex-rs/codex-mcp/src/tools.rs`,
    `codex-rs/core/src/tools/handlers/mcp.rs`, read 2026-09-29). So a Codex server named `builtin:codex` fires the hook as
    `mcp__builtin_codex__<tool>`: server `builtin_codex`, refused below. Consequence for reviewers: a Codex MCP registry key
    is written in sanitised form (`brave_search`, not `brave-search`), and a hash-suffixed name (`builtin_codex_a1b2c3`) is
    its own unreviewed server, never a built-in.
  So `mcp__claude-code__Read`, `mcp__builtin_claude-code__Bash`, `mcp__codex__Bash` and `mcp__builtin_codex__Bash` split into
  servers `claude-code`, `builtin_claude-code`, `codex`, `builtin_codex`: not these keys, so they inherit nothing and are
  `unreviewed` → `require_approval` (regression rows in `test/registry.test.ts`), and the collector refuses them outright (§6).
  The two built-in keys are distinct servers: a Codex `Read` never sees the Claude Code row and a Claude Code `apply_patch`
  never sees the Codex row.
- an **MCP server name** matching `/^[A-Za-z0-9_-]+$/`.

**`proxy.codex.serverName` (ADR-006).** A top-level, optional `proxy: { codex: { serverName } }` names the Agent Ledger proxy as
Codex sees it. The loader accepts only Codex's hook-visible form (`CODEX_PROXY_SERVER_NAME_RE`: `[A-Za-z0-9_]`, no leading or
trailing `_`, because codex-rs trims those at the `__` join and a name ending in `_` could never match itself; **no internal
`__`** (v2.1), because the collector splits the hook name at the first `__` after `mcp__`, so `a__b` would be read as server
`a` and could never match itself either), at least 16
characters (a random suffix, so the name is not guessable), not normalising to a reserved builtin name, and not equal
(case-insensitively) to any `servers` key: the proxy is not an upstream. Under Codex this name is the only MCP server the hook
ever allows (`governed-by-proxy`), and only because the proxy itself applies this registry to the raw upstream identity.

The loader **refuses** a registry with: any other key containing `:` (`builtin:cursor` waits for a cursor adapter); a
non-builtin key that **normalises** (lowercase, strip everything outside `[a-z0-9]`) to `claudecode`, `builtinclaudecode`,
`codex` or `builtincodex` (`claude-code`, `Claude_Code`, `builtin_claude-code`, `builtin-claude-code`, `Codex`,
`builtin_codex`), whichever agent the registry serves; two server keys, or two tool keys under one
server, that are equal case-insensitively (`github` + `GitHub`, `Read` + `read`), because a case twin must never be
mistaken for a reviewed row while lookups stay case-sensitive; and any server or tool key in `RESERVED_KEYS`
(`__proto__`, `constructor`, `prototype`) or otherwise `in Object.prototype` (`toString`, `hasOwnProperty`, ...). Verified
2026-09-29 with `yaml` 2.9.1: a YAML `__proto__` key parses as an own property (no prototype pollution) and duplicate keys
are a parse error, but `"constructor" in servers.github` is `true` and `servers.github.tools["constructor"]` returns
`Object.prototype.constructor`, so a naive `if (!row)` check would skip the unreviewed branch. Hence own-property lookups
everywhere (`evaluate`, `argPattern` matching, the test evaluator) and the refusals above.

**Evaluation** (`policy.evaluate(registry, call)`):

| Situation | Verdict | Risk | ruleId |
|---|---|---|---|
| Server not in registry (own-property, case-sensitive: `GitHub`, `constructor`, `__proto__`, `claude-code` are all "not in") | `require_approval` | `unreviewed` | `unreviewed:<server>/<tool>` |
| Server known, tool not listed (same rule: `github/constructor`, `github/toString` are "not listed") | `require_approval` | `unreviewed` | `unreviewed:<server>/<tool>` |
| Row class `read` | `allow` | `read` | `registry:<server>/<tool>` |
| Row class `write` | `allow` | `write` | `registry:<server>/<tool>` |
| Row class `risky` | `require_approval` | `risky` | `registry:<server>/<tool>` |
| Row plus an `escalateWhen` whose every `argPattern` matches | per the raised class | raised class | `registry:<server>/<tool>#escalate:<i>` |

**Invariant: nothing downgrades.** The effective class is `max(row.class, every matching escalation.to)`.
There is no `unless`, no exception, and no argument that lowers a class: `environment: "dev"` on a risky row is still
risky. The loader refuses a registry whose escalation `to` does not rank above the base class (`write → write`,
`risky → write`), and `evaluate()` takes the max regardless, so a downgrade cannot slip in either way.
`argPattern` values are case-insensitive regexes over `String(args[key])`; a missing arg never matches.
`trusted` has no effect on `evaluate()`.

**Suggestions are not authority.** `policies/suggestions.yaml` (header: "SUGGESTIONS ONLY, NEVER AUTHORITY (ADR-004)")
holds the old regexes, extended with Astra's bypass verbs. They are read by exactly one function, `policy.suggestClass(tool, opts)`,
which proposes a class while a human builds the registry from `tools/list`. For servers marked `trusted`, the MCP
annotations join in (`readOnlyHint: true → read`, `destructiveHint: true → risky`, else `write`); when the sources
disagree, the higher class wins and both are listed in `sources`. Annotation field names and the rule "clients MUST
consider tool annotations to be untrusted unless they come from trusted servers" were verified against
https://modelcontextprotocol.io/specification/2026-07-28/server/tools (unchanged from 2025-06-18; schema defaults:
`readOnlyHint` false, `destructiveHint` true, `idempotentHint` false, `openWorldHint` true). A suggestion is never written
to the registry without a human's `reviewedBy`/`reviewedAt`.

**Consequence.** Newly added tools cost an approval until reviewed. There is no silent fail-open. Everything is logged,
whatever the verdict.

## 9. Security of the proxy itself

- The proxy is the credential boundary. Agents never receive upstream secrets.
- The agent's own credential stops at identity: `ToolCall` is built from `IncomingCall` by explicit field
  projection (§5), never by spreading it, so no `credential` property exists on anything the ledger stores.
  Runtime tests assert both the projected object and the stored record JSON (`test/todo/pipeline.todo.md`).
- Redaction (secrets and PII patterns) runs **before** hashing and storage. Raw args are never persisted.
- The ledger can only be appended to. Edits and deletes are impossible through the API, and any tampering
  is caught by chain verification plus the daily anchor.
- HTTP front: `Origin` validated against `allowedOrigins`, default bind `127.0.0.1`, incoming `Mcp-Session-Id` ignored (§3).
- Its own supply chain: dependencies exact-pinned, no install scripts (`.npmrc`), and upstream MCP servers listed on an allowlist in config.

## 10. Testing (lists now, tests after Gate 2)

Vitest. Must-have tests:
- Editing any one ledger record makes `verify()` fail at that record.
- A registry table test: at least 20 calls with their expected verdicts, including the unreviewed regression rows
  `get_then_deploy`, `wipe_bucket`, `terminate_instance`, `push_to_main`, `deploy_production({environment:"dev"})`.
- The hook fixtures in `test/fixtures/` keep the documented field names (format-drift guard): Claude Code's three events and
  Codex's two (`model`, `turn_id`, nullable `transcript_path`, no `PostToolUseFailure`).
- Identity regressions: `mcp__claude-code__Read`, `mcp__claude-code__Edit`, `mcp__builtin_claude-code__Bash`,
  `mcp__codex__Bash`, `mcp__builtin_codex__Bash` never inherit a `builtin:*` row under either agent; `github/constructor`,
  server `constructor`, `__proto__` are unreviewed; the loader refuses reserved, impersonating, and case-twin keys and
  accepts exactly the two built-in keys.
- Watchdog (runtime, real processes; `test/todo/hooks.todo.md`): an infinite-loop handler → deny + exit 2 before the deadline
  plus 500 ms; junk on stdout → deny; output over the cap → deny; a handler exiting 1 with a valid allow → deny; an allow
  payload with an extra key → deny; an invalid `deadlineMs` (NaN, ∞, 0, ≥ timeout, margin too small) → deny + exit 2, never
  exit 1; a valid allow → exit 0 with the re-serialised payload; a valid `ask` → exit 0 for Claude Code, deny for Codex; the
  watchdog's exit code is only ever 0 or 2.
- Codex adapter: `ask` → `deny` with `CODEX_ASK_UNSUPPORTED_REASON` and the output never contains `"ask"`; a non-object
  `tool_input` → deny; the Codex PostToolUse fixture (exit code 1 in `tool_response`) → outcome `ok`.
- Watchdog, Astra re-review (runtime): a grandchild holding the handler's pipes → no allow at `exit`, deny `deadline:pipes-open`
  at the deadline, both pids gone; group kill leaves no survivors on every failure path; a short-write injection (1 byte per
  `writeSync`) still emits the full payload, and a throwing `writeSync` on both fds is still exit 2; a never-EOF stdin → deny
  `deadline:stdin`, handler never spawned; `validateHookTiming` cases (approval ≥ deadline, deadline ≥ timeout, NaN/∞/0/1.5).
- ADR-006 (Codex MCP identity): `github_`/`list_repos` and `github`/`_list_repos` both produce `mcp__github__list_repos` and are
  **never** allowed under Codex despite the reviewed `github/list_repos` row; a non-proxy `mcp__x__y` under Codex → deny with
  `CODEX_MCP_NOT_PROXIED_REASON`; a proxy tool → allow + `governed-by-proxy` with exactly one `handoff-to-proxy` intent record;
  `<proxy>_` is asserted as the stated residual; `proxy.codex.serverName` refusal rows including internal `__`
  (`test/codex-proxy.test.ts`, then the product functions).
- v2.1 (Astra 2026-09-30; scenarios in `test/todo/`): a full, undrained stdout pipe → exit 2 within `WATCHDOG_WRITE_BUDGET_MS`
  + 500 ms, never a stall past the deadline; `writeAllSync` fails on zero progress; `ESRCH` on the group kill is tolerated and
  the PGID is signalled once per failure path; a `setsid` descendant is asserted as the stated residual; the handler receives
  `AGENT_LEDGER_WATCHDOG_DEADLINE_AT_MS` and its Slack wait shrinks by the time the watchdog spent on stdin; `reconcileHandoffs`
  flags a handoff with no proxy record and matches one inside the grace window; Slack: forged nonce / wrong `message.ts` ignored,
  competing and late clicks and duplicate envelopes settle exactly once, one router and one socket per process across concurrent
  approvals, `deadlineAt` cap.
- ADR-006 (final decision): under Codex + hook-ask, the intent record carries `no-channel` and a reason, and no record says
  `delegated`; under Codex + Slack, `denied` / `timeout` / `unavailable` are recorded with the outcome `blocked`.
- Slack contract: message blocks carry the callId in `block_id` and both button `value`s; a click for another callId or from a
  non-approver is ignored; `approver` is the Slack user id; `chat.update` closes the message (`test/approvals-shape.test.ts` now,
  `test/todo/approvals.todo.md` after Gate 2).
- An approval timeout blocks the call and records `timeout`; an unreachable channel records `unavailable` and blocks.
- An approved risky call is allowed only after the intent record persisted; a failed append after approval is a deny.
- A secret in args never appears in stored records.
- Ledger down + risky or unreviewed call means the call is blocked.
- A local-mode JSONL chain verifies after restart.

## 11. Environment notes

- Node is installed (v25; `canonicalize` needs ≥22). Docker is **not** installed on the Mac yet. Server mode needs Docker
  (or the homelab Kubernetes cluster) before any runtime work. The framework phase needs neither.

## 12. Open questions (market questions for the Gate 1 calls; none is answered by code)

1. **Laptops or servers?** Do design partners run agents on developer laptops (local mode: visibility + best-effort gating) or
   on servers/CI (server mode: enforcement)? Which one would their auditor be asked about first?
2. **Is visibility enough?** Would a GRC lead pay for local-mode evidence ("what the agents did through the governed paths,
   tamper-evident") knowing the machine's user can bypass it, or only for server-mode enforcement evidence?
3. **Managed installs?** Are their Claude Code / Codex installs centrally managed (managed settings, `requirements.toml`, MDM)?
   Without that, every §7 residual is fully open and the setup guide must say so.
4. **Which agents, which tools?** Claude Code, Codex, both, something else? Mostly built-in tools (shell, file edits) or MCP
   servers? (Decides the first collector and whether the Codex proxy path matters at all.)
5. **Approval loop.** Is a 5-minute Slack approval (`SLACK_HOOK_TIMING`) a workable loop for their engineers, and is "risky =
   deny unless Slack is configured" acceptable under Codex (§6)? Who would be on the approver list?
6. **Fail-open for reads?** Do they accept read-only calls proceeding while the ledger is down (§7), or must everything block?
7. **Proxy down: closed or open?** When the proxy is unreachable, do they want agents blocked (fail-closed) or working unlogged?
8. **What the auditor accepts.** Will their auditor accept a generated report mapped to CC6.1/CC7.2/CC8.1, or insist on raw log
   access? Has an auditor already asked about AI agents (the Gate 1 kill assumption)?
9. **Differentiation.** MCP gateways with audit exist (MintMCP, Runlayer, Cytra, ACP; `diligence-2026-09-28.md`). What would
   make them pick an evidence-first product over a gateway they may already have?
