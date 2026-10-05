# Slice 2a + 2b: Ryan's home-lab runbook

**Slice 2b additions** (pins `docs/slices/slice-2b-pins.md` pin 11; ADR-015/016/017): steps **1** (helper image pin),
**3b** (Slack app), **4b** (`everything` image), **5b** (Slack tokens, `approvals.yaml`, lab CA + proxy TLS), **7b** (Kyverno
reports RBAC), **9b** (`everything` upstream), **11**, **12** (HTTPS), **12b** (live Slack approval, the slice headline),
**12c** (optional Codex), **13**, **15** and the residuals. The proxy now refuses to start without `AGENT_LEDGER_TLS`, so a
2a-only walk-through of this file no longer applies to the 2b manifests.

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
**2b amendment:** the v0.0.37 manifest's helper Pod uses an untagged `docker.io/library/busybox` (line 185 of the file,
read 2026-10-04), which the cluster's `disallow-latest-tag` policy blocks, so PVCs never bind. Apply it with that ONE
line rewritten to the digest-pinned BusyBox the namespace uses (index digest resolved from Docker Hub 2026-10-04). Review
the rewrite first; it must change exactly one line:

```sh
curl -fsSL https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.37/deploy/local-path-storage.yaml -o "$LAB_WORK/local-path.yaml"
sed 's|^        image: docker.io/library/busybox$|        image: docker.io/library/busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e|' "$LAB_WORK/local-path.yaml" > "$LAB_WORK/local-path-pinned.yaml"
diff "$LAB_WORK/local-path.yaml" "$LAB_WORK/local-path-pinned.yaml"
kubectl apply -f "$LAB_WORK/local-path-pinned.yaml"
```

Verify: `diff` shows only line 185; `kubectl get sc local-path` and `kubectl -n local-path-storage get pods` show the
class and ready provisioner; `kubectl -n local-path-storage get cm local-path-config -o jsonpath='{.data.helperPod\.yaml}' | grep image`
prints the `@sha256:bdf57e52…` image.
Reclaim policy is Delete; this is one worker's disk, not replicated storage.
Undo (only after our PVCs are gone, and only if no other workloads now use this installation):

```sh
kubectl delete -f "$LAB_WORK/local-path-pinned.yaml"
```

## 2. Namespace and PSA

Changes: namespace `agent-ledger` with enforce/audit/warn `restricted`, version `latest`.

```sh
kubectl apply -f deploy/k8s/00-namespace.yaml
```

Verify: `kubectl get ns agent-ledger --show-labels`. The root Pod uses the namespace's default ServiceAccount with
`automountServiceAccountToken: false`; it does not depend on step 6's `integration` account. Confirm the default
account exists first. The **server dry-run must fail and contain the PodSecurity rejection**, not merely any error:

```sh
kubectl -n agent-ledger get serviceaccount default
if kubectl -n agent-ledger apply --dry-run=server -f deploy/k8s/test/root-pod.yaml > "$LAB_WORK/psa-root-proof.log" 2>&1; then
  echo 'FAIL: root Pod passed admission'
  false
else
  cat "$LAB_WORK/psa-root-proof.log"
  grep -F 'violates PodSecurity "restricted:latest"' "$LAB_WORK/psa-root-proof.log"
fi
kubectl -n agent-ledger get pods
```

A missing ServiceAccount, unavailable webhook or other unrelated failure is **not** a passing proof. Require the
exact PodSecurity text above; no root Pod should exist afterwards. Before Kyverno is installed, PSA is the rejection source.
Undo: `kubectl delete namespace agent-ledger` (after data/evidence retention). **Once step 8 has run, this also deletes
the PVC and therefore the ledger**, as well as the other namespaced resources. Keep the namespace if retaining its PVC.

## 3. GHCR pull credentials

Changes: namespace-local `ghcr-pull` Secret. Export your existing Docker credential JSON to a private local file
outside the repo, or copy the existing app namespace pull secret's data locally. This does not print the credential:

```sh
kubectl -n app get secret ghcr-pull -o jsonpath='{.data.\.dockerconfigjson}' | openssl base64 -d -A > "$LAB_WORK/ghcr.json"
kubectl -n agent-ledger create secret generic ghcr-pull --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson="$LAB_WORK/ghcr.json"
```

Verify: `kubectl -n agent-ledger get secret ghcr-pull` reports type `kubernetes.io/dockerconfigjson`; do not dump data.
Undo: `kubectl -n agent-ledger delete secret ghcr-pull`. Remove the temporary credential file after successful pulls.

## 3b. Slack app (Ryan, in the Slack UI; nothing runs in the cluster)

Changes: one new Slack app in your workspace, one private channel, two token files on the Mac. ADR-015.
1. https://api.slack.com/apps → **Create New App** → **From a manifest** → your workspace → paste
   `deploy/slack/app-manifest.yaml` (name "Agent Ledger", bot `agent-ledger`, bot scopes `chat:write` + `users:read`, Socket Mode on,
   interactivity on with no Request URL, org deploy off, token rotation off) → Create.
2. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`). For an existing app, add
   `users:read` under OAuth & Permissions → Bot Token Scopes, then **Reinstall to Workspace** to grant it.
   If Slack issues a new bot token, replace the private token file and refresh the `slack-tokens` Secret (step 5b).
   The member-id allowlist is unchanged; `users.info` only supplies a best-effort name at decision time.
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**, scope **`connections:write`** → copy the `xapp-…` token.
4. Create a **private** channel `#agent-ledger-approvals`; in it run `/invite @agent-ledger`. Channel details → copy the
   channel id (`C…` or `G…`). For each approver: profile → ⋯ → **Copy member ID** (`U…`/`W…`).
