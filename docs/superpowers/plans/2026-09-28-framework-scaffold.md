# Agent Ledger Framework Scaffold: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Agent Ledger repo skeleton: shared types, one contract per module with
"not implemented" stubs, READMEs, test to-do lists, the default policy, and a compose skeleton. No business logic.

**Architecture:** One TypeScript package. Each component lives in `src/<module>/` and exposes only
`contract.ts`. Modules share data shapes through `src/types/`. `src/pipeline/` is the only module
that imports the others. A structure test makes sure every module has its files and that every stub throws.

**Tech Stack:** Node 25, TypeScript (strict, NodeNext), Vitest, `yaml` (for parsing policy files).

**Spec:** `docs/spec.md`

## Global Constraints

- No business logic (ADR-002). Every exported function body is `throw notImplemented("<module>.<fn>")`.
- `src/types/` is the only place shared data shapes are defined; modules import from `../types/index.js`.
- Only `src/pipeline/` may import other modules' functions. Type-only imports of another module's interfaces (`import type`) are allowed (report→ledger, upstream→secrets, pipeline→all).
- Supply chain (spec §9): `.npmrc` sets `save-exact=true` and `ignore-scripts=true`.
- Policy patterns are JavaScript regular expressions matched case-insensitively; they never use inline `(?i)` flags.
- Terraform and component 10 (drift detection) are NOT scaffolded.
- Commit author: Ryan Zeleznock <ryan.zeleznock@spartans.ut.edu>; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These are the behaviors the spec implies that need tests after Gate 2. Each one is written into the owning module's to-do list in Task 3:

1. Canonical JSON: two records with the same fields in a different key order must hash the same (ledger).
2. Two calls appending at the same moment must not both chain from the same `prevHash` (ledger).
3. A secret nested deep in args, or inside an array, must still be redacted (ledger).
4. The same approval must not be reused for a second, different call (approvals).
5. A policy file with an unknown field or a duplicate rule id must refuse to load (policy).

---

