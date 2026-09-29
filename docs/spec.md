# Agent Ledger: Framework Spec (v2)

**Date:** 2026-09-29 · **Status:** v2 fix round (Astra findings 1-6), awaiting Astra re-review · **Author:** Ryan + Fable
**Brain:** `~/Desktop/AgentLedger/` (read `_state.md` first)
**Changed in v2:** ADR-004 reviewed allowlist (§7, §8); MCP 2026-07-28 (§3, §4); hook collector for coding agents (§3, §4, §6); RFC 8785 hashing and IETF draft field alignment (§5). Every external format below was checked against its primary source on 2026-09-29; the URLs are inline and the findings are in the vault (`diligence-2026-09-28.md`, "Verified by Fable").
**Changed in the v2 fix round (2026-09-29, after Astra's gate FAIL):** built-in tools moved to the reserved `builtin:claude-code` namespace and the loader refuses impersonating or case-twin keys (§6, §8); fail-closed hook supervisor and an honest list of what it cannot catch (§7); own-property registry lookups and refused prototype keys (§8); `ApprovalChannel` union with `hook-ask`, `unavailable` → deny, allow only after the intent record persists (§5, §6, §7); `PostToolUseFailure` event and `error` outcome mapping (§3, §6); the IETF draft alignment is now stated as conceptual, not byte-compatible (§5).

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
| **Local** | **Hook collector** (Claude Code `PreToolUse`/`PostToolUse`/`PostToolUseFailure`) **plus** MCP proxy over stdio | Developer laptop | Append-only JSONL file | Visibility. Per-user hooks can be edited; org-wide managed hooks cannot be disabled by the user. |
| **Server** | MCP proxy over Streamable HTTP | Docker container anywhere: laptop, homelab, VM, or the customer's cloud | Postgres | Audit-grade. The proxy holds the credentials, so the agent can't go around it. |

**Why two collectors in local mode.** An MCP proxy never sees a coding agent's built-in tools (Claude Code's
Bash, Edit, Write, WebFetch). Claude Code hooks fire for every tool, built-in and MCP, can answer
`allow | deny | ask`, and can be enforced through managed settings (`allowManagedHooksOnly`), so the hook
collector is the primary local collector and the MCP proxy covers agents that only speak MCP.
Source: https://code.claude.com/docs/en/hooks (read 2026-09-29).

**Codex.** Verified 2026-09-29 at https://learn.chatgpt.com/docs/hooks (redirect target of
developers.openai.com/codex/hooks): Codex hooks are **enabled by default, not experimental**, use the same
`session_id`/`tool_name`/`tool_input`/`tool_use_id`/`tool_response` fields plus `turn_id`, accept the same
`hookSpecificOutput.permissionDecision` output block, and can be enforced through `requirements.toml`
(`allow_managed_hooks_only`). That contradicts the "Codex hooks are experimental" assumption in the diligence
note. Codex stays **MCP-proxy-only in this spec version as a scoping decision**, not a technical limitation; a
Codex hook adapter looks like a small variant of `src/hooks/` and is Ryan's call (open question in `_state.md`).

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
| 1b | `src/hooks/` | Parse a Claude Code hook event into an `IncomingCall` (PreToolUse) or an `Outcome` (PostToolUse, PostToolUseFailure); format a `HookDecision` as the documented `hookSpecificOutput` JSON; run the PreToolUse handler under the fail-closed supervisor (§7) | types |
| 2 | `src/upstream/` | MCP clients to the real tool servers; combines their tool lists (with annotations) | types, secrets |
| 3 | `src/identity/` | Authenticate the agent; create and track sessions | types |
| 4 | `src/secrets/` | Hand upstream credentials to `upstream/` only. Backends: env/file (local), Secrets Manager (later). | types |
| 5 | `src/policy/` | Classify a ToolCall from the reviewed registry (`evaluate`); propose classes for review (`suggestClass`) | types |
| 6 | `src/approvals/` | Ask a human (Slack) and return an ApprovalResult; `timeout` and `unavailable` both mean deny. The `hook-ask` channel never reaches this module (§6) | types |
| 7 | `src/ledger/` | Redact, hash-chain (RFC 8785 + SHA-256), append, verify | types, `canonicalize` |
| 8 | `src/anchor/` | Record the chain head daily somewhere hard to edit. Backends: local file (now), S3 Object Lock (later). | types (it receives the head hash) |
| 9 | `src/report/` | Turn ledger records for a date range into PDF + CSV mapped to SOC 2 criteria | types, ledger |
| n/a | `src/pipeline/` | Wire 3 → 5 → 6 → 7 → 2 → 7 for one call (the only module that knows the order). `createPipeline(deps)` returns `{ handle, decide, recordOutcome }` | identity, policy, approvals, ledger, upstream, types |

