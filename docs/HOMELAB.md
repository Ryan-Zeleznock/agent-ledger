# Slice 2a: Ryan's home-lab runbook

Run these steps yourself, from the **reviewed, integrated A+B tree**. Package B alone has no server binaries.
Builders do not run cluster-changing commands, push an image, or edit your real Claude/Codex configuration.
Each numbered step lists its changes, verification, and undo. Execute commands separately and stop at a failed
verification; do not paste this entire document into a terminal. The `apply -k` target includes the integration Job,
so use the ordered resource selections below during first installation. All-zero image digests are placeholders,
not build results. Do not deploy until step 4 replaces them. Save outputs without credentials.

Package B validation (coordinator, 2026-10-03): PostgreSQL 16.13 tests passed outside the sandbox in three runs
(one `npm run check`, two `npm test`), each with 1118 unit passes, 7 existing skips and 79 timing passes; the check
also built successfully and no test databases remained. This does not establish image or cluster acceptance.

The binding pins and coordinator amendments are in `docs/slices/slice-2a-pins.md`.
This guide uses Postgres **70:70, fsGroup 70** (the Alpine account), never uid 999 or a root initContainer.

## 0. Prerequisites and a private workspace (Mac only)

Changes: local working/evidence directories only. Requires kubectl context `kubernetes-admin@kubernetes`,
Helm 4.3.0, Node 24+ (runtime image is Node 24), Claude Code ≥2.1.274, openssl, and the reviewed integrated tree.
Homebrew PostgreSQL 16 is needed only for local tests. Docker is not required. The existing `build` namespace,
`build/ghcr-auth`, Kyverno, Falco, Cilium policy enforcement and trivy-operator are prerequisites.

```sh
kubectl config current-context
kubectl version --client
helm version
claude --version
node --version
kubectl get ns build kube-system falco
kubectl get validatingpolicies.policies.kyverno.io
kubectl -n kube-system get configmap cilium-config -o jsonpath='{.data.enable-policy}'
umask 077
export LAB_WORK="$(mktemp -d /tmp/agent-ledger-lab.XXXXXX)"
export LAB_EVIDENCE="$HOME/agent-ledger-lab"
mkdir -p "$LAB_EVIDENCE"
perl -e 'alarm shift; exec @ARGV' 900 npm run check
```

Verify: context is exactly the one above; full check passes, including real Postgres and timing tests.
`AGENT_LEDGER_PG_BIN` can override `/opt/homebrew/bin`. Missing binaries print a visible skip; sandbox startup
failures are failures, not skips. The harness uses a unique Unix socket and stops its disposable server in teardown.
If the sandbox denies `shmget`, a coordinator may provide an external PostgreSQL server and set
`AGENT_LEDGER_TEST_PG_HOST` to its absolute Unix socket directory before running the same alarm-wrapped check.
The harness connects as postgres, creates/drops a unique database per suite and serializes shared-role creation;
it never stops or reconfigures that server. A configured socket connection failure is not skipped. If the sandbox
also denies Unix socket connections, run the check outside that sandbox; an external server alone is insufficient.
Undo: remove only your disposable `$LAB_WORK` after retaining necessary secrets/evidence; keep `$LAB_EVIDENCE`.

## 1. Storage

Changes: upstream local-path Namespace, RBAC, provisioner Deployment, ConfigMap and StorageClass.
The worker directory is provisioned by the upstream helper; there is no hostPath in our restricted Pods.

```sh
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.37/deploy/local-path-storage.yaml
```

Verify: `kubectl get sc local-path` and `kubectl -n local-path-storage get pods` show the class and ready provisioner.
Reclaim policy is Delete; this is one worker's disk, not replicated storage.
Undo (only after our PVCs are gone, and only if no other workloads now use this installation):

```sh
kubectl delete -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.37/deploy/local-path-storage.yaml
```

## 2. Namespace and PSA

Changes: namespace `agent-ledger` with enforce/audit/warn `restricted`, version `latest`.

```sh
kubectl apply -f deploy/k8s/00-namespace.yaml
```

