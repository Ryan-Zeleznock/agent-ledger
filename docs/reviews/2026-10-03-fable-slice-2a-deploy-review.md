# Slice 2a, Package B (Postgres ledger + deployment + runbook): full cross-review

Reviewer: Fable (security-reviewer brief). Builder: Astra. Date: 2026-10-03.
Range: `git diff 5f998f8..4e676ab` on `slice-2a-deploy` (worktree `~/agent-ledger-astra`). Coordinator commits 6523c57
(pg deps) and 25571b9 (pin amendments) are context, not findings. Binding: `docs/slices/slice-2a-pins.md` pins 1, 9-12 +
Amendments; ADR-012, ADR-013 (accepted). Known seam, not a finding: the `// PIN-2A` `"none"` literal in
`src/ledger/validate.ts:200-201`.

No tracked file was modified. No cluster-mutating command was run (only `kubectl get`, `kubectl kustomize`,
`kubectl apply --dry-run=server`, `helm list`). Scratch database `al_review_*` was created and dropped; zero `al_*`
databases remain on the test server.

## What I ran

| Check | Result |
|---|---|
| `AGENT_LEDGER_TEST_PG_HOST=… npm run check` (900 s alarm) | exit 0: 32 files / 1118 passed / 7 skipped (pre-existing) + 3 timing files / 79 passed; build ok |
| Re-run `ledger-postgres.test.ts` + `timing/ledger-postgres-process.test.ts` | 17/17 passed (stable on a second run; coordinator had 3 earlier) |
| `node deploy/check.mjs` | passes; prints the digest-placeholder warning as designed |
| `kubectl kustomize deploy/k8s` | renders; 3 agent-ledger images carry `:slice-2a@sha256:000…` placeholder; busybox `1.37.0`, postgres `17.11-alpine3.24` by tag |
| `kubectl apply --dry-run=server -f deploy/k8s/11-kyverno.yaml` | accepted by the live Kyverno 1.19.1 CRD/webhook (cluster v1.37.0) |
| `kubectl apply --dry-run=server -k deploy/k8s` | Namespace + ValidatingPolicy accepted; every namespaced object fails `namespaces "agent-ledger" not found` because the namespace does not exist yet (expected before step 2; nothing admitted) |
| PSA signal: rendered Pod templates (SA/pull-secret refs stripped) dry-run into `app` (enforce=baseline, warn=restricted) | all four pods: **no** `restricted:latest` warning. `root-pod.yaml`: warned `runAsNonRoot != true, runAsUser=0` → PSA catches it |
| Live DB probes (scratch DB, init SQL applied as `postgres`, table owner `postgres`) | see "Ledger" below |
| Primary sources | Falco rules repo (registry-prefix inconsistency), Falco field reference, Claude Code MCP docs, node-postgres `connection-parameters.js` (reads `PGPASSWORD`), `pg/lib/client.js:558` (`statement_timeout` honoured) |

## Ledger (focus 1)

**Shared chain, byte parity.** `chain.ts` is a faithful extraction: `parseStored`/`sealRecord`/`sealedLine`/
`checkStoredLine`/`verifyLines` are the old jsonl bodies; jsonl now appends `${line}\n` and Postgres stores `line`
(identical bytes minus LF). jsonl's empty-file and trailing-newline semantics are preserved (`verifyLines` on an empty
iterator → `{ok:true, checked:0}`; `endsWithNewline(path,0)` is true). The 13-row fixture table runs on both backends
and `verifyLines` directly (`test/ledger-chain-parity.test.ts:35-80`); `channel: "none"` round-trips on both.

**Append-only enforced by the database (verified live, as each role):**
- `ledger_app`: UPDATE/DELETE/TRUNCATE → `permission denied for table records`; `INSERT … ON CONFLICT DO UPDATE` →
  permission denied; `ALTER TABLE … DISABLE TRIGGER`, `DROP TRIGGER`, `DROP TABLE` → `must be owner`; `CREATE TABLE`
  in `ledger` and in `public` → permission denied; `SET session_replication_role` → permission denied; `COPY … TO
  file` → denied; role flags `rolsuper/createrole/createdb/bypassrls` all `f`.
- `ledger_reader`: INSERT/UPDATE/DELETE → permission denied.
- `postgres` (owner/superuser): UPDATE/DELETE/TRUNCATE → `ledger.records is append-only` (trigger). Bypass exists for
  the superuser only via `SET LOCAL session_replication_role = replica` (triggers are `tgenabled = O`, see P3-1).
