# Home-lab deployment

Use [`docs/HOMELAB.md`](../docs/HOMELAB.md) for Ryan-run installation, verification and teardown. Builders only edit
files and run offline checks. `node deploy/check.mjs` renders with `kubectl kustomize` and checks structural invariants;
it does not prove live admission, event detection, image startup or network isolation.

Fable's [full review](../docs/reviews/2026-10-03-fable-slice-2a-deploy-review.md) reports GATE: PASS for `5f998f8..4e676ab`.
That verdict belongs to the reviewer and does not approve subsequent fixes. The scoped verification pass is pending.

## Review fixes

- P2-1: the step-2 root Pod omits `serviceAccountName` and disables token automount. The runbook requires a
  `violates PodSecurity "restricted:latest"` rejection; a missing ServiceAccount or other error cannot count.
- P2-2: Falco repository filters use `endswith` to tolerate registry prefixes. Step 10 reruns both staging
  initContainers after the rules are loaded, requires no BusyBox shell alerts, and requires the deliberate postgres
  shell alert. Silence without the positive control fails. Logs must cover every relevant node.
- P3-1: the SQL draft enables both append-only triggers `ALWAYS`, including after an idempotent rerun. Three real-PG
  regressions cover UPDATE, DELETE and TRUNCATE by a superuser in replica mode, starting from ordinary trigger mode.
  These changes, the matching ConfigMap SQL copy and test cleanup changes are **uncommitted pending the coordinator's
  Postgres run**. Existing clusters do not rerun initdb hooks automatically; any live upgrade is separate DBA work.
- Runbook clarifications cover password-less superuser access via postgres Pod exec, namespace/PVC deletion,
  project-scope `.mcp.json` fallback, unused build-context removal and node IPs within the LAN range.

The database administrator can still explicitly disable/drop triggers. `ENABLE ALWAYS` closes the replication-role
bypass without changing that trust boundary. [PostgreSQL 16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html)
documents this behavior (checked 2026-10-03); the new runtime regressions await coordinator execution.

## Slice 2b residuals

- [ ] **Projected ServiceAccount tokens:** add a Kyverno validation rejecting explicit
  `projected.sources[].serviceAccountToken` volumes and a matching negative Pod. Current automount denial prevents
  automatic injection, not an explicitly requested token projection; shipped workloads have neither.
- [ ] **BusyBox/Postgres digest pins:** resolve and pin `busybox:1.37.0` and `postgres:17.11-alpine3.24` digests, and
  extend Kyverno's digest requirement to those repositories. Both are currently tag-pinned; BusyBox handles secrets.
- [ ] **Database secrets in files:** use the official image's `POSTGRES_PASSWORD_FILE`, mounted app/reader password
  files in the init hook, and a file-based integration credential flow. Current explicit environment entries follow
  the Slice 2a pins. Prove ownership/modes, initialization, restart and secret-free logs before switching.
- [ ] **Local DB authentication:** evaluate `--auth-local=scram-sha-256` with entrypoint/init-hook tests. Currently anyone
  with exec access to postgres-0 can become the database superuser over its local trusted socket.
- [ ] **Separate integration key:** consider an `integration-key` Secret so exclusion from the proxy is enforced by
  resource access as well as its current Secret `items` projection.

Other retained Slice 2b work: TLS, a maintained image builder replacing archived Kaniko, approval channels, legacy-era
MCP support, and versioned migrations. Runtime image digests remain explicit placeholders until Ryan builds/pins them.