Verify: `kubectl get ns agent-ledger --show-labels`. The following **server dry-run must be rejected by PSA**;
no root Pod should exist afterwards. Before Kyverno is installed, PSA is the expected rejection source.

```sh
kubectl -n agent-ledger apply --dry-run=server -f deploy/k8s/test/root-pod.yaml
kubectl -n agent-ledger get pods
```

Undo: `kubectl delete namespace agent-ledger` (after data/evidence retention; also deletes namespaced resources).

## 3. GHCR pull credentials

Changes: namespace-local `ghcr-pull` Secret. Export your existing Docker credential JSON to a private local file
outside the repo, or copy the existing app namespace pull secret's data locally. This does not print the credential:

```sh
kubectl -n app get secret ghcr-pull -o jsonpath='{.data.\.dockerconfigjson}' | openssl base64 -d -A > "$LAB_WORK/ghcr.json"
kubectl -n agent-ledger create secret generic ghcr-pull --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson="$LAB_WORK/ghcr.json"
```

Verify: `kubectl -n agent-ledger get secret ghcr-pull` reports type `kubernetes.io/dockerconfigjson`; do not dump data.
Undo: `kubectl -n agent-ledger delete secret ghcr-pull`. Remove the temporary credential file after successful pulls.

## 4. Build with Kaniko and record the digest

Changes: build namespace ConfigMap `agent-ledger-context`, Job `kaniko-agent-ledger`, GHCR image tag `slice-2a`.
Only Ryan runs this push. Kaniko is archived; replacing it is Slice 2b. The repo has no remote dependency for the
build context. Confirm `src/server/main.ts`, `demo-upstream.ts`, and `smoke.ts` exist in the integrated HEAD first.

```sh
git archive --format=tar.gz -o "$LAB_WORK/context.tar.gz" HEAD Dockerfile .dockerignore src policies package.json package-lock.json tsconfig.json tsconfig.build.json .npmrc
wc -c "$LAB_WORK/context.tar.gz"
```

Keep the tarball below 750,000 bytes so base64 plus ConfigMap metadata fits the 1 MiB limit. Then:

```sh
kubectl -n build create configmap agent-ledger-context --from-file=context.tar.gz="$LAB_WORK/context.tar.gz"
kubectl apply -f deploy/kaniko/job.yaml
```

Verify separately (no mutation):

```sh
kubectl -n build get job kaniko-agent-ledger
kubectl -n build get pods -l job-name=kaniko-agent-ledger
kubectl -n build logs job/kaniko-agent-ledger
kubectl -n build get pods -l job-name=kaniko-agent-ledger -o jsonpath='{.items[0].status.containerStatuses[0].state.terminated.message}' > "$LAB_WORK/digest"
```

Require Job Complete and a `sha256:` plus 64 hex digest. Read the **termination message**, not a guessed tag or log
line. The digest fits Kubernetes' termination-message size cap. Update the Kustomize image locally:

```sh
node --input-type=module - "$LAB_WORK/digest" <<'JS'
import fs from 'node:fs';
import YAML from 'yaml';
const digest = fs.readFileSync(process.argv[2], 'utf8').trim();
if (!/^sha256:[0-9a-f]{64}$/.test(digest) || /^sha256:0+$/.test(digest)) throw Error('missing build digest');
const file = 'deploy/k8s/kustomization.yaml';
const config = YAML.parse(fs.readFileSync(file, 'utf8'));
config.images[0].digest = digest;
fs.writeFileSync(file, YAML.stringify(config));
JS
kubectl kustomize deploy/k8s > "$LAB_WORK/rendered.yaml"
```

Review all three Agent Ledger workload images in `rendered.yaml`: tag **and** exact digest, zero placeholder absent.
Verify build logs show `npm ci`, `npm run build`, `npm ci --omit=dev`; runtime contains no shell/npm/policies directory.
Build uses lockfile integrity and ignored install scripts, but fetches dependencies at build time: not a hermetic build.
Image execution/no-config refusal is checked in step 11; local `npm run check` cannot replace the Node 24 image check.
Undo: `kubectl -n build delete job kaniko-agent-ledger`, then `kubectl -n build delete configmap agent-ledger-context`.
Removing the pushed GHCR package/version is a separate Ryan action in GHCR; retain any digest already used for evidence.
For a deliberate rebuild, first remove the old Job and context ConfigMap, then repeat this step.

