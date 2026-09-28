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
- A test list per module (`test/<module>.todo.md`) so development after Gate 2 starts test-first.
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
| 1 | `src/front/` | MCP server the agent connects to (stdio + HTTP); lists tools, accepts calls | types, pipeline |
| 2 | `src/upstream/` | MCP clients to the real tool servers; combines their tool lists | types, secrets |
| 3 | `src/identity/` | Authenticate the agent; create and track sessions | types |
| 4 | `src/secrets/` | Hand upstream credentials to `upstream/` only. Backends: env/file (local), Secrets Manager (later). | types |
| 5 | `src/policy/` | Evaluate a ToolCall against YAML rules and return a PolicyDecision | types |
| 6 | `src/approvals/` | Ask a human (Slack) and return an ApprovalResult; deny on timeout | types |
| 7 | `src/ledger/` | Redact, hash-chain, and append records; verify the chain | types |
| 8 | `src/anchor/` | Record the chain head daily somewhere hard to edit. Backends: local file (now), S3 Object Lock (later). | types, ledger |
| 9 | `src/report/` | Turn ledger records for a date range into PDF + CSV mapped to SOC 2 criteria | types, ledger |
| n/a | `src/pipeline/` | Wire 3 → 5 → 6 → 7 → 2 → 7 for one call (the only module that knows the order) | all of the above |

**Later, not scaffolded now:** 10, intent-vs-action drift detection (v2: `declare_plan` tool, rules, an
LLM judge, baselines); 11, the Terraform module.

## 5. Shared contracts (`src/types/`)

```ts
type AgentId = string; type SessionId = string;

interface ToolCall {
  callId: string; sessionId: SessionId; agentId: AgentId;
  onBehalfOf?: string;          // the human the agent acts for
  declaredPlan?: string;        // v2 intent capture; optional now
  server: string; tool: string; // e.g. "github", "delete_repo"
  args: Record<string, unknown>;
  receivedAt: string;           // ISO 8601
}

type Verdict = "allow" | "deny" | "require_approval";
interface PolicyDecision { verdict: Verdict; ruleId: string; reason: string; risk: "read" | "write" | "risky"; }

interface ApprovalResult { decision: "approved" | "denied" | "timeout"; approver?: string; decidedAt: string; channel: "slack"; }

type Phase = "intent" | "outcome";
interface LedgerRecord {
  id: string; phase: Phase; call: ToolCall;   // args redacted before hashing
  policy: PolicyDecision; approval?: ApprovalResult;
  outcome?: { status: "ok" | "error" | "blocked"; errorClass?: string; durationMs?: number };
  prevHash: string; hash: string;             // hash = SHA-256(canonical JSON of the record without its hash field)
  writtenAt: string;
}
```

## 6. Flow of one tool call

1. `front` receives the call → `identity` resolves the agent and session. An unknown agent is denied.
2. `policy.evaluate(call)` returns `allow`, `deny`, or `require_approval`.
3. If `require_approval`: `approvals.request(call, decision)`. A timeout counts as `denied`.
4. `ledger.append(intent record)`. **This happens before execution**, so there's never an unlogged risky action.
5. If allowed: `upstream.execute(call)` using credentials from `secrets`.
6. `ledger.append(outcome record)` → the result is returned to the agent.

A call that is denied (by policy, a human, or a timeout) gets one record with `phase: "outcome"` and
`outcome.status: "blocked"`, and it never reaches `upstream`. Blocked attempts are evidence too.

## 7. Failure behavior

| Failure | Risky call | Read-only call |
|---|---|---|
| Ledger unavailable | **Blocked** (fail-closed) | Allowed; record buffered locally and replayed |
| Approvals unavailable | Blocked | n/a |
| Policy file invalid | Proxy refuses to start | Proxy refuses to start |
| Upstream error | Outcome recorded as `error` | Same |

This split is an assumption to test in Phase 1 calls (open question in `_state.md`).

## 8. Default policy (`policies/default.yaml`)

Five risky action types require approval by default: deletes, payments or money movement, email or
messages to external recipients, IAM or permission changes, and production deploys. Everything else is
classified `read` or `write` and allowed, but still logged. Rules match on server, tool name, and argument patterns.

## 9. Security of the proxy itself

- The proxy is the credential boundary. Agents never receive upstream secrets.
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