5. Save both tokens as files without echoing them (paste into the editor, save, quit):

```sh
mkdir -p "$LAB_EVIDENCE/.secrets" && chmod 700 "$LAB_EVIDENCE/.secrets"
(umask 077; ${EDITOR:-vi} "$LAB_EVIDENCE/.secrets/slack-bot-token")
(umask 077; ${EDITOR:-vi} "$LAB_EVIDENCE/.secrets/slack-app-token")
```

Verify: `stat -f '%Sp %N' "$LAB_EVIDENCE"/.secrets/slack-*` shows `-rw-------` for both; `cut -c1-5` of each file prints
`xoxb-` and `xapp-` respectively (prefix only); the app's Socket Mode page shows "enabled" and OAuth & Permissions
lists both bot scopes after reinstall. Never paste a token into a shell command line, chat, the vault or a log. **This app is dedicated to the ONE lab proxy**: Slack sends each click to any
of the app's open Socket Mode connections, so any second consumer (another proxy, a test script, a Codex hook) eats clicks.
Undo: Slack app settings → **Delete App** (revokes both tokens), delete the channel if unwanted, `rm` the two token files.

## 4. Build with Kaniko and record the digest

Changes: build namespace ConfigMap `agent-ledger-context`, Job `kaniko-agent-ledger`, GHCR image tag `slice-2a`.
Only Ryan runs this push. Kaniko is archived; replacing it is Slice 2b. The repo has no remote dependency for the
build context. Confirm `src/server/main.ts`, `demo-upstream.ts`, and `smoke.ts` exist in the integrated HEAD first.

```sh
git archive --format=tar.gz -o "$LAB_WORK/context.tar.gz" HEAD Dockerfile .dockerignore src package.json package-lock.json tsconfig.json tsconfig.build.json .npmrc
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

Review all three Agent Ledger workload images in `rendered.yaml`: tag **and** exact digest, zero placeholder absent
(2b: the fourth, `everything`, keeps its zero placeholder until step 4b; the proxy image is the 2b build).
Verify build logs show `npm ci`, `npm run build`, `npm ci --omit=dev`; runtime contains no shell/npm/policies directory.
Build uses lockfile integrity and ignored install scripts, but fetches dependencies at build time: not a hermetic build.
Image execution/no-config refusal is checked in step 11; local `npm run check` cannot replace the Node 24 image check.
Undo: `kubectl -n build delete job kaniko-agent-ledger`, then `kubectl -n build delete configmap agent-ledger-context`.
Removing the pushed GHCR package/version is a separate Ryan action in GHCR; retain any digest already used for evidence.
For a deliberate rebuild, first remove the old Job and context ConfigMap, then repeat this step.

## 4b. Build the `everything` upstream image (Slice 2b pin 10)

Changes: build namespace ConfigMap `agent-ledger-everything-context`, Job `kaniko-agent-ledger-everything`, GHCR tag
`everything-2026.8.31` in the same repository as the proxy (so the Kyverno image/digest rules apply unchanged).
The context is ONLY `deploy/upstreams/everything` (package.json, the integrity-pinned lockfile, `.npmrc`
`ignore-scripts=true`, the Dockerfile with digest-pinned bases). `node deploy/check.mjs` must pass first: it asserts
the lockfile's `server-everything` entry is `2026.8.31` with integrity `sha512-5U3OZh8X…zxc7jQ==` and every package is
from registry.npmjs.org with an integrity and no install script.

```sh
node deploy/check.mjs
git archive --format=tar.gz -o "$LAB_WORK/everything.tar.gz" HEAD:deploy/upstreams/everything
tar tzf "$LAB_WORK/everything.tar.gz"
kubectl -n build create configmap agent-ledger-everything-context --from-file=context.tar.gz="$LAB_WORK/everything.tar.gz"
kubectl apply -f deploy/kaniko/job-everything.yaml
```

Verify: `tar tzf` lists exactly `.npmrc`, `Dockerfile`, `package-lock.json`, `package.json`; the Job completes; the
logs show `npm ci --omit=dev --ignore-scripts`. Read the digest from the termination message as in step 4, then record
it as the SECOND image entry (`agent-ledger-everything`):

```sh
kubectl -n build get pods -l job-name=kaniko-agent-ledger-everything -o jsonpath='{.items[0].status.containerStatuses[0].state.terminated.message}' > "$LAB_WORK/everything-digest"
node --input-type=module - "$LAB_WORK/everything-digest" <<'JS'
import fs from 'node:fs';
import YAML from 'yaml';
const digest = fs.readFileSync(process.argv[2], 'utf8').trim();
if (!/^sha256:[0-9a-f]{64}$/.test(digest) || /^sha256:0+$/.test(digest)) throw Error('missing build digest');
const file = 'deploy/k8s/kustomization.yaml';
const config = YAML.parse(fs.readFileSync(file, 'utf8'));
const entry = config.images.find((i) => i.name === 'agent-ledger-everything');
if (!entry) throw Error('no agent-ledger-everything image entry');
entry.digest = digest;
fs.writeFileSync(file, YAML.stringify(config));
JS
kubectl kustomize deploy/k8s | grep 'agent-ledger:everything-2026.8.31@sha256:'
```

The rendered `everything` image must be `ghcr.io/ryan-zeleznock/agent-ledger:everything-2026.8.31@sha256:<that digest>`.
Like step 4, this fetches npm packages at build time (integrity-checked, not hermetic). Replacing Kaniko is 2c.
Undo: `kubectl -n build delete job kaniko-agent-ledger-everything`, then `kubectl -n build delete configmap agent-ledger-everything-context`.

## 5. Generate and provision secrets

Changes: local private files and Secrets `proxy-config`, `agent-key`, `demo-upstream`, `postgres-credentials`.
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
kubectl -n agent-ledger create secret generic proxy-config --from-file=agents.yaml="$LAB_WORK/agents.yaml" --from-file=hmac.key="$LAB_WORK/hmac.key" --from-file=ledger.password="$LAB_WORK/LEDGER_APP_PASSWORD" --from-file=demo.bearerToken="$LAB_WORK/demo-token"
kubectl -n agent-ledger create secret generic agent-key --from-file=api-key="$LAB_WORK/api-key"
kubectl -n agent-ledger create secret generic demo-upstream --from-file=token="$LAB_WORK/demo-token"
kubectl -n agent-ledger create secret generic postgres-credentials --from-file=POSTGRES_PASSWORD="$LAB_WORK/POSTGRES_PASSWORD" --from-file=LEDGER_APP_PASSWORD="$LAB_WORK/LEDGER_APP_PASSWORD" --from-file=LEDGER_READER_PASSWORD="$LAB_WORK/LEDGER_READER_PASSWORD"
```