## 5. Generate and provision secrets

Changes: local private files and Secrets `proxy-config`, `demo-upstream`, `postgres-credentials`.
Never put these files, raw passwords or tokens in the repo/vault/logs. API key bytes have no trailing newline;
`agents.yaml` contains only its SHA-256 digest. `hmac.key` is exactly 32 raw bytes, not 64 hex characters.

```sh
openssl rand -hex 32 | tr -d '\n' > "$LAB_WORK/api-key"
openssl rand 32 > "$LAB_WORK/hmac.key"
openssl rand -hex 32 | tr -d '\n' > "$LAB_WORK/POSTGRES_PASSWORD"
openssl rand -hex 32 | tr -d '\n' > "$LAB_WORK/LEDGER_APP_PASSWORD"
openssl rand -hex 32 | tr -d '\n' > "$LAB_WORK/LEDGER_READER_PASSWORD"
openssl rand -hex 32 | tr -d '\n' > "$LAB_WORK/demo-token"
node --input-type=module - "$LAB_WORK" <<'JS'
import fs from 'node:fs';
import {createHash} from 'node:crypto';
const dir = process.argv[2];
const sha256 = createHash('sha256').update(fs.readFileSync(`${dir}/api-key`)).digest('hex');
fs.writeFileSync(`${dir}/agents.yaml`, JSON.stringify({version:1,agents:[{id:'ryan-lab',credential:{kind:'api_key',sha256}}]})+'\n', {mode:0o600});
JS
kubectl -n agent-ledger create secret generic proxy-config --from-file=agents.yaml="$LAB_WORK/agents.yaml" --from-file=hmac.key="$LAB_WORK/hmac.key" --from-file=ledger.password="$LAB_WORK/LEDGER_APP_PASSWORD" --from-file=demo.bearerToken="$LAB_WORK/demo-token" --from-file=api-key="$LAB_WORK/api-key"
kubectl -n agent-ledger create secret generic demo-upstream --from-file=token="$LAB_WORK/demo-token"
kubectl -n agent-ledger create secret generic postgres-credentials --from-file=POSTGRES_PASSWORD="$LAB_WORK/POSTGRES_PASSWORD" --from-file=LEDGER_APP_PASSWORD="$LAB_WORK/LEDGER_APP_PASSWORD" --from-file=LEDGER_READER_PASSWORD="$LAB_WORK/LEDGER_READER_PASSWORD"
```

`demo.bearerToken` is the legal Secret key; the staging initContainer creates `secrets/demo.bearerToken` on disk.
The extra `api-key` entry is required by pin 12. It is mounted only in the integration Job, never the proxy Pod.
Keep the existing HMAC key when restarting: changing it breaks correlation of hashed arguments across that boundary.
Verify: `kubectl -n agent-ledger get secrets` shows the four Secrets (including ghcr-pull) without their contents.
Undo: delete these three Secrets individually after stopping dependent workloads; deleting a Secret does not rotate
an existing Postgres role password. The init script runs only for empty PGDATA; later password rotation is explicit DBA work.

## 6. Review registry and publish configuration

Changes: ConfigMaps `proxy-registry` and `postgres-init`; four ServiceAccounts with token automount disabled.
Read all **five exposed tool identities**: echo/read/message, now/read, add/write/a+b, wipe/risky/no clear args,
whoami/unreviewed. There are **four registry rows**: whoami must stay absent. Set the four `reviewedAt` values to
today's date after reviewing them. Applying this registry records Ryan's review, not an agent's self-approval.
The raw pairs `demo/echo` etc. become `demo__echo` etc.; never split exposed names to recover identity.

`deploy/sql/001_init.sql` is authoritative. Its byte-identical copy under `config/` is required by Kustomize's
file-loading boundary. Synchronize it before rendering whenever SQL changes:

```sh
cp deploy/sql/001_init.sql deploy/k8s/config/001_init.sql
kubectl kustomize deploy/k8s > "$LAB_WORK/rendered.yaml"
```

Create a local JSON List with just ConfigMaps, then apply it:

```sh
node --input-type=module - "$LAB_WORK/rendered.yaml" "$LAB_WORK/configmaps.json" <<'JS'
import fs from 'node:fs'; import YAML from 'yaml';
const items = YAML.parseAllDocuments(fs.readFileSync(process.argv[2],'utf8')).map(d=>d.toJS()).filter(d=>d.kind==='ConfigMap');
fs.writeFileSync(process.argv[3], JSON.stringify({apiVersion:'v1',kind:'List',items}));
JS
kubectl apply -f "$LAB_WORK/configmaps.json"
kubectl apply -f deploy/k8s/01-serviceaccounts.yaml
```

Verify: `kubectl -n agent-ledger get configmaps,serviceaccounts`; inspect the non-secret ConfigMaps if needed.
`001_init.sh` alone is mounted in initdb.d, with the SQL at `/etc/agent-ledger-init/001_init.sql`; this avoids the
entrypoint executing the SQL a second time without password variables. SQL reruns preserve records/role passwords.
Undo: `kubectl -n agent-ledger delete configmap proxy-registry postgres-init`, then delete the four ServiceAccounts
only after the workloads stop.

## 7. Kyverno and negative proofs

Changes: cluster-scoped ValidatingPolicy `agent-ledger-hardening`, restricted to Pods in our namespace.

```sh
kubectl apply -f deploy/k8s/11-kyverno.yaml
```

Verify: `kubectl get validatingpolicy agent-ledger-hardening -o yaml` reports ready/accepted with no CEL errors.
Run each negative Pod as a **server dry-run**; every command must fail with its intended policy message:

```sh
kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-image.yaml
kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-digest.yaml
kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-node-options.yaml
kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-env-from.yaml
kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-token.yaml
kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-writable.yaml
kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-init.yaml
kubectl apply --dry-run=client -k deploy/k8s
kubectl apply --dry-run=server -k deploy/k8s
```

Dry-running a Deployment/Job does not exercise its future Pod admission. Extract and dry-run actual Pod templates:

```sh
node --input-type=module - "$LAB_WORK/rendered.yaml" "$LAB_WORK/pod-proofs.json" <<'JS'
import fs from 'node:fs'; import YAML from 'yaml';
const docs=YAML.parseAllDocuments(fs.readFileSync(process.argv[2],'utf8')).map(d=>d.toJS());
const items=docs.filter(d=>['Deployment','StatefulSet','Job'].includes(d.kind)).map(d=>({apiVersion:'v1',kind:'Pod',metadata:{name:`proof-${d.metadata.name}`,namespace:'agent-ledger',labels:d.spec.template.metadata.labels},spec:{...d.spec.template.spec,volumes:[...(d.spec.template.spec.volumes??[]),...(d.spec.volumeClaimTemplates??[]).map(v=>({name:v.metadata.name,persistentVolumeClaim:{claimName:`${v.metadata.name}-${d.metadata.name}-0`}}))]}}));
fs.writeFileSync(process.argv[3],JSON.stringify({apiVersion:'v1',kind:'List',items}));
JS
kubectl apply --dry-run=server -f "$LAB_WORK/pod-proofs.json"
```

Those positive Pod proofs must pass. No proof Pod is created. Offline, `node deploy/check.mjs` validates rendered structural invariants without an API call. The image allowlist includes init and ephemeral
containers, pins Agent Ledger digests, refuses NODE_OPTIONS (including bulk envFrom imports), and requires explicit token/rootfs settings.
Undo: `kubectl delete validatingpolicy agent-ledger-hardening`. Negative tests are not resources to delete.

## 8. Postgres, storage, and network boundaries

Changes: all seven NetworkPolicies, Postgres Service and StatefulSet with a 2Gi local-path PVC.
Postgres/demo have no outbound allowance; DNS is allowed only for proxy/integration. Replies to allowed inbound
connections remain allowed. Pod selectors are namespace-local; attacker labels in another namespace grant no access.