**Later, not scaffolded now:** 10, intent-vs-action drift detection (v2: `declare_plan` tool, rules, an
LLM judge, baselines); 11, the Terraform module; 12, a Codex hook adapter (see §3).

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

type ApprovalChannel = { kind: "slack"; channelId: string; timeoutMs: number } | { kind: "hook-ask" };   // required in PipelineDeps: "no channel" is said out loud
interface ApprovalResult {
  callId: string;
  decision: "approved" | "denied" | "timeout" | "unavailable" | "delegated";   // only `approved` can become an allow; `delegated` only with hook-ask
  approver?: string; decidedAt: string; channel: ApprovalChannel["kind"];
}

type Phase = "intent" | "outcome";
interface LedgerRecord {
  id: string; phase: Phase; call: ToolCall;   // args redacted before hashing
  policy: PolicyDecision; approval?: ApprovalResult;
  outcome?: { status: "ok" | "error" | "blocked"; errorClass?: string; durationMs?: number };
  parentRecordId: string | null;              // previous record's id; null on genesis
  prevHash: string;                           // previous record's hash; "0" on genesis
  hash: string;                               // SHA-256 hex of JCS(record without `hash`)
  writtenAt: string;
}

interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; }
interface ToolInfo { server: string; name: string; description?: string; inputSchema?: unknown; annotations?: ToolAnnotations; }

interface HookDecision { decision: "allow" | "deny" | "ask"; reason: string; callId: string; }

interface IdentityService { resolveAgent(cred: AgentCredential): Promise<AgentId>; startSession(agentId: AgentId, onBehalfOf?: string): Promise<SessionId>; }
interface PipelineDeps { identity: IdentityService; registry: ToolRegistry; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalChannel; }

// Server identity (§8). MCP server names in Claude Code are [A-Za-z0-9_-] only; anything else becomes `_` in the
// mcp__<server>__<tool> name, so no MCP call can ever carry a `:` in its server segment.
const BUILTIN_NAMESPACE = "builtin:"; const BUILTIN_SERVER = "builtin:claude-code";
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;
const RESERVED_SERVER_NAMES = ["claudecode", "builtinclaudecode"];   // after lowercase + strip non-[a-z0-9]
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

**Decide-only mode** (`pipeline.decide`, run by the `hook` command under `hooks.runHookSupervised`, §7):