- The owner/superuser is never used by the app: proxy URL is `ledger_app` (`30-proxy.yaml:93`), integration Job and
  HOMELAB step 13 use `ledger_reader`; `POSTGRES_PASSWORD` reaches only the postgres pod.

**One chain under concurrency.** `append` runs BEGIN → `pg_advisory_xact_lock` → tail by `seq DESC` → `checkStoredLine`
+ column equality on the tail → seal → INSERT → COMMIT on one pooled client (`postgres.ts:46-65`); READ COMMITTED means
the post-lock SELECT sees the previous committer's row. The 4×100 real-process test asserts 400 distinct
`parentRecordId`/`prevHash` and `verify` ok 400 (`timing/ledger-postgres-process.test.ts:23-37`); the contention test
proves a real waiter in `pg_locks`. `UNIQUE(id)`/`UNIQUE(hash)` back the duplicate refusal.

**Column-vs-line tamper.** `recordOf` (`postgres.ts:16-25`) compares all six indexed columns to the parsed line;
`written_ms` is compared as text with only trailing zeros stripped (live: `1791056278581.882000` for a +1 µs edit →
mismatch; `.000000` → match). Tests cover each of the 7 columns, the damaged-tail refusal (no row added), and the
sub-millisecond lie. `verify()` turns a column lie into `brokenAt: <id column>` with the count preserved.

**Credentials / errors.** Every public method rethrows `ledger.postgres.<op>: failed; run verify()` and nothing else
(`postgres.ts:13`, asserted exactly at `ledger-postgres.test.ts:76-77`); the pool `error` listener swallows idle errors;
the URL is never logged. Password-free URL + `PGPASSWORD` is documented and is what the manifests and runbook use.
`statement_timeout` 30 s applies to the advisory-lock wait too → a stuck writer fails closed (append throws → deny).

## Deployment (focus 2, CKS bar)

- **PSA**: namespace labels enforce/audit/warn `restricted` + `*-version: latest` (`00-namespace.yaml`). All four pod
  templates pass `restricted:latest` with no warnings (live dry-run signal above). Pod-level `runAsNonRoot`, seccomp
  `RuntimeDefault`; every container (init included) `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
  `drop: [ALL]`; uid 65532 for the Node pods, **70/70/70 for Postgres per the amendment** (`20-postgres.yaml:36-43`).
- **Tokens**: `automountServiceAccountToken: false` on all four SAs and all four pod specs; Kaniko Job too.
- **NetworkPolicies** (`10-networkpolicies.yaml`): `00-default-deny` Ingress+Egress on `podSelector: {}`; DNS egress only
  for proxy+integration to `kube-system` `k8s-app=kube-dns` 53/UDP+TCP; proxy → postgres:5432, demo-upstream:3001;
  proxy ingress 8787 from `10.20.0.0/24` and `app=integration`; postgres ingress 5432 and demo ingress 3001 from proxy
  + integration; integration egress to the three. Postgres and demo-upstream have no egress rule → denied. Matches the
  pin table exactly. Note the ipBlock covers the nodes themselves (10.20.0.10-12), i.e. host-network processes on the
  nodes can reach the proxy; acceptable for the lab, worth one sentence in HOMELAB step 8.
- **Kyverno** (`11-kyverno.yaml`): accepted by the live CRD. CEL read-through: list concatenation covers containers +
  init + ephemeral; image allowlist is *tighter* than the pin (`agent-ledger:` / `agent-ledger@` prefixes, so
  `agent-ledger-evil` is excluded; good deviation); digest rule anchored `@sha256:[0-9a-f]{64}$`; `NODE_OPTIONS`,
  explicit `automountServiceAccountToken == false`, `readOnlyRootFilesystem == true` for every container, empty
  `envFrom`. `pods/ephemeralcontainers` is matched, so `kubectl debug` with any foreign image is denied. Negative pods
  under `deploy/k8s/test/` are PSA-compliant, so PSA cannot mask the Kyverno message (except see P2-1 for the root pod).
  Enforcement itself could not be exercised live (policy not installed, namespace absent): HOMELAB step 7 does that.
- **Falco** (`deploy/falco/values.yaml`): parses to two rules (checked with the `yaml` package → 2 rule objects);
  chart `falco-9.1.0` is what is installed, so `--version 9.1.0 --reuse-values` only adds rules. Condition fragility:
  see P2-2.
- **Secrets**: none in the repo or rendered output (`check.mjs:10`); ConfigMaps hold only registry/upstreams/init
  script/SQL; init SQL takes passwords as `psql -v` variables from env (`001_init.sh`), and only the `.sh` is in
  `initdb.d`, so the SQL cannot be re-executed without variables. Proxy never mounts the raw `api-key`
  (`check.mjs:35`); the integration Job alone does (pin 12).
- **Dockerfile**: multi-stage; builder `node:24-alpine3.24` `npm ci` → build → `npm ci --omit=dev`; runtime
  `gcr.io/distroless/nodejs24-debian12:nonroot`, `USER 65532`, copies only `dist`, `node_modules`, `package.json`;
  `.dockerignore` is an allowlist; `tsconfig.build.json` includes only `src`. No shell, npm or `policies/`.
- **Kaniko Job**: `tar://` context from a ConfigMap, `--digest-file=/dev/termination-log`, `--reproducible`,
  `--cache=false`, `backoffLimit 0`, no SA token. Context tarball is 149,499 bytes (limit 750,000 stated).