```sh
kubectl apply -f deploy/k8s/10-networkpolicies.yaml
kubectl apply -f deploy/k8s/20-postgres.yaml
```

Verify (inspection commands):

```sh
kubectl -n agent-ledger get statefulset,pods,pvc,services,networkpolicies -o wide
kubectl -n agent-ledger describe pod postgres-0
kubectl -n agent-ledger logs postgres-0
```

Require PVC Bound and Postgres Ready. Ryan-only execution checks below inspect uid/readiness and exercise the
append-only boundary; builders never run these. The DELETE is an intentional denied mutation probe:

```sh
kubectl -n agent-ledger exec postgres-0 -- id
kubectl -n agent-ledger exec postgres-0 -- pg_isready -U postgres -d ledger
kubectl -n agent-ledger exec postgres-0 -- psql -U postgres -d ledger -c '\du'
kubectl -n agent-ledger exec postgres-0 -- psql -U ledger_app -d ledger -c 'DELETE FROM ledger.records'
```

Expected: uid/gid 70, accepting connections, ledger_app/ledger_reader roles, permission denied on DELETE.
SELECT+INSERT app grants and SELECT-only reader grants are backed by UPDATE/DELETE/TRUNCATE refusal triggers.
A superuser can deliberately disable/drop triggers: this is not protection against the cluster/database administrator.
Keep anchors off-machine. If initdb cannot use the mount, inspect the local-path directory permissions and fsGroup;
the PGDATA **subdirectory** is intentional. A reviewed fsGroupChangePolicy/subPath adjustment is the fallback,
never a root Pod or privileged chmod helper. Stop and report if that is needed; do not silently weaken PSA.
Undo: delete StatefulSet and Service (`kubectl delete -f deploy/k8s/20-postgres.yaml`); PVC is retained by default.
Remove NetworkPolicies only after proxy/demo/integration are stopped. PVC deletion is a separate destructive step 15.

## 9. Demo upstream and proxy

Changes: two Deployments, demo ClusterIP Service and proxy NodePort Service (30787, externalTrafficPolicy Local).
The Deployments must use the rendered digest; applying their unrendered YAML directly is deliberately denied.

```sh
kubectl -n agent-ledger apply -k deploy/k8s -l app=demo-upstream
kubectl -n agent-ledger apply -k deploy/k8s -l app=proxy
```

Verify: `kubectl -n agent-ledger get deployments,pods,services -o wide`, then
`kubectl -n agent-ledger logs deployment/demo-upstream` and `kubectl -n agent-ledger logs deployment/proxy`.
Require both Ready; proxy startup should confirm ledger connectivity/head without a URL/password/stack.
If startup reports a config file's ownership/mode error, inspect `kubectl -n agent-ledger logs deployment/proxy -c stage-config`
and the Pod's init status; staging must create files owned by 65532, mode 0600. Do not print file contents.

Start the tunnel in a separate terminal (Ryan action; stop with Ctrl-C):

```sh
kubectl -n agent-ledger port-forward svc/proxy 8787:8787
curl --fail http://127.0.0.1:8787/healthz
```

Expect `{"ok":true}`. PSA may accept a Deployment but reject its Pods: inspect Pods, not just apply's exit status.
Undo: delete each Deployment and Service (`kubectl -n agent-ledger delete deployment,service proxy demo-upstream`).

## 10. Falco rules

Changes: Falco Helm release values add two custom rules. Preserve existing settings; do not patch its DaemonSet.
Save the current revision/values before upgrading:

```sh
helm -n falco history falco
helm -n falco get values falco > "$LAB_WORK/falco-before.yaml"
helm upgrade falco falcosecurity/falco --namespace falco --version 9.1.0 --reuse-values -f deploy/falco/values.yaml
```

Verify: `kubectl -n falco get pods` and `kubectl -n falco logs ds/falco --since=10m` show loaded rules without errors.
Ryan-only trigger (exec starts a process; builders do not run it):

