# Agent Ledger: Framework Spec

**Date:** 2026-09-28 · **Status:** Draft for review · **Author:** Ryan + Fable
**Brain:** `~/Desktop/AgentLedger/` (read `_state.md` first)

## 1. What this is

An MCP proxy that sits between an AI agent and its tools. Every tool call is identified, checked
against policy, sent for human approval when risky, and recorded in a tamper-evident ledger. The
ledger exports as SOC 2 evidence (CC6.1 access, CC7.2 monitoring, CC8.1 change management).

**Buyer:** Head of GRC or CISO at a company with 200-2,000 employees, agents in production, and an
annual SOC 2 audit.
**Success for the MVP:** a design partner's auditor accepts one generated report.

## 2. Scope of THIS phase: framework only

ADR-002 still holds, so this phase delivers **no business logic**. It delivers:

- The repo layout below, with each module's README (its job, dependencies, and what it doesn't do).
- A contract file per module (`contract.ts`): exported types and function signatures whose bodies
  `throw new Error("not implemented")`.
- Shared types in `src/types/`. This is the one place where the data shapes are final.
- A test list per module (`test/todo/<module>.todo.md`) so development after Gate 2 starts test-first.
- A default policy file and the Docker Compose skeleton, marked not runnable yet.

## 3. Deployment modes (one codebase)

| Mode | Transport | Runs where | Ledger backend | Evidence strength |
|---|---|---|---|---|
| **Local** | stdio (the agent launches the proxy) | Developer laptop (Claude Code, Codex, Cursor) | Append-only JSONL file | Visibility. The user can edit the config to go around the proxy. |
| **Server** | Streamable HTTP | Docker container anywhere: laptop, homelab, VM, or the customer's cloud | Postgres | Audit-grade. The proxy holds the credentials, so the agent can't go around it. |

Build order after Gate 2: **local mode first** (zero infrastructure; dogfood it on Fable and Astra),
then server mode for design partners.
**Not in scope yet:** a Terraform module for AWS, written when a design partner needs it.

## 4. Components

| # | Folder | Job (exactly one) | Depends on |
|---|---|---|---|
| 1 | `src/front/` | MCP server the agent connects to (stdio + HTTP); lists tools, hands each call to an injected `CallHandler` as an unauthenticated `IncomingCall` | types (the handler is injected) |
| 2 | `src/upstream/` | MCP clients to the real tool servers; combines their tool lists | types, secrets |
| 3 | `src/identity/` | Authenticate the agent; create and track sessions | types |
| 4 | `src/secrets/` | Hand upstream credentials to `upstream/` only. Backends: env/file (local), Secrets Manager (later). | types |
| 5 | `src/policy/` | Evaluate a ToolCall against YAML rules and return a PolicyDecision | types |
| 6 | `src/approvals/` | Ask a human (Slack) and return an ApprovalResult; deny on timeout | types |
| 7 | `src/ledger/` | Redact, hash-chain, and append records; verify the chain | types |
| 8 | `src/anchor/` | Record the chain head daily somewhere hard to edit. Backends: local file (now), S3 Object Lock (later). | types (it receives the head hash) |
| 9 | `src/report/` | Turn ledger records for a date range into PDF + CSV mapped to SOC 2 criteria | types, ledger |
| n/a | `src/pipeline/` | Wire 3 → 5 → 6 → 7 → 2 → 7 for one call (the only module that knows the order). Receives 3, 5, 6, 7, 2 through `PipelineDeps` and returns the `CallHandler` that `front` runs | identity, policy, approvals, ledger, upstream, types |

**Later, not scaffolded now:** 10, intent-vs-action drift detection (v2: `declare_plan` tool, rules, an
LLM judge, baselines); 11, the Terraform module.

## 5. Shared contracts (`src/types/`)