`demo.bearerToken` is the legal Secret key; the staging initContainer creates `secrets/demo.bearerToken` on disk.
The agent's `api-key` (pin 12) lives in its OWN Secret `agent-key` (server audit P3, 2026-10-05), mounted only by the
integration Job; nothing that mounts `proxy-config` can read it. **Existing lab (migration, Ryan):** create `agent-key`
as above, re-apply `deploy/k8s/40-integration.yaml`, then remove the old entry with
`kubectl -n agent-ledger patch secret proxy-config --type=json -p '[{"op":"remove","path":"/data/api-key"}]'`.
Keep the existing HMAC key when restarting: changing it breaks correlation of hashed arguments across that boundary.
Verify: `kubectl -n agent-ledger get secrets` shows the four Secrets (including ghcr-pull) without their contents.
Undo: delete these three Secrets individually after stopping dependent workloads; deleting a Secret does not rotate
an existing Postgres role password. The init script runs only for empty PGDATA; later password rotation is explicit DBA work.

## 5b. Slack tokens, `approvals.yaml`, lab CA and proxy TLS (Slice 2b pins 5, 9; ADR-015, ADR-017)

Changes: Secrets `slack-tokens` and `proxy-tls`, ConfigMap `proxy-ca` (public CA cert), a local edit of
`deploy/k8s/config/approvals.yaml`, and a lab CA on the Mac. The proxy reads the tokens as `secrets/approvals.botToken`
and `secrets/approvals.appToken` (staged 0600 as uid 65532); `approvals` is a reserved upstream name.

```sh
kubectl -n agent-ledger create secret generic slack-tokens --from-file=approvals.botToken="$LAB_EVIDENCE/.secrets/slack-bot-token" --from-file=approvals.appToken="$LAB_EVIDENCE/.secrets/slack-app-token"
```

Edit `deploy/k8s/config/approvals.yaml`: replace `C0000000000` with the channel id and `[U0000000000]` with the approver
member ids from step 3b; keep `timeoutMs: 180000` (max 240000: Claude Code aborts a silent tool call after 300 s).
`node deploy/check.mjs` stops printing `APPROVALS PLACEHOLDER`. The file is published with the other ConfigMaps in step 6.

**TLS.** The proxy terminates TLS itself with a certificate from a lab CA you create here (no cert-manager or Ingress
in the lab). The CA key never leaves `$LAB_EVIDENCE/.secrets/`. Read node InternalIPs first and put EVERY one in the SAN
list (the NodePort is reached by node IP); `127.0.0.1` is included for the port-forward checks in steps 9 and 12.

```sh
kubectl get nodes -o wide
export NODE_IPS="IP:10.20.0.10,IP:10.20.0.11,IP:10.20.0.12"   # replace with the InternalIPs printed above
(umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$LAB_EVIDENCE/.secrets/ca.key")
openssl req -x509 -new -key "$LAB_EVIDENCE/.secrets/ca.key" -sha256 -days 825 -subj "/CN=Agent Ledger lab CA" -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out "$LAB_EVIDENCE/ca.crt"
(umask 077; openssl ecparam -name prime256v1 -genkey -noout -out "$LAB_WORK/tls.key")
openssl req -new -key "$LAB_WORK/tls.key" -subj "/CN=proxy.agent-ledger.svc" -out "$LAB_WORK/tls.csr"
printf 'subjectAltName=DNS:proxy.agent-ledger.svc,DNS:proxy.agent-ledger.svc.cluster.local,IP:127.0.0.1,%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$NODE_IPS" > "$LAB_WORK/server.ext"
openssl x509 -req -in "$LAB_WORK/tls.csr" -CA "$LAB_EVIDENCE/ca.crt" -CAkey "$LAB_EVIDENCE/.secrets/ca.key" -CAcreateserial -days 825 -sha256 -extfile "$LAB_WORK/server.ext" -out "$LAB_WORK/tls.crt"
kubectl -n agent-ledger create secret tls proxy-tls --cert="$LAB_WORK/tls.crt" --key="$LAB_WORK/tls.key"
kubectl -n agent-ledger create configmap proxy-ca --from-file=ca.crt="$LAB_EVIDENCE/ca.crt"
```