```sh
kubectl -n agent-ledger exec postgres-0 -- sh -c id
kubectl -n falco logs ds/falco --since=5m
```

Find `Shell in agent-ledger namespace` with postgres-0. BusyBox staging is deliberately excluded from that rule.
The distroless proxy has no shell, so demonstrate its rule by **absence of unexpected process alerts**, not by
claiming a successful shell exec. Initial postgres entrypoint shells can also legitimately trigger the namespace rule.
Undo: `helm -n falco rollback falco <the-recorded-previous-revision>` (replace the placeholder with the saved revision).

## 11. Integration Job and image startup check

Changes: Job `integration` (backoffLimit 0, one-day TTL, five-minute deadline). Uses the same Node 24/distroless image,
reader DB password and a key-only mount. Its Node launcher runs smoke, anchor, verify sequentially without a shell;
any command failure or non-head anchor status fails the Job. `/work` is ephemeral: copy the anchor before TTL expiry.

```sh
kubectl -n agent-ledger apply -k deploy/k8s -l app=integration
```

Verify:

```sh
kubectl -n agent-ledger get job,pods -l app=integration
kubectl -n agent-ledger logs job/integration > "$LAB_EVIDENCE/integration.log"
```

Require Job Complete, `SMOKE PASS`, verify exit 0 with `"status":"head"`, and an `ANCHOR {…}` line.
Extract the exact off-machine anchor copy without reconstructing its contents:

```sh
node --input-type=module - "$LAB_EVIDENCE" <<'JS'
import fs from 'node:fs';
const dir=process.argv[2], text=fs.readFileSync(`${dir}/integration.log`,'utf8');
const lines=text.split('\n').filter(x=>x.startsWith('ANCHOR ')).map(x=>x.slice(7));
if(!lines.length)throw Error('no Job anchor found');
fs.writeFileSync(`${dir}/integration-anchors.jsonl`,lines.join('\n')+'\n',{mode:0o600});
JS
```

Copy this anchor/evidence to your chosen vault pack directory without keys or passwords.
Also prove the built image refuses missing configuration: generate a local Pod from the rendered proxy template,
remove env/volumes/initContainers, and use only `dist/server/main.js`. This is a real Ryan-run Pod, unlike step 7:

```sh
node --input-type=module - "$LAB_WORK/rendered.yaml" "$LAB_WORK/no-config.json" <<'JS'
import fs from 'node:fs'; import YAML from 'yaml';
const proxy=YAML.parseAllDocuments(fs.readFileSync(process.argv[2],'utf8')).map(d=>d.toJS()).find(d=>d.kind==='Deployment'&&d.metadata.name==='proxy');
const spec=proxy.spec.template.spec;
delete spec.initContainers; delete spec.volumes; spec.restartPolicy='Never';
const c=spec.containers[0]; delete c.env; delete c.volumeMounts; delete c.readinessProbe; delete c.livenessProbe;
fs.writeFileSync(process.argv[3],JSON.stringify({apiVersion:'v1',kind:'Pod',metadata:{name:'no-config',namespace:'agent-ledger'},spec}));
JS
kubectl apply -f "$LAB_WORK/no-config.json"
```

Verify: `kubectl -n agent-ledger get pod no-config -o jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}'`
is **1**; `kubectl -n agent-ledger logs no-config` gives a generic configuration failure, no stack or secrets.
Undo: `kubectl -n agent-ledger delete pod no-config`, then `kubectl -n agent-ledger delete job integration`.
Delete the completed integration Job before an intentional rerun; do not replace its evidence with an unlabelled retry.

## 12. Claude Code on the Mac (sandbox project only)

Changes: a fresh sandbox project's local MCP configuration. No edits to `~/.claude`, `~/.codex` or a real project.
Read `kubectl -n agent-ledger get pod -l app=proxy -o wide` and `kubectl get nodes -o wide`: choose the InternalIP
of the node **actually running the proxy**. With externalTrafficPolicy Local, another node need not answer 30787.
The example 10.20.0.11 is valid only if that is the selected node. Keep traffic on the lab LAN.