```ts
type AgentId = string; type SessionId = string;

interface AgentCredential { kind: "api_key" | "local"; value: string; }   // never stored

interface IncomingCall {          // what `front` receives: unauthenticated
  callId: string; credential: AgentCredential;
  server: string; tool: string; args: Record<string, unknown>; receivedAt: string;
  onBehalfOf?: string; declaredPlan?: string;
}
type CallHandler = (incoming: IncomingCall) => Promise<ToolResult>;   // built by pipeline, run by front

interface ToolCall {              // authenticated by the pipeline; carries no credential
  callId: string; sessionId: SessionId; agentId: AgentId;
  onBehalfOf?: string;          // the human the agent acts for
  declaredPlan?: string;        // v2 intent capture; optional now
  server: string; tool: string; // e.g. "github", "delete_repo"
  args: Record<string, unknown>;
  receivedAt: string;           // ISO 8601
}

type Verdict = "allow" | "deny" | "require_approval";
interface PolicyDecision { verdict: Verdict; ruleId: string; reason: string; risk: "read" | "write" | "risky"; }

interface ApprovalResult {
  callId: string;                 // bound to one call, so a replayed approval is detectable
  decision: "approved" | "denied" | "timeout"; approver?: string; decidedAt: string; channel: "slack";
}

type Phase = "intent" | "outcome";
interface LedgerRecord {
  id: string; phase: Phase; call: ToolCall;   // args redacted before hashing
  policy: PolicyDecision; approval?: ApprovalResult;
  outcome?: { status: "ok" | "error" | "blocked"; errorClass?: string; durationMs?: number };
  prevHash: string; hash: string;             // hash = SHA-256(canonical JSON of the record without its hash field)
  writtenAt: string;
}

interface PolicyRule {
  id: string;
  match: { server?: string; tool?: string; argPattern?: Record<string, string>;
           unless?: { argPattern: Record<string, string> } };   // rule does NOT match when every unless pattern matches
  verdict: Verdict; risk: Risk; reason: string;
}
interface Policy { version: 1; rules: PolicyRule[]; defaultDecision: PolicyDecision; }   // first match wins

interface IdentityService { resolveAgent(cred: AgentCredential): Promise<AgentId>; startSession(agentId: AgentId, onBehalfOf?: string): Promise<SessionId>; }
interface PipelineDeps { identity: IdentityService; policy: Policy; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalOptions; }
```

`AgentCredential` appears only in `IncomingCall`. `ToolCall` and `LedgerRecord` have no field for it. The type
alone does not enforce this at runtime (a spread `{ ...incoming, agentId, sessionId }` would keep `credential`
on the object), so the pipeline builds `ToolCall` by **explicit field projection** and never spreads
`IncomingCall`: `{ callId, sessionId, agentId, onBehalfOf, declaredPlan, server, tool, args, receivedAt }`, each
copied by name. A runtime test pins this (`test/todo/pipeline.todo.md`).

## 6. Flow of one tool call

1. `front` receives an `IncomingCall` (credential attached) and passes it to the `CallHandler` that
   `pipeline.createPipeline(deps)` returned. The pipeline calls `deps.identity.resolveAgent(credential)` and
   `startSession(...)`, then builds the authenticated `ToolCall` by explicit field projection (§5, never a spread).
   An unknown agent is denied before any other step.
2. `policy.evaluate(call)` returns `allow`, `deny`, or `require_approval`.
3. If `require_approval`: `approvals.request(call, decision)`. A timeout counts as `denied`.
4. `ledger.append(intent record)`. **This happens before execution**, so there's never an unlogged risky action.
5. If allowed: `upstream.execute(call)` using credentials from `secrets`.
6. `ledger.append(outcome record)` → the result is returned to the agent.

A call that is denied (by policy, a human, or a timeout) gets one record with `phase: "outcome"` and
`outcome.status: "blocked"`, and it never reaches `upstream`. Blocked attempts are evidence too.

## 7. Failure behavior

Behavior depends on the call's risk class, which comes from the matching rule or from `defaultDecision`
(so every call has one).

**Ledger unavailable**, by risk class:

| Risk | Behavior |
|---|---|
| `read` | Allowed; record buffered locally and replayed when the ledger returns |
| `write` | **Blocked** (fail-closed) |
| `risky` | **Blocked** (fail-closed) |

**Other failures:**

| Failure | Behavior |
|---|---|
| Approvals unavailable | Risky call blocked (read and write calls never need approval) |
| Policy file invalid | Proxy refuses to start, whatever the call |
| Upstream error | Outcome recorded as `error` |

Unmatched calls default to `write`, so anything the policy doesn't recognize fails closed.
The read/write split is an assumption to test in Phase 1 calls (open question in `_state.md`).