- **Digest pins**: the three agent-ledger images carry the all-zero placeholder filled by step 4 (allowed); busybox and
  postgres are tag-pinned, stated as a residual in HOMELAB (P3-3).

## HOMELAB.md (focus 3)

Steps 0-15 each list changes, exact commands, verify, undo. Workable order checked against resource dependencies:
SAs (6) before the negative pods that reference `serviceAccountName: integration` (7) and before workloads; ConfigMaps
(6) + Secrets (5) before Postgres (8); Kyverno (7) before the first real Pods (8); `-l app=…` selectors in steps 9/11
select exactly the Service/Deployment/Job (+ the SA) because NetworkPolicies carry `labels: {}`. Destructive actions are
flagged (PVC deletion = ledger deletion in step 15; local-path undo guarded; Falco rollback to a recorded revision).
CLI flags in step 13 match `src/cli/main.ts:124` usage (`report --from --to --out [--dir]`). `app/ghcr-pull`,
`build/ghcr-auth`, `attacker/netshoot` exist in the cluster (read-only check). Residuals paragraph present verbatim,
including the spec §3 server-mode sentence.

## Findings

### P2-1  Step 2's "rejected by PSA" proof is rejected by a different admission plugin
`docs/HOMELAB.md:75-81` + `deploy/k8s/test/root-pod.yaml:9` (`serviceAccountName: integration`).
Scenario: at step 2 the SA `integration` does not exist (created in step 6). The ServiceAccount admission plugin runs
in the mutating phase, before PodSecurity, so the dry-run fails with `pods "root-pod" is forbidden: error looking up
service account agent-ledger/integration: serviceaccount "integration" not found` (reproduced live by dry-running the
same pod into `app`). Ryan sees a rejection and the runbook says "must be rejected by PSA", so a mis-labelled namespace
would pass unnoticed at step 2 (step 14 repeats it after the SA exists, so the gap is step-2-only).
Fix: delete `serviceAccountName` from `root-pod.yaml` (the `default` SA exists in every namespace; token automount is
already false), or make step 2's verify say "expected message: `violates PodSecurity "restricted:latest"`" and move
the proof after step 6. Prefer the first.

### P2-2  Falco rule conditions depend on whether `container.image.repository` carries the registry prefix
`deploy/falco/values.yaml:5` (`startswith "ghcr.io/ryan-zeleznock/agent-ledger"`) and `:11`
(`= "docker.io/library/busybox"`).
Falco's field reference documents the field as "The container image repository (e.g. falcosecurity/falco)" and the
upstream default ruleset itself lists both `docker.io/calico/node` and bare `calico/node`, and uses `endswith` for
registry-independence (falco_rules.yaml, `trusted_logging_images`). Under containerd/CRI the prefix handling differs
from Docker. Scenario: if the field comes back as `ryan-zeleznock/agent-ledger`, rule 1 never fires (a silent
detection gap; step 10 "demonstrates" it by absence of alerts, which a dead rule also produces) and rule 2 alerts on
every BusyBox staging shell (noise). [H] which form the lab produces; neither is tested.
Fix: `container.image.repository endswith "ryan-zeleznock/agent-ledger"` and `not container.image.repository endswith
"library/busybox"`; in step 10, after the postgres shell trigger, also require that the two `stage-config` init shells
from step 9 did **not** produce `Shell in agent-ledger namespace` alerts (that proves the busybox exclusion matched,
which transitively proves the field form). Cite the Falco field page when ticking.