```sh
mkdir -p "$LAB_WORK/claude-sandbox"
cd "$LAB_WORK/claude-sandbox"
export AGENT_LEDGER_KEY="$(cat "$LAB_WORK/api-key")"
MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude mcp add --scope local --transport http agent-ledger http://10.20.0.11:30787/mcp --header 'Authorization: Bearer ${AGENT_LEDGER_KEY}'
MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude
```

The single quotes deliberately retain Claude Code's `${AGENT_LEDGER_KEY}` expansion; the secret is not in argv or
the saved configuration. Keep that environment variable set for the sandbox Claude process, then unset it afterwards.
Verify `/mcp` shows five tools. Ask Claude to echo hello, add 2+3, call `demo__wipe`, and call `demo__whoami`.
Echo/add succeed; wipe is denied with no channel; whoami is denied as unreviewed. No real data is wiped.

For flow evidence, Ryan starts `kubectl -n kube-system port-forward svc/hubble-relay 4245:80` in another terminal,
then `hubble observe --server localhost:4245 --namespace agent-ledger --since 5m`.
Require forwarded Mac→proxy traffic and proxy→demo/Postgres traffic. If NodePort/ipBlock matching fails, record the
Hubble verdict and use `kubectl -n agent-ledger port-forward svc/proxy 8787:8787`, replacing the sandbox MCP URL with
`http://127.0.0.1:8787/mcp`. This tests application behavior, not the NodePort policy claim.
If the v2 protocol probe fails, port-forward cannot fix an era mismatch: retain smoke evidence and report the need
for Slice 2b's dual-era front. Never silently call this a successful Claude integration.
Undo: in the sandbox, `claude mcp remove --scope local agent-ledger`; exit Claude, `unset AGENT_LEDGER_KEY`, stop tunnels.
Return to the integrated repo before the remaining steps.

## 13. Evidence and off-machine anchors

Changes: Mac-side anchor/evidence files only; Postgres uses ledger_reader. Ryan starts in another terminal:

```sh
kubectl -n agent-ledger port-forward svc/postgres 15432:5432
```

From the integrated repo, with the PostgreSQL password in the environment (never URL/argv):

```sh
export PGPASSWORD="$(cat "$LAB_WORK/LEDGER_READER_PASSWORD")"
node dist/cli/main.js anchor --ledger postgres://ledger_reader@127.0.0.1:15432/ledger --dir "$LAB_EVIDENCE"
node dist/cli/main.js verify --ledger postgres://ledger_reader@127.0.0.1:15432/ledger --dir "$LAB_EVIDENCE"
node dist/cli/main.js report --ledger postgres://ledger_reader@127.0.0.1:15432/ledger --dir "$LAB_EVIDENCE" --from 2026-10-03T00:00:00Z --to 2026-10-04T00:00:00Z --out "$LAB_EVIDENCE/pack"
unset PGPASSWORD
```