## 8. Default policy (`policies/default.yaml`)

Rules match on server, tool name, and argument patterns; all patterns are case-insensitive regexes. They are
evaluated **top to bottom and the first match wins**, so order is part of the policy:

1. **Five risky rules first**, all `require_approval` / `risky`:
   - `risky-delete`: `delete|remove|destroy|drop|purge`, **unanchored**, so the verb is caught anywhere in the
     name (`get_and_delete_record`). Conservative on purpose: `remove_label` needs approval too.
   - `risky-payment`: `pay|charge|refund|transfer|payout|invoice` at the start of the name or after a mutating
     verb or `and` (`pay_invoice`, `create_refund`, `get_and_transfer_funds`).
   - `risky-external-message`: `send_email|send_message|post_message`, plus `tweet|retweet` at the start or after
     a posting verb. Recipient-based matching (internal vs external) is a deferred P2.
   - `risky-iam-change`: a **mutating verb** (`grant|revoke|attach|detach|assign|put|create|update|delete|add|
     remove|set|invite`) followed by a permission noun (`role|policy|permission|iam|user|group|member|access`).
     The noun alone is not a change, so `list_roles` and `describe_iam_policy` fall through to read-only.
   - `risky-prod-deploy`: `deploy|release|merge|rollout|promote` at the start or after a mutating verb or `and`,
     **unless** `environment` matches `^(dev|development|test|staging|sandbox)$`. A missing, unknown, or prod
     environment requires approval; a known nonprod one does not match this rule and falls through to
     `default-write`. The exception lives on this rule only, so `delete_deployment` or
     `grant_deploy_permission` in staging still hit `risky-delete` / `risky-iam-change` above.
2. **`read-only`**: `^(get|list|read|search|describe|fetch|query)_` is `allow` / `read`.
3. **`default-write`**: `create|update|write|edit|put|set|deploy|release|merge|rollout|promote` is `allow` / `write`.
4. Anything unmatched gets `defaultDecision`: `allow`, risk `write`, ruleId `default`, "Unclassified action, logged".

**Why risky rules come first.** With read rules first, any name with a read prefix skipped approval:
`get_and_delete_record` and `list_and_remove_users` were classified `read`, so they ran without approval and
even during a ledger outage (§7). Putting the risky rules first closes that; the cost is that each risky
pattern must be written so plain read tools (`list_roles`, `get_deploy_status`, `list_payments`) do not match
it, which is why the noun-like patterns require a leading position or a mutating verb, while the destructive
verbs stay unanchored. A false positive here means an unneeded approval; a false negative means an unlogged-
approval risky action. The default errs toward the former.

Everything is logged, whatever the verdict.

## 9. Security of the proxy itself

- The proxy is the credential boundary. Agents never receive upstream secrets.
- The agent's own credential stops at identity: `ToolCall` is built from `IncomingCall` by explicit field
  projection (§5), never by spreading it, so no `credential` property exists on anything the ledger stores.
  Runtime tests assert both the projected object and the stored record JSON (`test/todo/pipeline.todo.md`).
- Redaction (secrets and PII patterns) runs **before** hashing and storage. Raw args are never persisted.
- The ledger can only be appended to. Edits and deletes are impossible through the API, and any tampering
  is caught by chain verification plus the daily anchor.
- Its own supply chain: dependencies pinned, no install scripts, and upstream MCP servers listed on an allowlist in config.

## 10. Testing (lists now, tests after Gate 2)

Vitest. Must-have tests:
- Editing any one ledger record makes `verify()` fail at that record.
- A policy table test: at least 20 calls with their expected verdicts.
- An approval timeout blocks the call and records `timeout`.
- A secret in args never appears in stored records.
- Ledger down + risky call means the call is blocked.
- A local-mode JSONL chain verifies after restart.

## 11. Environment notes

- Node is installed (v25). Docker is **not** installed on the Mac yet. Server mode needs Docker
  (or the homelab Kubernetes cluster) before any runtime work. The framework phase needs neither.

## 12. Open questions (answered by calls, not code)

1. Do customers accept fail-open for read-only calls?
2. What do their agents run on? (That decides which framework and MCP setup to support first.)
3. Will auditors accept a generated report, or do they insist on raw log access?
