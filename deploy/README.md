# Home-lab deployment

Use [`docs/HOMELAB.md`](../docs/HOMELAB.md) for Ryan-run installation, verification and teardown. Builders only edit
files and run offline checks. `node deploy/check.mjs` renders with `kubectl kustomize` and checks structural invariants;
it does not prove live admission, event detection, image startup or network isolation.

Fable's [full review](../docs/reviews/2026-10-03-fable-slice-2a-deploy-review.md) reports GATE: PASS for `5f998f8..4e676ab`.
Fable's scoped verification pass over the fixes (`4e676ab..6b88218`) also reports GATE: PASS.

## Review fixes

- P2-1: the step-2 root Pod omits `serviceAccountName` and disables token automount. The runbook requires a
  `violates PodSecurity "restricted:latest"` rejection; a missing ServiceAccount or other error cannot count.
- P2-2: Falco repository filters use `endswith` to tolerate registry prefixes. Step 10 reruns both staging
  initContainers after the rules are loaded, requires no BusyBox shell alerts, and requires the deliberate postgres
  shell alert. Silence without the positive control fails. Logs must cover every relevant node.
- P3-1: the SQL draft enables both append-only triggers `ALWAYS`, including after an idempotent rerun. Three real-PG
  regressions cover UPDATE, DELETE and TRUNCATE by a superuser in replica mode, starting from ordinary trigger mode.
  Committed in `6b88218` after two real-Postgres runs outside the Codex sandbox. Existing clusters do not rerun initdb hooks automatically; any live upgrade is separate DBA work.
- Runbook clarifications cover password-less superuser access via postgres Pod exec, namespace/PVC deletion,
  project-scope `.mcp.json` fallback, unused build-context removal and node IPs within the LAN range.

The database administrator can still explicitly disable/drop triggers. `ENABLE ALWAYS` closes the replication-role
bypass without changing that trust boundary. [PostgreSQL 16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html)
documents this behavior (checked 2026-10-03); the runtime regressions pass against PostgreSQL 16.

## Slice 2b (pins 7, 9, 10; ADR-015/016/017)

- **Proxy:** `replicas: 1` + `strategy: Recreate` (one Socket Mode router per Slack app), `AGENT_LEDGER_APPROVALS=slack`,
  `AGENT_LEDGER_TLS=on`, HTTPS startup/readiness/liveness probes (startup allows 160 s: two 60 s retry loops + 30 s).
  `stage-config` also copies `approvals.yaml` (ConfigMap), `slack-tokens` → `secrets/approvals.{botToken,appToken}` and
  `proxy-tls` → `tls.crt`/`tls.key`, all 0600 as uid 65532.
- **Egress:** proxy → TCP 443 on `0.0.0.0/0` except RFC 1918 (Slack; FQDN policy is 2c) and → `everything:3001`.
- **`everything` upstream** (`32-everything.yaml`, `25-everything` policy: ingress only from the proxy, no egress):
  image built from `upstreams/everything/` (exact `@modelcontextprotocol/server-everything@2026.8.31`, lockfile integrity
  `sha512-5U3OZh8X…zxc7jQ==` asserted by `check.mjs`, `ignore-scripts`), Kaniko `kaniko/job-everything.yaml`, digest
  recorded in the kustomization's `agent-ledger-everything` image entry (zero placeholder until HOMELAB step 4b).
- **Kyverno:** digest requirement extended to Postgres and BusyBox; projected ServiceAccount token volumes forbidden
  (negative Pod `k8s/test/bad-pod-projected-token.yaml`); reports-controller RBAC for `pods/ephemeralcontainers` in
  `k8s/cluster/` (cluster-scoped, applied by HOMELAB step 7b, not part of `-k deploy/k8s`).
- **Slack app:** `slack/app-manifest.yaml` (bot scopes `chat:write` and `users:read` (ADR-015 amendment), Socket Mode, interactivity without Request URL).

### Digest pins (resolved 2026-10-04 from the registries' manifest APIs; multi-arch index digests)

| Image | Digest | Source |
|---|---|---|
| `docker.io/library/busybox:1.37.0` | `sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e` | registry-1.docker.io `Docker-Content-Digest` |
| `docker.io/library/postgres:17.11-alpine3.24` | `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24` | same |
| `docker.io/library/node:24-alpine3.24` (everything build stage) | `sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1` | same |
| `gcr.io/distroless/nodejs24-debian12:nonroot` (everything runtime) | `sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a` | gcr.io `Docker-Content-Digest` |
| `gcr.io/kaniko-project/executor:v1.23.2` (both Kaniko Jobs) | `sha256:9e69fd4330ec887829c780f5126dd80edc663df6def362cd22e79bcdf00ac53f` | gcr.io `Docker-Content-Digest` (OCI index), 2026-10-05 |

ADR-018 (2026-10-05): the proxy's own `Dockerfile` now uses the same node and distroless digests (re-resolved
2026-10-05, unchanged; the distroless entrypoint `/nodejs/bin/node` read from the pinned image config). `check.mjs`
walks the repo and refuses any unpinned `FROM` in any Dockerfile and any unpinned image in `kaniko/*.yaml`.

Server audit P3s in this directory (2026-10-05): proxy egress also excepts 100.64.0.0/10 and 169.254.0.0/16;
Kyverno binds the `app` labels to their ServiceAccounts and `app: proxy` to the proxy itself (negative proofs
`k8s/test/bad-pod-label.yaml`, `k8s/test/bad-ephemeral-container.json`); Falco exempts only the entrypoint node
binary and counts `busybox sh`; `001_init.sh` rejects superuser TCP logins; the agent key is its own Secret
`agent-key`; the demo upstream entry is `insecure: true`. All asserted by `check.mjs`.

## Residuals carried to 2c

- [x] Projected ServiceAccount tokens (2b). [x] BusyBox/Postgres digest pins (2b).
- [ ] **Database secrets in files:** `POSTGRES_PASSWORD_FILE`, mounted app/reader password files, file-based integration
  credential flow.
- [ ] **Local DB authentication:** evaluate `--auth-local=scram-sha-256` (exec on postgres-0 is a superuser path today).
- [x] **Separate integration key** Secret (`agent-key`, ADR-018 round).
- [ ] FQDN-scoped Slack egress (CiliumNetworkPolicy); cert-manager/public CA; replacing archived Kaniko; versioned
  migrations. [x] Pinning the proxy Dockerfile's base images by digest (ADR-018 round).