Adjust report timestamps to enclose today's demo. Verify exit 0, chain valid and anchor `head` (pause new calls while
anchoring). The pack's CC8.1 table should include allowed executions and `denied: no channel` with `channel: none`
for risky/unreviewed requests. Keep `anchors.jsonl` and the Job anchor on the Mac; a complete deleted database suffix
is invisible to internal chain verification alone. Report verification must compare a retained anchor.
[Verified 2026-10-03: node-postgres uses libpq-style PGPASSWORD](https://node-postgres.com/features/connecting).
If constructing a password-bearing URL programmatically, encode the password with `encodeURIComponent` exactly once;
raw `@`, `%`, `:` etc. must not become URI syntax. The server composition root performs this insertion from its file.
Undo: stop the tunnel. Keep anchors/packs; removing local evidence is a separate deliberate retention decision.

## 14. CKS tour and leak sweep

Changes: none for the inspection commands; attacker exec is a Ryan-only proof using an existing lab attacker Pod.
Repeat step 2 PSA and step 7 Kyverno dry-runs, and show the Falco alert from step 10.

```sh
kubectl -n agent-ledger get vulnerabilityreports
kubectl -n agent-ledger get networkpolicies
kubectl -n attacker exec netshoot -- curl --max-time 3 http://proxy.agent-ledger.svc.cluster.local:8787/healthz
kubectl -n attacker exec netshoot -- curl --max-time 3 http://demo-upstream.agent-ledger.svc.cluster.local:3001/mcp
```

Both attacker requests must time out (curl exit 28); verify destination IP/port and drops with Hubble. A DNS failure,
missing attacker Pod or connection-refused is **not** proof of NetworkPolicy isolation. If the named attacker fixture
does not already exist, arrange it as a separate approved lab setup; do not deploy an unpinned latest image here.
NetworkPolicy assumes Cilium enforces it. A cluster administrator able to relabel Pods/change policy is outside this
boundary. Direct upstream auth refusal is independently checked by smoke from the integration Pod.

Leak sweep: inspect retained proxy/demo/Job logs, a reader-only ledger export, and the generated pack locally for the
API key, demo token, database password/URL, clear values of hashed arguments and any NODE_OPTIONS canary. Use a local
script that reports only pass/fail and filenames, never matched secret bytes. Do not copy raw dumps into the vault.
Undo: no installed resources from this step; stop any inspection tunnels. Keep sanitized proof outputs.

## 15. Teardown in reverse order

Changes: remove this slice's workloads/policies/secrets; optionally remove its ledger storage and provisioner.
First copy and verify the Mac anchor/pack. **Deleting the PVC deletes the ledger** (local-path reclaim Delete).
Do not remove shared Falco/Cilium/Kyverno installations. Restore Falco's previous Helm revision from step 10 first.
Run each action separately:

```sh
kubectl -n agent-ledger delete job integration --ignore-not-found
kubectl -n agent-ledger delete pod no-config --ignore-not-found
kubectl -n agent-ledger delete deployment proxy demo-upstream
kubectl -n agent-ledger delete service proxy demo-upstream
kubectl -n agent-ledger delete statefulset postgres
kubectl -n agent-ledger delete service postgres
```

Verify no workload remains with `kubectl -n agent-ledger get pods,pvc`. Keep the PVC to preserve data, or explicitly
choose destructive removal after off-machine evidence retention:

```sh
kubectl -n agent-ledger delete pvc data-postgres-0
kubectl delete validatingpolicy agent-ledger-hardening
kubectl delete namespace agent-ledger
kubectl -n build delete job kaniko-agent-ledger --ignore-not-found
kubectl -n build delete configmap agent-ledger-context --ignore-not-found
```

Namespace deletion also removes its Secrets, ConfigMaps, ServiceAccounts and NetworkPolicies. If keeping the PVC,
do not delete the namespace. The Mac anchor and pack survive teardown. Remove the provisioner using step 1's undo
only if this slice was its sole user. Verify namespace/Job/PVC absence with read-only `kubectl get` commands.
Undo: repeat installation with retained secrets and surviving storage; a deleted PVC needs a real backup to recover
records. Anchors prove history but are **not** database backups. Rebuilding empty storage is a new ledger.

## Residuals and evidence limits

plain HTTP on the lab LAN (TLS is 2b); one Postgres replica on one node's disk; the Kaniko project is archived;
no approval channel means risky calls are denied, not approved.

**SERVER MODE** is **the enforcement boundary**: the proxy holds the upstream credentials, the agent has none, and every
tool call has to pass through the proxy to happen at all. Only server-mode records support the claim "no risky action ran
without a recorded approval".

That claim applies to the governed demo tools and the credential/network boundary proved above; this demo's risky
action is harmless and denied. It does not turn local hooks into enforcement or defend against cluster/DB admins.
Third-party legacy-era MCP upstreams, TLS, Slack approvals, stdio, Cilium L7 policies, versioned migrations and a
maintained image builder remain Slice 2b. The local test database is 16; the cluster Job closes the 17.11/runtime gap.
Build-stage/base image tags are version-pinned per the pins; only the published Agent Ledger workload image is
resolved to a digest here. No digest or successful cluster proof is invented by this runbook.