1. `hooks.parseHookInput(stdin)` → `PreToolUseEvent`; `hooks.toIncomingCall(ev, credential)` sets `callId = tool_use_id`,
   `args = tool_input`, and names the server:
   - `mcp__<server>__<tool>` → `<server>/<tool>`, split at the first `__` after the prefix, server segment verbatim (plugin
     form `plugin_<plugin>_<server>` included). If the server segment, lowercased and stripped of everything outside
     `[a-z0-9]`, is `claudecode` or `builtinclaudecode`, the collector **throws** (→ deny): an MCP server is impersonating
     the built-in namespace. `mcp__claude-code__Read` therefore never resolves to the built-in `Read` row; if it somehow
     reached the registry it would be server `claude-code`, an unreviewed MCP server, and `require_approval`.
   - a name without the prefix but with an `mcp_server` provenance object (Claude Code ≥ 2.1.274) → throw (malformed).
   - any other name → built-in tool on server **`builtin:claude-code`**. MCP cannot produce a `:` in a server segment
     (Claude Code allows only `[A-Za-z0-9_-]` in MCP server names and rewrites anything else to `_`, verified 2026-09-29 at
     https://code.claude.com/docs/en/mcp), so this key is unreachable from MCP by construction.
2. Steps 1-4 above, then **stop**: nothing is executed, Claude Code runs the tool itself.
3. `hooks.formatPreToolUseOutput(decision)` prints
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask","permissionDecisionReason":"..."}}`
   with exit code 0. Mapping:
   - `allow` ↔ verdict allow; or verdict `require_approval` + Slack `approved`, **only after the intent record carrying that
     approval has persisted** (a failed append is a `deny`, never a silent allow);
   - `deny` ↔ verdict deny; approval `denied`, `timeout`, or `unavailable`; or any internal failure (§7);
   - `ask` ↔ verdict `require_approval` with `approvals: { kind: "hook-ask" }` (local mode, no channel). The intent record is
     written first with `approval.decision = "delegated"`, then Claude Code prompts the human in the terminal. We do not
     see the human's answer directly: if they allow, the tool runs and `PostToolUse`/`PostToolUseFailure` produce the outcome
     record; if they deny, no outcome arrives (Claude Code fires `PermissionDenied`, an adapter for it is future work) and
     the intent record stands alone as "asked, not run". We never emit `defer`.
4. On `PostToolUse`, `pipeline.recordOutcome(tool_use_id, { status: "ok" })`. On **`PostToolUseFailure`** (fires when a tool
   that started executing fails; verified 2026-09-29, it does **not** fire for permission denials or validation rejections),
   `pipeline.recordOutcome(tool_use_id, { status: "error", errorClass, durationMs: duration_ms })`, where `errorClass` is
   `interrupt` when `is_interrupt` is true, else the `Exit code N` first line of `error` when present, else `tool-error`. The
   `error` text itself is display text (may carry secrets, format unstable) and is not stored. Fixtures:
   `test/fixtures/claude-code-{pretooluse,posttooluse,posttoolusefailure}.json`.

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
| Registry file invalid (unknown field, bad class, missing reviewer, downgrading escalation, reserved or impersonating key, case-twin keys, §8) | Proxy and hook refuse to start, whatever the call |
| Upstream error / `PostToolUseFailure` | Outcome recorded as `error` |
| Hook handler throws, rejects, gets malformed stdin, or misses its internal deadline | The **fail-closed supervisor** emits a JSON `deny` **and** exit 2 (below) |

**Fail-closed hook supervisor.** What Claude Code actually does with a PreToolUse hook, verified 2026-09-29 at
https://code.claude.com/docs/en/hooks (#exit-code-output, #timeouts, #exit-code-2-behavior-per-event):

| Hook outcome | Claude Code's behavior |
|---|---|
| exit 2 (any stdout) | **Blocks** the tool call; JSON cannot override it |
| exit 0 + JSON `permissionDecision: "deny"` | **Blocks** |
| exit 0 + JSON `allow` / `ask` / `defer` | That decision |
| exit 0 without a decision | **Continues** through the normal permission flow |
| exit 1 or any other code, no valid JSON | **Continues** (non-blocking error notice) |
| stdout that fails JSON parsing or schema validation (exit ≠ 2) | **Continues** |
| hook reaches its `timeout` (default 600 s) | Output discarded, **continues**: "don't count on a stalled hook to act as a gate" |
| hook binary missing or not executable (exit 127) | **Continues** |

So without help, every internal failure of our hook is an allow. The `hook` command therefore never runs the handler bare;
it runs it through `hooks.runHookSupervised(handler, { deadlineMs })`:

- The supervised region covers reading and parsing stdin, `toIncomingCall`, `pipeline.decide`, and serialisation. A thrown
  error, a rejected promise, malformed stdin, an `unhandledRejection`/`uncaughtException`, or an unserialisable decision all
  become stdout `{"hookSpecificOutput":{...,"permissionDecision":"deny","permissionDecisionReason":"supervisor:<class>"}}`,
  the same reason on stderr, and **exit 2**. Both channels, because exit 2 blocks even if stdout were lost, and the JSON gives
  the human a readable reason.
- An internal deadline (`DEFAULT_DEADLINE_MS` = 25 s) fires **before** the hook `timeout` we configure in settings
  (`HOOK_TIMEOUT_S` = 30 s; Claude Code's own default is 600 s and must not be relied on). A deadline miss is a deny with
  reason `supervisor:deadline`. `runHookSupervised` refuses a `deadlineMs` that is not below the configured timeout.
- The supervisor never throws and never exits 0 without a decision. Runtime tests: `test/todo/hooks.todo.md`.

**Residual limits, stated honestly.** The supervisor runs inside the hook process; whatever prevents that process from
writing output is outside its reach, and in every such case **Claude Code continues**: the hook binary is missing, not
executable, or its interpreter is gone (exit 127); the process is killed by the OS (OOM, SIGKILL) before writing; the
user removes or edits the hook entry in their own settings; `disableAllHooks` is set in non-managed settings (this one
cannot disable *managed* hooks). Mitigations live in Claude Code's configuration, not in our code:
- Deploy the hook through **managed settings** (`managed-settings.json`, MDM, or server-managed settings) with
  **`allowManagedHooksOnly: true`**, so user, project, local, and plugin hooks are blocked and the user cannot remove ours
  (https://code.claude.com/docs/en/settings-reference#allowmanagedhooksonly, verified 2026-09-29; managed settings
  precedence: https://code.claude.com/docs/en/settings). Managed hooks merge with, and cannot be disabled by, lower levels.
- A **health check**: a `SessionStart` hook that verifies the binary runs and writes a heartbeat record; the report flags a
  session that has tool calls but no heartbeat, or a heartbeat but a gap in `PreToolUse` intent records.
- Server mode has none of this: the proxy holds the credentials, so a dead hook cannot let a call through.

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
- **`builtin:claude-code`**, the one legal key containing `:`. Built-in tools live here because MCP can never reach it:
  Claude Code accepts only `[A-Za-z0-9_-]` in an MCP server name (`claude mcp add`), and in every `mcp__<server>__<tool>`
  callable name any other character is replaced with `_` (https://code.claude.com/docs/en/mcp, verified 2026-09-29). A
  plugin server registers as `plugin:<plugin>:<server>` internally, yet its tools appear as `mcp__plugin_<plugin>_<server>__`.
  So `mcp__claude-code__Read`, `mcp__claude-code__Edit`, and `mcp__builtin_claude-code__Bash` split into servers
  `claude-code` and `builtin_claude-code`: not this key, so they inherit nothing and are `unreviewed` → `require_approval`
  (regression rows in `test/registry.test.ts`), and the collector refuses them outright (§6).
- an **MCP server name** matching `/^[A-Za-z0-9_-]+$/`.

The loader **refuses** a registry with: any other key containing `:` (`builtin:codex` waits for a real Codex adapter); a
non-builtin key that **normalises** (lowercase, strip everything outside `[a-z0-9]`) to `claudecode` or `builtinclaudecode`
(`claude-code`, `Claude_Code`, `builtin_claude-code`, `builtin-claude-code`); two server keys, or two tool keys under one
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
- The hook fixtures in `test/fixtures/` keep the documented field names (format-drift guard), PostToolUseFailure included.
- Identity regressions: `mcp__claude-code__Read`, `mcp__claude-code__Edit`, `mcp__builtin_claude-code__Bash` never
  inherit `builtin:claude-code` rows; `github/constructor`, server `constructor`, `__proto__` are unreviewed; the loader
  refuses reserved, impersonating, and case-twin keys.
- Supervisor: a thrown error → deny + exit 2; a missed deadline → deny before the hook timeout; malformed stdin → deny.
- An approval timeout blocks the call and records `timeout`; an unreachable channel records `unavailable` and blocks.
- An approved risky call is allowed only after the intent record persisted; a failed append after approval is a deny.
- A secret in args never appears in stored records.
- Ledger down + risky or unreviewed call means the call is blocked.
- A local-mode JSONL chain verifies after restart.

## 11. Environment notes

- Node is installed (v25; `canonicalize` needs ≥22). Docker is **not** installed on the Mac yet. Server mode needs Docker
  (or the homelab Kubernetes cluster) before any runtime work. The framework phase needs neither.

## 12. Open questions (answered by calls, not code)

1. Do customers accept fail-open for read-only calls?
2. What do their agents run on? (That decides which framework and MCP setup to support first.)
3. Will auditors accept a generated report, or do they insist on raw log access?
4. Ryan: add a Codex hook adapter now that Codex hooks are stable and on by default (§3)?
