# Agent Ledger: Framework Spec (v2)

**Date:** 2026-09-29 · **Status:** v2, awaiting Astra review · **Author:** Ryan + Fable
**Brain:** `~/Desktop/AgentLedger/` (read `_state.md` first)
**Changed in v2:** ADR-004 reviewed allowlist (§7, §8); MCP 2026-07-28 (§3, §4); hook collector for coding agents (§3, §4, §6); RFC 8785 hashing and IETF draft field alignment (§5). Every external format below was checked against its primary source on 2026-09-29; the URLs are inline and the findings are in the vault (`diligence-2026-09-28.md`, "Verified by Fable").

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
| **Local** | **Hook collector** (Claude Code `PreToolUse`/`PostToolUse`) **plus** MCP proxy over stdio | Developer laptop | Append-only JSONL file | Visibility. Per-user hooks can be edited; org-wide managed hooks cannot be disabled by the user. |
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
| 1b | `src/hooks/` | Parse a Claude Code hook event into an `IncomingCall`; format a `HookDecision` as the documented `hookSpecificOutput` JSON | types |
| 2 | `src/upstream/` | MCP clients to the real tool servers; combines their tool lists (with annotations) | types, secrets |
| 3 | `src/identity/` | Authenticate the agent; create and track sessions | types |
| 4 | `src/secrets/` | Hand upstream credentials to `upstream/` only. Backends: env/file (local), Secrets Manager (later). | types |
| 5 | `src/policy/` | Classify a ToolCall from the reviewed registry (`evaluate`); propose classes for review (`suggestClass`) | types |
| 6 | `src/approvals/` | Ask a human (Slack) and return an ApprovalResult; deny on timeout | types |
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

interface ApprovalResult { callId: string; decision: "approved" | "denied" | "timeout"; approver?: string; decidedAt: string; channel: "slack"; }

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
interface PipelineDeps { identity: IdentityService; registry: ToolRegistry; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalOptions; }
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

**Alignment with draft-sharif-agent-audit-trail-06** (https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/,
dated 2026-09-29, individual Internet-Draft). It mandates JCS for its chain (`prev_hash(N) = hex(SHA-256(JCS(record(N-1))))`,
§6.1), which our construction matches once `hash` is treated as the derived field it is. We keep camelCase and
our vocabulary; the report module can emit the draft's names from this table:

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
2. `policy.evaluate(registry, call)` returns `allow`, `deny`, or `require_approval` with a risk class (§8).
3. If `require_approval`: `approvals.request(call, decision)`. A timeout counts as `denied`.
4. `ledger.append(intent record)`. **This happens before execution**, so there's never an unlogged risky action.
5. If allowed: `upstream.execute(call)` using credentials from `secrets`.
6. `ledger.append(outcome record)` → the result is returned to the agent.

**Decide-only mode** (`pipeline.decide`, run by the `hook` command):

1. `hooks.parseHookInput(stdin)` → `PreToolUseEvent`; `hooks.toIncomingCall(ev, credential)` sets `callId = tool_use_id`,
   maps a built-in `tool_name` to server `claude-code` and `mcp__<server>__<tool>` to `<server>/<tool>`, `args = tool_input`.
2. Steps 1-4 above, then **stop**: nothing is executed, Claude Code runs the tool itself.
3. `hooks.formatPreToolUseOutput(decision)` prints
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask","permissionDecisionReason":"..."}}`
   with exit code 0. `allow` ↔ verdict allow; `deny` ↔ verdict deny, approval denied, or timeout; `ask` ↔ require_approval
   when no approval channel is configured (Claude Code then asks the user). We never emit `defer`.
4. On `PostToolUse`, `pipeline.recordOutcome(tool_use_id, outcome)` appends the outcome record.

A call that is denied (by policy, a human, or a timeout) gets one record with `phase: "outcome"` and
`outcome.status: "blocked"`, and it never reaches `upstream`. Blocked attempts are evidence too.

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
| Approvals unavailable | `risky` and `unreviewed` calls blocked (read and write calls never need approval) |
| Registry file invalid (unknown field, bad class, missing reviewer, downgrading escalation) | Proxy and hook refuse to start, whatever the call |
| Upstream error | Outcome recorded as `error` |
| Hook command crashes | Exit code 2 blocks the tool call in Claude Code; a crash is never an allow |

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
  claude-code:                          # pseudo-server for Claude Code's built-in tools (hook collector)
    trusted: true
    tools: { Read: {class: read, ...}, Edit: {class: write, ...}, Bash: {class: risky, note: "a shell can do anything", ...} }
```

**Evaluation** (`policy.evaluate(registry, call)`):

| Situation | Verdict | Risk | ruleId |
|---|---|---|---|
| Server not in registry | `require_approval` | `unreviewed` | `unreviewed:<server>/<tool>` |
| Server known, tool not listed | `require_approval` | `unreviewed` | `unreviewed:<server>/<tool>` |
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
- The hook fixtures in `test/fixtures/` keep the documented field names (format-drift guard).
- An approval timeout blocks the call and records `timeout`.
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