### P3-1  Triggers are `ENABLE` (tgenabled `O`), bypassable by `session_replication_role = replica`
`deploy/sql/001_init.sql:21-26`. Superuser-only (verified `ledger_app` cannot set it), so inside the stated residual,
but `ALTER TABLE ledger.records ENABLE ALWAYS TRIGGER records_append_only; … records_no_truncate;` costs two lines and
removes the quiet bypass; the README sentence "Superusers can still disable/drop protections" stays true. Add the
`ENABLE ALWAYS` to the SQL (idempotent) and one test row in `ledger-postgres.test.ts` (`SET LOCAL
session_replication_role = replica; UPDATE` as superuser → still `append-only`).

### P3-2  Kyverno does not forbid `projected.serviceAccountToken` volume sources
`deploy/k8s/11-kyverno.yaml`. `automountServiceAccountToken: false` does not stop an explicit projected token volume.
One more validation: `!has(object.spec.volumes) || object.spec.volumes.all(v, !has(v.projected) ||
v.projected.sources.all(s, !has(s.serviceAccountToken)))`, plus a `bad-pod-projected-token.yaml`.

### P3-3  Tag-only pins for `busybox:1.37.0` and `postgres:17.11-alpine3.24`
Stated residual (HOMELAB "Residuals"). Both run in the restricted namespace with the proxy's secrets (busybox stages
them). Pin by digest in 2b and widen the Kyverno digest rule to all three repos.

### P3-4  Secrets as environment variables in the Postgres pod and the integration Job
`20-postgres.yaml:62-76`, `40-integration.yaml:57-62`. Per pins (table row + pin 12), so not a deviation; for the CKS
story note that the official image supports `POSTGRES_PASSWORD_FILE` and `001_init.sh` could read
`LEDGER_*_PASSWORD` from mounted files. 2b item.

### P3-5  `kubectl exec postgres-0 -- psql` is a password-less superuser (official image `local all all trust`)
`docs/HOMELAB.md:277-286` relies on it for the role/DELETE probes. Add one sentence: "anyone with `exec` on this pod is
the DB superuser; that is the cluster-admin boundary, not a ledger property". Hardening (`POSTGRES_INITDB_ARGS=
--auth-local=scram-sha-256`) is a 2b option that needs its own test of the entrypoint.

### P3-6  Step 12 header expansion at `--scope local` is undocumented-by-flag
`docs/HOMELAB.md:405-410`. Claude Code docs document `${VAR}` expansion in `.mcp.json` fields including `headers`, and
state `${VAR}` references are shown by name for local/project/user servers, so this likely works [H]; the `--header`
flag itself is documented with a literal value. Add a fallback line: if `/mcp` shows 401, write the sandbox's
`.mcp.json` (project scope) with `"Authorization": "Bearer ${AGENT_LEDGER_KEY}"` instead.

### P3-7  Runbook nits
- `docs/HOMELAB.md:83` step 2 undo (`kubectl delete namespace agent-ledger`) should repeat "this deletes the PVC and
  therefore the ledger once step 8 has run" (step 15 says it; step 2's undo is where a reader would first try it).
- `docs/HOMELAB.md:105` `git archive … policies` ships `policies/` in the build context; the Dockerfile never copies it
  and the pin says the image has none. Drop it from the list to keep the context minimal.
- `docs/HOMELAB.md:258` add that `10.20.0.0/24` includes the nodes' own IPs.
- `proxy-config` holds both the proxy's config and the raw `api-key`; a separate `integration-key` Secret would make
  "the proxy pod never sees the key" a RBAC fact rather than an `items:` fact. Optional.

## Pins / ADR compliance
Pin 1 (validator enum literal + comment) ✓ amendment form. Pin 9 SQL ✓ byte-for-byte intent (IF NOT EXISTS guards,
password rotation deliberately not repeated), `PostgresLedger` behaviours ✓, test list ✓ (all items present and
asserting their claims), extra `close()` is an implementation-only extension (documented). Pin 10 table ✓ with the
uid-70 amendment; Kyverno allowlist tighter than pinned (noted, good). Pin 11 steps 0-15 ✓, residuals verbatim ✓.
Pin 12 Job ✓ (`activeDeadlineSeconds: 300` added; fine). `ledger.todo.md` ticked with harness cited ✓; README documents
column/line rule, grants and triggers ✓. No `src/types` edit ✓. No cluster writes by the builder (namespace absent,
no policy installed) ✓.

## Tests
Each test asserts its claim (exact wrapped messages, per-column `brokenAt`, row count unchanged after refused tail,
unique parents across processes, `pg_locks` waiter). Real-process and real-DB suites passed on my full run and a
second targeted run. Harness drops its databases (0 `al_*` left after both runs).

GATE: PASS