Verify: `openssl verify -CAfile "$LAB_EVIDENCE/ca.crt" "$LAB_WORK/tls.crt"` prints `OK`;
`openssl x509 -in "$LAB_WORK/tls.crt" -noout -ext subjectAltName -dates` lists both DNS names, 127.0.0.1 and every node IP,
with ≤ 825 days validity (P-256, TLS ≥ 1.2 enforced by the proxy); `kubectl -n agent-ledger get secrets slack-tokens
proxy-tls` (type `kubernetes.io/tls`) and `get configmap proxy-ca` exist; do not dump Secret data.
Rotating a token: recreate `slack-tokens`, then `kubectl -n agent-ledger rollout restart deployment/proxy`.
Undo: `kubectl -n agent-ledger delete secret slack-tokens proxy-tls`, `kubectl -n agent-ledger delete configmap proxy-ca`;
revert the `approvals.yaml` edit with `git checkout deploy/k8s/config/approvals.yaml`; keep or `rm` the CA files deliberately
(a deleted CA key means a new CA and a new `NODE_EXTRA_CA_CERTS` file).

## 6. Review registry and publish configuration

Changes: ConfigMaps `proxy-registry` and `postgres-init`; five ServiceAccounts with token automount disabled.
**2b:** `proxy-registry` now also carries `approvals.yaml` (step 5b) and `upstreams.yaml` gains `everything` (no bearer).
Review the **seven `everything` rows** (pin 7): `echo` read [message], `get-sum` read [a, b], `get-tiny-image`,
`get-annotated-message`, `get-structured-content` read; **`get-env` risky** (returns the process environment: the Slack
demo tool) and **`gzip-file-as-resource` risky** (fetches a URL; its egress is denied too), both `storeArgs: []`. Every
other `everything` tool stays unlisted → unreviewed → Slack. After step 9b, compare the `storeArgs` names with the live
`tools/list` input schemas (`everything__echo`, `everything__get-sum`); a wrong name only hashes a field (fails safe).
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
Undo: `kubectl -n agent-ledger delete configmap proxy-registry postgres-init`, then delete the five ServiceAccounts (including `everything`)
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
kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-projected-token.yaml
kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-label.yaml
kubectl -n agent-ledger patch pod postgres-0 --subresource=ephemeralcontainers --type=strategic --dry-run=server -p "$(cat deploy/k8s/test/bad-ephemeral-container.json)"
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
containers, pins Agent Ledger, Postgres and BusyBox digests (2b), forbids projected ServiceAccount token volumes (2b: the
negative Pod sets automount false and requests the token explicitly; expect "Projected ServiceAccount token volumes are
forbidden."), refuses NODE_OPTIONS (including bulk envFrom imports), and requires explicit token/rootfs settings.
Server audit P3 (2026-10-05): NetworkPolicies grant reach by the `app` label, so a Pod carrying `app: proxy|postgres|
demo-upstream|integration|everything` must run as the ServiceAccount of that name, and `app: proxy` only as the proxy
itself (agent-ledger image, args `dist/server/main.js`, no command, BusyBox init only, no ephemeral containers). Expect
"A Pod with an Agent Ledger app label must run as the ServiceAccount of the same name." for `bad-pod-label.yaml`, and
"Only approved Agent Ledger, Postgres 17 and BusyBox 1 images are allowed." for the ephemeral-container patch (run the
patch only once postgres-0 exists; it is a dry run). Residual: anyone allowed to create Pods here may name those
ServiceAccounts; Pod-create in this namespace is the real boundary.
Undo: `kubectl delete validatingpolicy agent-ledger-hardening`. Negative tests are not resources to delete.

## 7b. Kyverno reports RBAC for `pods/ephemeralcontainers` (Slice 2b pin 9)

Changes: one cluster-scoped ClusterRole, `agent-ledger:kyverno-reports-ephemeralcontainers`, labelled
`rbac.kyverno.io/aggregate-to-reports-controller: "true"` so Kubernetes aggregates it into `kyverno:reports-controller`;
it grants `get, list, watch` on `pods/ephemeralcontainers` and nothing else. Why: our policy matches that subresource
and the reports controller could not read it (`can-i` → `no` ×3, read-only, 2026-10-04), so it logged RBAC errors.
It is outside the namespace kustomization on purpose.

```sh
kubectl apply -f deploy/k8s/cluster/kyverno-reports-ephemeralcontainers.yaml
```

Verify: each of these prints `yes`:

```sh
kubectl auth can-i get pods --subresource=ephemeralcontainers --as=system:serviceaccount:kyverno:kyverno-reports-controller
kubectl auth can-i list pods --subresource=ephemeralcontainers --as=system:serviceaccount:kyverno:kyverno-reports-controller
kubectl auth can-i watch pods --subresource=ephemeralcontainers --as=system:serviceaccount:kyverno:kyverno-reports-controller
kubectl -n kyverno logs deploy/kyverno-reports-controller --since=10m | grep -i ephemeralcontainers
```

and the last command prints no new RBAC (`forbidden`) line after the apply.
Undo: `kubectl delete clusterrole agent-ledger:kyverno-reports-ephemeralcontainers`.

## 8. Postgres, storage, and network boundaries

Changes: all eight NetworkPolicies, Postgres Service and StatefulSet with a 2Gi local-path PVC.
**2b:** `20-proxy-egress` adds `everything:3001` and **TCP 443 to any public IPv4** (`0.0.0.0/0` except 10/8, 172.16/12,
192.168/16, and since the server audit P3 also 100.64/10 carrier-grade NAT and 169.254/16 link-local) for the Slack Web API and Socket Mode: standard NetworkPolicy cannot name `slack.com` (FQDN egress via
CiliumNetworkPolicy is 2c). `25-everything` allows ingress only from the proxy on 3001 and NO egress (not even DNS).
Postgres/demo have no outbound allowance; DNS is allowed only for proxy/integration. Replies to allowed inbound
connections remain allowed. Pod selectors are namespace-local; attacker labels in another namespace grant no access.
The LAN range `10.20.0.0/24` also includes the nodes' own IPs (`10.20.0.10`–`10.20.0.12`); it is not a Mac-only allowlist.
Do not claim node/host-network isolation from this rule: Cilium's treatment of node traffic must be observed separately.

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
Server audit P3 (2026-10-05): `001_init.sh` prepends `host all postgres all reject` to `pg_hba.conf` at initdb, so the
superuser cannot log in over TCP at all (the app and reader roles are unaffected). It runs only on a fresh data
directory. **Existing PVC (Ryan, once):** `kubectl -n agent-ledger exec postgres-0 -- sh -c "sed -i '1i host all postgres all reject' \"\$PGDATA/pg_hba.conf\" && psql -U postgres -c 'SELECT pg_reload_conf()'"`;
verify with `kubectl -n agent-ledger exec postgres-0 -- psql -U postgres -c "SELECT line_number, type, user_name, auth_method FROM pg_hba_file_rules LIMIT 3"` (line 1 is the reject).
The official image's local trust authentication makes exec on postgres-0 a **password-less database-superuser path**:
anyone permitted to exec can run `psql -U postgres`. This is the cluster-admin boundary, not a ledger protection.
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
**2b:** run step **9b** (the `everything` upstream) between these two commands. The proxy is `replicas: 1` with
`strategy: Recreate` (never two Socket Mode routers on one Slack app), starts with `AGENT_LEDGER_APPROVALS=slack` and
`AGENT_LEDGER_TLS=on`, retries upstreams and then the Slack probe (each up to 60 s) before it listens, and its probes are
HTTPS (`startupProbe` allows 160 s).

```sh
kubectl -n agent-ledger apply -k deploy/k8s -l app=demo-upstream
kubectl -n agent-ledger apply -k deploy/k8s -l app=proxy
```

**2b start lines to require** in `kubectl -n agent-ledger logs deployment/proxy`: `ledger`, `upstreams` with
`"eras":{"demo":"modern","everything":"legacy"}`, `approvals` with `"kind":"slack"`, the approver COUNT and your `teamId`
(no token, no member id), and `listening` with `"approvals":"slack","tls":"on"`. `upstreams-retry` / `approvals-retry`
lines during start are normal while a dependency comes up; a `refused` line names the failed file or step, never a value.

Verify: `kubectl -n agent-ledger get deployments,pods,services -o wide`, then
`kubectl -n agent-ledger logs deployment/demo-upstream` and `kubectl -n agent-ledger logs deployment/proxy`.
Require both Ready; proxy startup should confirm ledger connectivity/head without a URL/password/stack.
If startup reports a config file's ownership/mode error, inspect `kubectl -n agent-ledger logs deployment/proxy -c stage-config`
and the Pod's init status; staging must create files owned by 65532, mode 0600. Do not print file contents.

Start the tunnel in a separate terminal (Ryan action; stop with Ctrl-C):

```sh
kubectl -n agent-ledger port-forward svc/proxy 8787:8787
curl --fail --cacert "$LAB_EVIDENCE/ca.crt" https://127.0.0.1:8787/healthz
curl --max-time 3 http://127.0.0.1:8787/healthz; echo "exit=$?"
```

Expect `{"ok":true}` from the HTTPS call and a failure (no HTTP answer) from the plain-HTTP one. PSA may accept a Deployment but reject its Pods: inspect Pods, not just apply's exit status.
Undo: delete each Deployment and Service (`kubectl -n agent-ledger delete deployment,service proxy demo-upstream`).

### 9b. The `everything` upstream (Slice 2b pins 7, 9, 10; apply BEFORE the proxy line above)

Changes: ServiceAccount `everything` (from step 6), Deployment `everything` (1 replica, PSA restricted, read-only root,
uid 65532, `enableServiceLinks: false`, env `PORT=3001` only, no Secret, no volume) and Service `everything:3001`.

```sh
kubectl -n agent-ledger apply -k deploy/k8s -l app=everything
```

Verify: `kubectl -n agent-ledger get deploy,pods,svc -l app=everything` Ready; `kubectl -n agent-ledger logs deploy/everything`
shows `MCP Streamable HTTP Server listening on port 3001`. A CrashLoopBackOff mentioning a read-only filesystem means the
server writes somewhere [H: express writes nothing]: the fix is an `emptyDir` on `/tmp`, never a writable root (stop and
report). After the proxy is up, its `upstreams` line shows `everything: legacy`. Isolation, from an EXISTING lab pod in
another namespace (do not create an unpinned image here): `kubectl -n attacker exec netshoot -- curl --max-time 3
http://everything.agent-ledger.svc.cluster.local:3001/mcp` must time out (exit 28; confirm the drop in Hubble).
Undo: `kubectl -n agent-ledger delete deployment,service everything`.

## 10. Falco rules

Changes: Falco Helm release values add two custom rules. Preserve existing settings; do not patch its DaemonSet.
Save the current revision/values before upgrading:

```sh
helm -n falco history falco
helm -n falco get values falco > "$LAB_WORK/falco-before.yaml"
helm upgrade falco falcosecurity/falco --namespace falco --version 9.1.0 --reuse-values -f deploy/falco/values.yaml
```

Verify: `kubectl -n falco get pods` and the logs from **all** Falco pods show the rules loaded without errors.
Do not count an empty log or absence of alerts as proof of detection. The repository filters use `endswith` so both
`ghcr.io/ryan-zeleznock/agent-ledger` and `ryan-zeleznock/agent-ledger` match; the BusyBox exclusion likewise accepts
`docker.io/library/busybox` and `library/busybox`. The [Falco field reference](https://falco.org/docs/reference/rules/supported-fields/)
documents the unprefixed repository form, and [condition syntax](https://falco.org/docs/concepts/rules/conditions/)
defines suffix matching (checked 2026-10-03). Runtime field population still needs the controls below.

Step 9's init shells ran **before** these custom rules were installed. Once Falco is ready on the nodes hosting
postgres/proxy/demo, Ryan reruns staging with fresh Deployment rollouts (briefly interrupts the lab proxy):

```sh
kubectl -n falco logs ds/falco --all-pods=true --prefix=true --since=10m --tail=-1
export FALCO_PROOF_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kubectl -n agent-ledger rollout restart deployment/demo-upstream
kubectl -n agent-ledger rollout restart deployment/proxy
kubectl -n agent-ledger rollout status deployment/demo-upstream --timeout=120s
kubectl -n agent-ledger rollout status deployment/proxy --timeout=120s
kubectl -n agent-ledger get pods -l 'app in (proxy,demo-upstream)' -o wide
kubectl -n agent-ledger get pods -l 'app in (proxy,demo-upstream)' -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.initContainerStatuses}{"\n"}{end}'
```

Require a newly created ready Pod for **each** Deployment, with `stage-config` terminated successfully (exit 0)
after `FALCO_PROOF_SINCE`; record their Pod names and nodes. Ignore terminating old Pods. Confirm Falco is running
on both of those nodes; an unobserved node cannot provide a negative control.
Then run the Ryan-only **positive control** (builders do not execute this):

```sh
kubectl -n agent-ledger exec postgres-0 -- sh -c id
kubectl -n falco logs ds/falco --all-pods=true --prefix=true --since-time="$FALCO_PROOF_SINCE" --tail=-1 > "$LAB_WORK/falco-proof.log"
```

Inspect the complete capture, allowing time for event delivery and rereading logs if necessary. **Both** conditions
are required: the deliberate postgres-0 shell produces this rule's alert, and neither fresh `stage-config` BusyBox
shell produces one. In text logs the rule's output starts `Agent Ledger shell (namespace=agent-ledger pod=...)`;
in JSON logs require `rule: Shell in agent-ledger namespace` and the corresponding Pod field. The postgres alert
must match the exec's timestamp and `sh -c id` command, so an earlier entrypoint shell does not satisfy the control.
No positive alert, any staging-shell alert, missing node coverage or rule-load errors means **FAIL**, never a pass
based on silence. Save the log and fresh Pod names with the evidence. Undo the proof restarts by completing their
rollouts; they change no image/configuration. If a rollout fails, diagnose it before continuing.

The distroless proxy has no shell. Absence of its process-rule alerts is normal operation, **not** a positive test
of that separate rule. Initial postgres entrypoint shells can also legitimately trigger the namespace shell rule.
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
**2b:** the Job runs `smoke.js --url https://proxy.agent-ledger.svc:8787/mcp --approvals slack --ca-file /mnt/ca/ca.crt
--expect-legacy everything` (CA from the `proxy-ca` ConfigMap). Require the two lines `SKIP (slack: needs a human)
demo__wipe …` and `… demo__whoami …` (nothing is posted to Slack by the Job) and `ok everything__echo ok (legacy-era
upstream through the proxy)`.
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
const c=spec.containers[0]; delete c.env; delete c.volumeMounts; delete c.readinessProbe; delete c.livenessProbe; delete c.startupProbe;
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
export NODE_EXTRA_CA_CERTS="$LAB_EVIDENCE/ca.crt"
MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude mcp add --scope local --transport http agent-ledger https://10.20.0.11:30787/mcp --header 'Authorization: Bearer ${AGENT_LEDGER_KEY}'
MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude --debug
```

**2b:** the URL is `https://`; Claude Code trusts the lab CA through `NODE_EXTRA_CA_CERTS`
(https://code.claude.com/docs/en/network-config, read 2026-10-04). The debug log must contain
`CA certs: Appended extra certificates from NODE_EXTRA_CA_CERTS`; that it covers HTTP MCP connections (not only API
requests) is [H] until `/mcp` connects here.

The single quotes retain `${AGENT_LEDGER_KEY}` as a reference, so the secret is not in argv or saved configuration.
Header expansion through the local-scope CLI flag is a hypothesis to verify here. Keep that environment variable
set for the sandbox Claude process. If `/mcp` reports 401 despite the correct exported key, exit Claude, remove the
local-scope entry (it would override project scope), and use the documented project-scope `.mcp.json` fallback in
this **fresh sandbox directory only**. The quoted heredoc keeps the key reference literal:

```sh
claude mcp remove --scope local agent-ledger
cat > .mcp.json <<'JSON'
{
  "mcpServers": {
    "agent-ledger": {
      "type": "http",
      "url": "https://10.20.0.11:30787/mcp",
      "timeout": 600000,
      "headers": {"Authorization": "Bearer ${AGENT_LEDGER_KEY}"}
    }
  }
}
JSON
MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto claude
```

Set the URL to the actual endpoint chosen above (or the port-forward URL below), then accept the project's MCP
configuration prompt. This creates only the sandbox's `.mcp.json`; do not overwrite an existing project's file.
[Claude Code documents header expansion in `.mcp.json`](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson)
(checked 2026-10-03). If it still returns 401, stop and diagnose the key/identity mapping; do not embed the raw key.
Verify `/mcp` shows the five `demo__*` tools plus the `everything__*` tools. Ask Claude to echo hello and add 2+3 (both
succeed). **2b:** `demo__wipe` and `demo__whoami` now go to Slack (step 12b) instead of `denied: no channel`.

For flow evidence, Ryan starts `kubectl -n kube-system port-forward svc/hubble-relay 4245:80` in another terminal,
then `hubble observe --server localhost:4245 --namespace agent-ledger --since 5m`.
Require forwarded Mac→proxy traffic and proxy→demo/Postgres traffic. If NodePort/ipBlock matching fails, record the
Hubble verdict and use `kubectl -n agent-ledger port-forward svc/proxy 8787:8787`, replacing the sandbox MCP URL with
`https://127.0.0.1:8787/mcp` (the cert carries IP 127.0.0.1). This tests application behavior, not the NodePort policy claim.
If the v2 protocol probe fails, port-forward cannot fix an era mismatch: retain smoke evidence and report the need
for Slice 2b's dual-era front. Never silently call this a successful Claude integration.
Undo: exit Claude and, in the sandbox, remove the entry with `claude mcp remove --scope local agent-ledger` for the
original setup or `claude mcp remove --scope project agent-ledger` for the fallback. Remove the fallback's newly created
`.mcp.json` if now empty, `unset AGENT_LEDGER_KEY`, and stop tunnels.
Return to the integrated repo before the remaining steps.

## 12b. Live Slack approval from Claude Code (sandbox project only; the slice headline)

Changes: none beyond step 12's sandbox; Slack messages in `#agent-ledger-approvals`; ledger records.
Use the project-scope `.mcp.json` form from step 12 with `"timeout": 600000` (belt and braces: Claude Code aborts a tool
call that sends nothing for its idle window, 300 s by default for network servers per
https://code.claude.com/docs/en/env-vars, read 2026-10-04; the proxy caps `timeoutMs` at 240 s). Launch with
`NODE_EXTRA_CA_CERTS` set and `claude --debug` as in step 12, then:
1. Ask Claude to call `everything__get-env`. A message appears in the channel ("approval needed for everything/get-env
   (risky)", agent, rule, reason, call id, expiry, Approve/Deny). Click **Approve** (confirm dialog). The environment text
   (only `PORT`, Node defaults and the Pod's hostname: no Secret, no Service links) returns to Claude; the message is
   updated to "Approved by @you at …".
2. Again → **Deny** → Claude sees the denial; the message says "Denied by …".
3. Again → do nothing for 180 s → Claude gets the timeout denial; the message says "Expired after 180000 ms".
4. Again → approve at about 170 s (time it) to confirm the client does not abort first. If Claude aborts before the
   proxy answers, record it: the approval still settles and is recorded (residual below), and `MCP_TOOL_TIMEOUT` is [H].
5. Optional: a second Slack account NOT in `approvers` clicks → nothing settles and that user gets an ephemeral
   "only the configured approvers can decide"; the real approver's click then settles.

Verify: `kubectl -n agent-ledger logs deployment/proxy` has one call line per attempt (`verdict` `require_approval`,
`status` `ok` / `blocked`) and no token, nonce or member id; step 13's pack shows the rows. Do not reuse this Slack app
for anything else while the proxy runs. Undo: exit Claude; nothing to delete (the records are the evidence).

## 12c. Optional: Codex CLI through the legacy front (needs Ryan's explicit OK: it configures Codex)

Changes: a throwaway `CODEX_HOME` directory only; never `~/.codex`. Codex's MCP client is SDK-1.x, i.e. legacy-era [H];
this proves the dual-era front (ADR-016) with a real legacy client. Create `$LAB_WORK/codex-home`, point
`CODEX_HOME` at it for that one shell, add an HTTP MCP server entry for `https://<node-ip>:30787/mcp` with the bearer
from `AGENT_LEDGER_KEY` per the Codex MCP documentation current on the day (check it; do not guess the config keys), set
`NODE_EXTRA_CA_CERTS` as above, and ask Codex to call `everything__echo`. Verify: the call succeeds and the proxy log
shows it; a risky call goes to Slack like 12b. Undo: `unset CODEX_HOME` and delete `$LAB_WORK/codex-home`.

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
anchoring). **2b:** the pack's CC8.1 table shows `approved, U…` with `executed after ask` (12b.1), `denied: Slack denied`
(12b.2) and `denied: Slack timeout` (12b.3) rows with `channel: slack` and your member id as the approver; 2a's
`denied: no channel` rows remain for records made before the switch. Keep `anchors.jsonl` and the Job anchor on the Mac; a complete deleted database suffix
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
kubectl -n agent-ledger delete deployment proxy demo-upstream everything
kubectl -n agent-ledger delete service proxy demo-upstream everything
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
kubectl -n build delete job kaniko-agent-ledger-everything --ignore-not-found
kubectl -n build delete configmap agent-ledger-everything-context --ignore-not-found
kubectl delete clusterrole agent-ledger:kyverno-reports-ephemeralcontainers --ignore-not-found
```

2b: delete the Slack app (step 3b undo) to revoke both tokens; namespace deletion removes `slack-tokens`, `proxy-tls`
and `proxy-ca`. Keep or remove the lab CA key deliberately.

Namespace deletion also removes its Secrets, ConfigMaps, ServiceAccounts and NetworkPolicies. If keeping the PVC,
do not delete the namespace. The Mac anchor and pack survive teardown. Remove the provisioner using step 1's undo
only if this slice was its sole user. Verify namespace/Job/PVC absence with read-only `kubectl get` commands.
Undo: repeat installation with retained secrets and surviving storage; a deleted PVC needs a real backup to recover
records. Anchors prove history but are **not** database backups. Rebuilding empty storage is a new ledger.

## Security round (ADR-018, 2026-10-05): what changed for the operator

- **The front authenticates first.** Every request is resolved through the agent registry's hash lookup before the body
  is read and before any method answers (tools/list, discover, legacy initialize, tools/call, DELETE); an unknown key is
  `401` with nothing echoed. Caps: 256 connections, 10 s for headers and for an authenticated body (`408`), 16 requests
  in flight per agent, 64 tool calls overall. Legacy sessions are capped per agent; at global capacity a new
  initialize is `503`, never an eviction. `tools/list` is not filtered per agent (residual; never before auth).
- **Spec §9 note (the frozen spec is not edited):** `docs/spec.md` §9 line "incoming `Mcp-Session-Id` ignored (§3)"
  predates ADR-016. Since Slice 2b a headerless legacy `initialize` opens a bearer-bound session (`Mcp-Session-Id`);
  modern requests still ignore and never echo it. ADR-018 adds: sessions only for authenticated agents.
- **Slack approvals:** the card lists every argument field: clear (reviewed `storeArgs`) values in full or with a
  stated truncation, withheld (hashed or redacted) fields marked, plus `sha256` of the stored arguments (JCS) to tie it
  to the ledger record. A preview that cannot fit Slack's limits is denied and recorded, never posted. At most 4
  pending approvals per agent; an identical pending request is refused, not posted twice.
- **Upstreams:** a bearer is never sent over plaintext `http://` to a non-loopback host unless the upstream entry sets
  `insecure: true` (the in-cluster `demo` entry does, with the reason beside it).
- **Start-up:** `AGENT_LEDGER_TLS=off` with a non-loopback bind is refused; `off-non-loopback` is the explicit override
  (Compose, published on 127.0.0.1 only). The `listening` log line carries `configSha256` of registry, agents,
  upstreams (and approvals) files, so an edited ConfigMap shows up in the pod log.
- **Images:** the root Dockerfile bases and the Kaniko executor are digest-pinned; `node deploy/check.mjs` refuses any
  unpinned `FROM` in any Dockerfile and any unpinned image in a Kaniko Job.
- **Falco:** the proxy rule exempts only `/nodejs/bin/node` as the entrypoint (node spawned by node alerts, except in the
  integration Job, which runs smoke.js as a child); the shell rule counts `busybox` itself (`busybox sh`) and exempts
  BusyBox only in the `stage-config` init container. Re-apply with step 10's Helm upgrade to take effect.
- **Residual: a crash or SIGKILL while an approval is pending leaves no ledger record and live Slack buttons** (a
  graceful stop settles them `unavailable` and records the deny). A click after a restart settles nothing: the new
  process holds no pending entry, so the button is dead and the call never ran. Recording an "approval requested"
  marker before asking belongs to the pipeline (Astra's module; 2c candidate). Smoke's `--expect-upstream-401` now
  checks exactly three things: no bearer, the agent's key on tools/call, and the agent's key on tools/list.

## Residuals and evidence limits

**2b:** TLS uses a lab CA, not a public one (trusted via `NODE_EXTRA_CA_CERTS`; cert-manager/public CA is 2c); the
`everything` upstream has no auth of its own (NetworkPolicy `25-everything` is its boundary); Slack egress is any public
IPv4 on 443 (FQDN policy is 2c); ONE proxy replica per Slack app (a second Socket Mode consumer eats clicks); approvers
are Slack member ids (display names are best-effort `users.info` snapshots; missing scope, timeout or lookup failure
leaves the name absent without changing the decision); a client that gives up while an approval is pending does not cancel it: an approval that arrives later still executes and is recorded (the pipeline has no abort input; 2c);
decide-only (Codex hook) Slack is 2c (ADR-015). 2a residuals below still apply except where 2b closed them (TLS,
legacy-era upstreams, Slack approvals, BusyBox/Postgres digests). One Postgres replica on one node's disk; the Kaniko project is archived;
no approval channel means risky calls are denied, not approved.

**SERVER MODE** is **the enforcement boundary**: the proxy holds the upstream credentials, the agent has none, and every
tool call has to pass through the proxy to happen at all. Only server-mode records support the claim "no risky action ran
without a recorded approval".

That claim applies to the governed tools (the `demo` and `everything` upstreams) and the credential/network boundary
proved above. With Slice 2b a risky call runs ONLY after an allowlisted Slack approver clicks Approve, and the intent
record names that approver (`approved, Ryan Zeleznock (U…)`, or `approved, U…` if lookup fails); a deny, a timeout,
Slack being unreachable or a proxy shutdown are recorded denials (step 12b, step 13). The demo's risky actions are harmless (`demo__wipe` wipes nothing; `get-env`
runs in a Pod whose environment holds nothing secret). It does not turn local hooks into enforcement or defend against
cluster/DB admins. The local test database is 16; the cluster Job closes the 17.11/runtime gap.

Images: the Agent Ledger proxy image and the `everything` image are digest-pinned by Ryan's builds (steps 4, 4b);
BusyBox, Postgres and the `everything` build/runtime bases are pinned by index digest (resolved 2026-10-04,
`deploy/README.md`); the proxy's own Dockerfile bases are still version tags. No digest or successful cluster proof is
invented by this runbook.

Still open after 2b (2c): decide-only (Codex hook) Slack approvals; FQDN-scoped Slack egress and Cilium L7 policies;
cert-manager or a public CA; cancelling a pending approval when the client gives up; stdio
front and upstream; versioned migrations; database password files and scram local auth; a separate integration key;
a maintained image builder replacing archived Kaniko.