### Task 1: Package, toolchain, repo agent files

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.npmrc`, `CLAUDE.md`, `AGENTS.md`
- Test: `test/smoke.test.ts`

**Interfaces:** Produces `npm test` (vitest run) and `npm run typecheck` (tsc --noEmit).

- [ ] **Step 1: Write package files**

`package.json`:
```json
{
  "name": "agent-ledger",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "devDependencies": {}
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

`.npmrc`:
```
save-exact=true
ignore-scripts=true
```

`.gitignore`:
```
node_modules/
dist/
*.jsonl
.env
.context/
```

`CLAUDE.md`:
```markdown
# agent-ledger (code repo)

Brain: read `~/Desktop/AgentLedger/_state.md` FIRST, then any open handoff addressed to you there.
Spec: `docs/spec.md`. Plan: `docs/superpowers/plans/`.

Rules:
- ADR-002: no business logic before Gate 2. Stubs throw `notImplemented`.
- Shared shapes live only in `src/types/`. Only `src/pipeline/` imports other modules.
- Log your session and handoffs in the vault, not here.
- `npm run typecheck && npm test` must pass before any commit.
```

`AGENTS.md`:
```markdown
# AGENTS.md
You are Astra. Follow `CLAUDE.md` in this repo. It applies to every agent. Vault rules live at
`~/Desktop/AgentLedger/CLAUDE.md`. Run Codex with `--add-dir ~/Desktop/AgentLedger` to write there.
Never approve your own work.
```

- [ ] **Step 2: Install dev dependencies**

Run: `npm install -D typescript vitest @types/node yaml`
Expected: `added N packages`, no errors.

- [ ] **Step 3: Write the smoke test**

`test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
describe("toolchain", () => { it("runs", () => { expect(1 + 1).toBe(2); }); });
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0; `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .npmrc CLAUDE.md AGENTS.md test/smoke.test.ts
git commit -m "chore: TypeScript + Vitest toolchain and agent pointer files"
```

---

### Task 2: Shared types

**Files:**
- Create: `src/types/index.ts`, `src/types/not-implemented.ts`
- Test: `test/types.test.ts`

**Interfaces:** Produces every type below plus `notImplemented(name: string): Error` and `VERDICTS`.

- [ ] **Step 1: Write the failing test**

`test/types.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { VERDICTS, type LedgerRecord } from "../src/types/index.js";
import { notImplemented } from "../src/types/not-implemented.js";

describe("types", () => {
  it("exposes the three verdicts", () => {
    expect(VERDICTS).toEqual(["allow", "deny", "require_approval"]);
  });
  it("notImplemented names the function", () => {
    expect(notImplemented("ledger.append").message).toBe("not implemented: ledger.append");
  });
  it("LedgerRecord shape compiles", () => {
    const r: LedgerRecord = {
      id: "r1", phase: "intent",
      call: { callId: "c1", sessionId: "s1", agentId: "a1", server: "github", tool: "list_repos", args: {}, receivedAt: "2026-09-28T00:00:00Z" },
      policy: { verdict: "allow", ruleId: "default-read", reason: "read-only", risk: "read" },
      prevHash: "0", hash: "h", writtenAt: "2026-09-28T00:00:00Z",
    };
    expect(r.phase).toBe("intent");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL, "Cannot find module '../src/types/index.js'".

- [ ] **Step 3: Write the types**

`src/types/not-implemented.ts`:
```ts
export function notImplemented(name: string): Error {
  return new Error(`not implemented: ${name}`);
}
```

`src/types/index.ts`:
```ts
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
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npx vitest run test/types.test.ts`
Expected: typecheck exits 0; `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/types test/types.test.ts
git commit -m "feat(types): shared contracts for calls, decisions, approvals, ledger records"
```

---

### Task 3: Module contracts, READMEs, test to-do lists

**Files:**
- Create: `src/<m>/contract.ts` and `src/<m>/README.md` for m in identity, secrets, policy, approvals, ledger, anchor, report, upstream, front, pipeline
- Create: `test/todo/<m>.todo.md` for the same ten modules
- Test: `test/structure.test.ts`

**Interfaces:** Consumes Task 2 types. Produces the exported names listed in each contract below (later work fills the function bodies without changing any signature).

- [ ] **Step 1: Write the failing structure test**

`test/structure.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";

const LOADERS = {
  identity: () => import("../src/identity/contract.js"),
  secrets: () => import("../src/secrets/contract.js"),
  policy: () => import("../src/policy/contract.js"),
  approvals: () => import("../src/approvals/contract.js"),
  ledger: () => import("../src/ledger/contract.js"),
  anchor: () => import("../src/anchor/contract.js"),
  report: () => import("../src/report/contract.js"),
  upstream: () => import("../src/upstream/contract.js"),
  front: () => import("../src/front/contract.js"),
  pipeline: () => import("../src/pipeline/contract.js"),
} as const;
const MODULES = Object.keys(LOADERS) as (keyof typeof LOADERS)[];

describe.each(MODULES)("module %s", (m) => {
  it("has README, contract, and test to-do list", () => {
    for (const p of [`src/${m}/README.md`, `src/${m}/contract.ts`, `test/todo/${m}.todo.md`]) {
      expect(existsSync(p), p).toBe(true);
    }
  });
  it("every exported function throws not implemented", async () => {
    const mod: Record<string, unknown> = await LOADERS[m]();
    const fns = Object.entries(mod).filter(([, v]) => typeof v === "function");
    expect(fns.length).toBeGreaterThan(0);
    for (const [name, fn] of fns) {
      expect(() => (fn as (...a: unknown[]) => unknown)(), name).toThrow(/^not implemented: /);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/structure.test.ts`
Expected: FAIL for all 10 modules (files missing).

- [ ] **Step 3: Write the contracts**

`src/identity/contract.ts`:
```ts
import type { AgentId, SessionId } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface AgentCredential { kind: "api_key" | "local"; value: string; }
export function resolveAgent(cred: AgentCredential): Promise<AgentId> { throw notImplemented("identity.resolveAgent"); }
export function startSession(agentId: AgentId, onBehalfOf?: string): Promise<SessionId> { throw notImplemented("identity.startSession"); }
```

`src/secrets/contract.ts`:
```ts
import { notImplemented } from "../types/not-implemented.js";
export interface SecretsProvider { get(server: string): Promise<Record<string, string>>; }
export function createSecretsProvider(kind: "env" | "file", target?: string): SecretsProvider { throw notImplemented("secrets.createSecretsProvider"); }
```

`src/policy/contract.ts`:
```ts
import type { PolicyDecision, Risk, ToolCall, Verdict } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface PolicyRule { id: string; match: { server?: string; tool?: string; argPattern?: Record<string, string> }; verdict: Verdict; risk: Risk; reason: string; }
export interface Policy { version: 1; rules: PolicyRule[]; defaultVerdict: Verdict; }
export function loadPolicy(path: string): Promise<Policy> { throw notImplemented("policy.loadPolicy"); }
export function evaluate(policy: Policy, call: ToolCall): PolicyDecision { throw notImplemented("policy.evaluate"); }
```

`src/approvals/contract.ts`:
```ts
import type { ApprovalResult, PolicyDecision, ToolCall } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface ApprovalOptions { timeoutMs: number; channel: "slack"; }
export function requestApproval(call: ToolCall, decision: PolicyDecision, opts: ApprovalOptions): Promise<ApprovalResult> { throw notImplemented("approvals.requestApproval"); }
```

`src/ledger/contract.ts`:
```ts
import type { DateRange, LedgerRecord, UnsealedRecord, VerifyResult } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface LedgerStore {
  append(record: UnsealedRecord): Promise<LedgerRecord>;
  verify(): Promise<VerifyResult>;
  head(): Promise<string>;
  read(range: DateRange): AsyncIterable<LedgerRecord>;
}
export function createLedger(kind: "jsonl" | "postgres", target: string): LedgerStore { throw notImplemented("ledger.createLedger"); }
export function redact(args: Record<string, unknown>): Record<string, unknown> { throw notImplemented("ledger.redact"); }
export function hashRecord(record: Omit<LedgerRecord, "hash">): string { throw notImplemented("ledger.hashRecord"); }
```

`src/anchor/contract.ts`:
```ts
import { notImplemented } from "../types/not-implemented.js";
export interface AnchorEntry { hash: string; at: string; }
export interface Anchor { write(entry: AnchorEntry): Promise<void>; latest(): Promise<AnchorEntry | null>; }
export function createAnchor(kind: "file" | "s3", target: string): Anchor { throw notImplemented("anchor.createAnchor"); }
```

`src/report/contract.ts`:
```ts
import type { DateRange } from "../types/index.js";
import type { LedgerStore } from "../ledger/contract.js";
import { notImplemented } from "../types/not-implemented.js";
export interface ReportFiles { pdfPath: string; csvPath: string; }
export function generateReport(ledger: LedgerStore, range: DateRange, outDir: string): Promise<ReportFiles> { throw notImplemented("report.generateReport"); }
```

`src/upstream/contract.ts`:
```ts
import type { ToolCall, ToolInfo, ToolResult } from "../types/index.js";
import type { SecretsProvider } from "../secrets/contract.js";
import { notImplemented } from "../types/not-implemented.js";
export interface UpstreamConfig { name: string; transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; }
export interface Upstream { listTools(): Promise<ToolInfo[]>; execute(call: ToolCall): Promise<ToolResult>; close(): Promise<void>; }
export function connectUpstreams(config: UpstreamConfig[], secrets: SecretsProvider): Promise<Upstream> { throw notImplemented("upstream.connectUpstreams"); }
```

`src/front/contract.ts`:
```ts
import type { CallHandler, ToolInfo } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface FrontOptions { mode: "stdio" | "http"; port?: number; tools: () => Promise<ToolInfo[]>; }
export interface RunningFront { stop(): Promise<void>; }
export function startFront(handler: CallHandler, opts: FrontOptions): Promise<RunningFront> { throw notImplemented("front.startFront"); }
```

`src/pipeline/contract.ts`:
```ts
import type { CallHandler } from "../types/index.js";
import type { Policy } from "../policy/contract.js";
import type { LedgerStore } from "../ledger/contract.js";
import type { Upstream } from "../upstream/contract.js";
import type { ApprovalOptions } from "../approvals/contract.js";
import { notImplemented } from "../types/not-implemented.js";
export interface PipelineDeps { policy: Policy; ledger: LedgerStore; upstream: Upstream; approvals: ApprovalOptions; }
export function createPipeline(deps: PipelineDeps): CallHandler { throw notImplemented("pipeline.createPipeline"); }
```

- [ ] **Step 4: Write the READMEs**

Each `src/<m>/README.md` uses this exact shape (text per module below):
```markdown
# <module>
**Job:** <one sentence>
**Depends on:** <list>
**Does NOT:** <list>
**Spec:** docs/spec.md §<n>
```
| Module | Job | Depends on | Does NOT | Spec § |
|---|---|---|---|---|
| identity | Authenticate the agent and create sessions | types | decide permissions | 4 |
| secrets | Hand upstream credentials to upstream only | types | log or return secrets to agents | 4, 9 |
| policy | Evaluate a ToolCall against YAML rules | types | ask humans or call tools | 4, 8 |
| approvals | Ask a human in Slack; timeout counts as deny | types | decide what is risky | 4, 6 |
| ledger | Redact, hash-chain, append, verify records | types | allow editing or deleting records | 4, 5, 9 |
| anchor | Record the chain head daily somewhere hard to edit | types | store records | 4 |
| report | Export ledger range as PDF + CSV mapped to CC6.1/CC7.2/CC8.1 | types, ledger (read) | write to the ledger | 4 |
| upstream | Connect to real MCP servers and execute calls | types, secrets | check policy | 4 |
| front | Expose the MCP server to the agent (stdio + HTTP) | types | know the call order | 3, 4 |
| pipeline | Run identity → policy → approval → ledger → upstream → ledger for one call | all | talk to agents directly | 6, 7 |

- [ ] **Step 5: Write the test to-do lists**

Each `test/todo/<m>.todo.md` starts with `# <m>: tests to write after Gate 2` and lists these as `- [ ]` items:
- identity: unknown credential is rejected; session ids are unique; onBehalfOf is carried to the ToolCall.
- secrets: env provider returns only the named server's secrets; a missing secret throws a clear error; secrets never appear in thrown error messages.
- policy: a table test with ≥20 calls and their expected verdicts; the first matching rule wins; defaultVerdict applies when nothing matches; **an unknown field or a duplicate rule id refuses to load**.
- approvals: approve and deny paths; timeout returns `timeout`; **an approval for one callId cannot be reused for another**.
- ledger: editing any one record makes verify() fail at that record; **key order doesn't change the hash**; **two concurrent appends never share a prevHash**; **secrets nested in objects or arrays are redacted**; a JSONL chain verifies after a restart.
- anchor: latest() returns the last write; the file anchor is append-only.
- report: an empty range gives an empty report, not a crash; every record maps to at least one SOC 2 criterion; the CSV row count matches the records in range.
- upstream: tool lists from 2 servers are combined, with server names kept; a server that isn't on the allowlist is refused.
- front: stdio and HTTP both reach the handler; a malformed MCP request returns a protocol error, not a crash.
- pipeline: denied → one `blocked` outcome record and upstream is never called; ledger down + risky call → blocked; ledger down + read call → allowed and buffered; the intent record is written before upstream runs.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0; all tests pass (smoke 1 + types 3 + structure 20).

- [ ] **Step 7: Commit**

```bash
git add src test/structure.test.ts test/todo
git commit -m "feat: module contracts, READMEs, and test to-do lists (stubs only, ADR-002)"
```

---

### Task 4: Default policy and compose skeleton

**Files:**
- Create: `policies/default.yaml`, `docker-compose.yml`
- Test: `test/policy-file.test.ts`

**Interfaces:** Consumes the `Policy` shape from `src/policy/contract.ts` (validated here by a hand check of its keys, because `loadPolicy` stays a stub).

- [ ] **Step 1: Write the failing test**

`test/policy-file.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

describe("policies/default.yaml", () => {
  const p = parse(readFileSync("policies/default.yaml", "utf8"));
  it("is version 1 with a default verdict", () => {
    expect(p.version).toBe(1);
    expect(p.defaultVerdict).toBe("allow");
  });
  it("requires approval for the five risky action types", () => {
    const ids = p.rules.filter((r: { verdict: string }) => r.verdict === "require_approval").map((r: { id: string }) => r.id);
    expect(ids).toEqual(["risky-delete", "risky-payment", "risky-external-message", "risky-iam-change", "risky-prod-deploy"]);
  });
  it("has unique rule ids", () => {
    const ids = p.rules.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/policy-file.test.ts`
Expected: FAIL, ENOENT for policies/default.yaml.

- [ ] **Step 3: Write the files**

`policies/default.yaml`:
```yaml
version: 1
defaultVerdict: allow
rules:
  - id: risky-delete
    match: { tool: "(delete|remove|destroy|drop|purge)" }
    verdict: require_approval
    risk: risky
    reason: Destructive action
  - id: risky-payment
    match: { tool: "(pay|charge|refund|transfer|payout|invoice_send)" }
    verdict: require_approval
    risk: risky
    reason: Money movement
  - id: risky-external-message
    match: { tool: "(send_email|send_message|post_message|tweet)" }
    verdict: require_approval
    risk: risky
    reason: Message to recipients outside the company
  - id: risky-iam-change
    match: { tool: "(iam|role|policy|permission|grant|invite_user)" }
    verdict: require_approval
    risk: risky
    reason: Permission change
  - id: risky-prod-deploy
    match: { tool: "(deploy|release|merge)", argPattern: { environment: "^prod" } }
    verdict: require_approval
    risk: risky
    reason: Production change
  - id: default-write
    match: { tool: "(create|update|write|edit|put|set)" }
    verdict: allow
    risk: write
    reason: Non-destructive write, logged
```

`docker-compose.yml`:
```yaml
# NOT RUNNABLE YET (ADR-002): the proxy image is built after Gate 2.
# Server mode = proxy (HTTP) + Postgres ledger. Local mode needs no compose at all.
services:
  proxy:
    build: .
    command: ["node", "dist/main.js", "--mode", "http", "--port", "8787"]
    ports: ["8787:8787"]
    environment:
      LEDGER_KIND: postgres
      LEDGER_TARGET: postgres://ledger:ledger@db:5432/ledger
      POLICY_PATH: /app/policies/default.yaml
    depends_on: [db]
  db:
    image: postgres:17
    environment: { POSTGRES_USER: ledger, POSTGRES_PASSWORD: ledger, POSTGRES_DB: ledger }
    volumes: ["ledger-data:/var/lib/postgresql/data"]
volumes:
  ledger-data: {}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0; all tests pass (27 total).

- [ ] **Step 5: Commit**

```bash
git add policies docker-compose.yml test/policy-file.test.ts
git commit -m "feat: default risky-action policy and server-mode compose skeleton"
```

---

### Task 5: Record the decisions in the vault

**Files:**
- Create: `~/Desktop/AgentLedger/decisions/ADR-003-framework-stack.md`
- Modify: `~/Desktop/AgentLedger/_state.md` (the "Active decisions" and "Pointers" sections)

- [ ] **Step 1: Write ADR-003**

```markdown
---
type: decision
id: ADR-003
status: accepted
agent: ryan
created: 2026-09-28
---
# ADR-003: Framework stack and deployment modes

**Context:** The framework is scaffolded before Gate 2, with no logic (ADR-002 still holds).

**Decision:** One TypeScript package with modules split by folder, and Vitest for tests. Two modes
from one codebase: local (stdio, JSONL ledger) and server (HTTP, Postgres, Docker). Local mode gets
built first. Terraform and drift detection are deferred until a design partner needs them.
Repo: `~/agent-ledger`, spec in `docs/spec.md`.

**Consequences:** No cloud is needed to start. Docker isn't installed on the Mac yet; server
mode needs it (or the homelab cluster) after Gate 2.
```

- [ ] **Step 2: Update `_state.md`**

Add under "Active decisions": `- [[decisions/ADR-003-framework-stack]]: TS single package, local + server modes, Terraform deferred`
Add under "Pointers": `- Code: ~/agent-ledger (spec docs/spec.md; framework scaffolded, stubs only)`
Set `updated: 2026-09-28` and `updated_by: fable`. Keep the file at 60 lines or fewer.

- [ ] **Step 3: Verify and commit the vault**

Run: `wc -l ~/Desktop/AgentLedger/_state.md` → expect ≤ 60.
```bash
cd ~/Desktop/AgentLedger && git add decisions/ADR-003-framework-stack.md _state.md .gitignore && git commit -m "ADR-003: framework stack; point state at code repo"
```
