# Slice 2a: server mode in the home-lab cluster. Work split and interface pins (architect, 2026-10-03)

Goal (Ryan, 2026-10-03): the smallest server mode that really runs end to end in the kubeadm lab: a Claude Code client on
the lab network → the Agent Ledger MCP proxy (Streamable HTTP, 2026-07-28) → policy → Postgres ledger → one real, harmless
upstream MCP server that only the proxy can reach → `anchor`/`verify`/`report` against Postgres from the Mac. The
deployment is hardened on purpose (Ryan is studying for CKS): PSA `restricted`, default-deny NetworkPolicies, a Kyverno
policy, a Falco rule, no ServiceAccount tokens, distroless image, digest pins. Master `97c1078` (tag `slice-1c`). Format
follows `slice-1c-pins.md`.

Both builders code against these pins. Neither edits the other's folders. If a pin is wrong, STOP and say so in your final
report; do not silently diverge. Items marked **ADR-012** / **ADR-013** change a frozen contract or the spec's component
table and are implemented only after Ryan accepts the ADR (`~/Desktop/AgentLedger/decisions/`). Everything else is
buildable now. Nothing in this slice touches `~/.claude`, `~/.codex`, a real project, or the cluster: every
cluster-changing command is a numbered step in `docs/HOMELAB.md` that Ryan runs himself.

## 0. Due-diligence findings this slice is designed around

All read on **2026-10-03** from the primary sources named. Quotes are verbatim. [V] verified, [H] hypothesis.

**MCP 2026-07-28** (https://modelcontextprotocol.io/specification/2026-07-28/, pages `changelog`, `basic/index`,
`basic/versioning`, `basic/transports/streamable-http`, `basic/authorization`, `server/discover`, `server/tools`)
- [V] Stateless: "Remove protocol-level sessions and the `Mcp-Session-Id` header"; "remove the `initialize`/
  `notifications/initialized` handshake. Every request now carries its protocol version and client capabilities in
  `_meta`". Required on EVERY request: `_meta["io.modelcontextprotocol/protocolVersion"]` and
  `_meta["io.modelcontextprotocol/clientCapabilities"]`; a request missing one "is malformed; the server **MUST** reject
  it with JSON-RPC error code `-32602` … On HTTP, the response status **MUST** be `400 Bad Request`."
- [V] "Servers **MUST** implement `server/discover`." Result: `{ resultType: "complete", supportedVersions: [...],
  capabilities: {...}, _meta: { "io.modelcontextprotocol/serverInfo": {...} }, instructions?, ttlMs, cacheScope }`.
- [V] Every result carries `resultType` (`"complete"`); `tools/list` results carry `ttlMs` and `cacheScope`
  (`"public" | "private"`) and "**SHOULD** return tools in a deterministic order".
- [V] HTTP: single endpoint, POST only; "Servers **MUST** validate the `Origin` header … If the `Origin` header is present
  and invalid, servers **MUST** respond with HTTP 403 Forbidden"; "Every POST request to the MCP endpoint **MUST** include
  an `MCP-Protocol-Version` header"; `Mcp-Method` on all requests and `Mcp-Name` on `tools/call` "are **REQUIRED** for
  compliance"; header/body mismatch or a missing required header → `400` + JSON-RPC `-32020` (`HeaderMismatch`);
  unsupported version → `400` + `-32022` (`UnsupportedProtocolVersion`) "listing its supported versions"; unknown method
  → `404` + `-32601`; a JSON-RPC notification → `202 Accepted`; the server may answer `application/json` or an SSE stream
  ("The client **MUST** support both"); GET/DELETE from an older client → `405`; an incoming `Mcp-Session-Id` → "ignore
  it, and do not mint or echo session IDs". Clients MUST send `Accept: application/json, text/event-stream`.
- [V] Era detection (versioning page, compatibility matrix): **Modern client → Legacy server: Fails.** **Legacy client →
  Modern server: Fails.** A dual-era client "attempt[s] a modern request first. On `400 Bad Request`, the client SHOULD
  inspect the response body before falling back". A modern-only server "**SHOULD** name the protocol versions it supports
  in any error it returns to an `initialize` request".
- [V] Authorization: "Authorization is **OPTIONAL** for MCP implementations"; "clients and servers **MAY** negotiate their
  own custom authentication and authorization strategies" (basic/index). When OAuth is used, servers MUST implement RFC
  9728 metadata and answer `401` with `WWW-Authenticate`; tokens travel as `Authorization: Bearer <token>` on every
  request and "**MUST NOT** be included in the URI query string". "MCP servers **MUST NOT** accept or transit any other
  tokens." → the proxy never forwards the agent's key upstream (it holds its own upstream credential; spec §9).
- [V] Tool names "**SHOULD** be between 1 and 128 characters", `[A-Za-z0-9_.-]`; "Clients or proxies that aggregate
  tools from multiple servers … **SHOULD** implement a disambiguation strategy such as prefixing tool names with a
  server identifier."

**MCP ecosystem reality (npm registry, 2026-10-03)**
- [V] `@modelcontextprotocol/sdk` dist-tag `latest` = **1.32.0**; no 2.x version is published. The reference
  `@modelcontextprotocol/server-everything` 2.0.0 depends on `@modelcontextprotocol/sdk ^1.30.0`; its Docker image
  `mcp/everything` has only a `latest` tag (2025-05-02), which the cluster's Kyverno `disallow-latest-tag` policy forbids.
  **Consequence:** every third-party MCP server available today is a *legacy-era* (initialize-handshake) server. A
  2026-07-28-only client cannot talk to it (matrix above). So in 2a the upstream is OUR OWN 2026-07-28 demo server (pin 6),
  and a dual-era upstream client (legacy fallback) is Slice 2b work, stated in ADR-013.
- [V] Claude Code MCP docs (https://code.claude.com/docs/en/mcp): "Claude Code uses the v2 runtime by default on Claude
  Code v2.1.274 or later" (sessions without feature-flag fetching; v2.1.232+ with). The Mac runs **2.1.288**. The v2
  runtime "Asks HTTP servers whether they support the newer revision, and uses it with those that do"; "A server that
  doesn't support that revision connects on the earlier handshake". `MCP_SDK_GENERATION=v1|v2`,
  `MCP_PROTOCOL_NEGOTIATION=auto|legacy`. Remote servers: `claude mcp add --transport http <name> <url> --header
  "Authorization: Bearer ..."`; `${VAR}` expands in headers (credential-named variables such as `ANTHROPIC_API_KEY` read as
  empty, so the key goes in a variable of our own name); "a `401` or `403` while connecting doesn't flag the server …
  Claude Code reports the connection as failed instead". Server names: `[A-Za-z0-9_-]`. [H] The v2 probe is the
  spec's "modern request first" and therefore succeeds against a modern-only server; HOMELAB.md step 12 verifies it and
  pins `MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto` explicitly. Fallback if it fails: a dual-era front (2b, ADR-013).
- [H] The Anthropic Messages API tool-name pattern is `[A-Za-z0-9_-]{1,128}` (no `.`), and Claude Code exposes MCP tools
  as `mcp__<server>__<tool>`; so the proxy's exposed tool names use `__`, not `.` (pin 5), and the mapping back to
  `(server, tool)` is a table lookup, never a string split (the ADR-006 `__` ambiguity lesson).

**Kubernetes** (https://kubernetes.io/docs/concepts/security/pod-security-standards/,
`pod-security-admission/`, `concepts/configuration/secret/`, `reference/networking/virtual-ips/`,
`concepts/services-networking/network-policies/`)
- [V] Restricted profile (page re-read raw with curl, 2026-10-03): "Every item in the `spec.volumes[*]` list must set
  one of the following fields to a non-null value: `configMap`, `csi`, `downwardAPI`, `emptyDir`, `ephemeral`,
  `persistentVolumeClaim`, `projected`, `secret`" (so the StatefulSet's PVC is fine under `enforce: restricted`);
  `allowPrivilegeEscalation: false` explicit; `runAsNonRoot: true`; `runAsUser` non-zero; `seccompProfile.type:
  RuntimeDefault|Localhost`; `capabilities.drop: ["ALL"]`, add at most `NET_BIND_SERVICE`; Baseline inherited: no
  hostPath, no host namespaces, no privileged, `hostPorts` unset.
- [V] PSA labels `pod-security.kubernetes.io/<enforce|audit|warn>: restricted` (+ `-version`); "enforce mode is **not**
  applied to workload resources, only to the resulting pod objects" (Deployments are created, their Pods are rejected: so
  step 9 checks `kubectl get pods`, not the apply exit code).
- [V] Secret volume files are owned by root (group = `fsGroup`), default mode `0644`, tmpfs-backed, and cannot be chowned
  to the container user. Our `readConfigFile` (`src/config-file.ts`) refuses a file not owned by `getuid()` → pin 8's
  staging initContainer copies the files into a `Memory` emptyDir as the app's uid with mode `0600`. No code change.
- [V] `externalTrafficPolicy: Local` preserves the client source IP (no SNAT) and only nodes with an endpoint answer;
  `Cluster` SNATs. NodePort range 30000-32767; used in the cluster today: 30080, 32553.
- [V] NetworkPolicy default-deny = `podSelector: {}` + `policyTypes: [Ingress, Egress]`; egress isolation needs an explicit
  kube-dns allow; policies are additive; "Creating a NetworkPolicy resource without a controller that implements it will
  have no effect."

**Cilium 1.20.1** (cluster: `cilium-config` `enable-policy=default`, `enable-l7-proxy=true`, Hubble relay+UI present;
https://docs.cilium.io/en/v1.20/network/kubernetes/policy/): [V] standard `networking.k8s.io/v1` NetworkPolicy "supports
L3 and L4 policies at ingress or egress of the Pod"; [V] "By default, `ipBlock` rules in NetworkPolicy do not match
intra-cluster IPs (such as Pod or Node IPs)"; running CNP and NetworkPolicy together "may lead to unintended policy allow
behavior". **Decision:** 2a uses standard NetworkPolicy only (what CKS tests; one policy model, no mixing);
CiliumNetworkPolicy/L7/FQDN rules are 2b. [H] A NodePort connection from the Mac (10.20.0.x, not a node IP) with
`externalTrafficPolicy: Local` matches `ipBlock 10.20.0.0/24`; step 12 verifies with Hubble (`hubble observe` via
`kubectl -n kube-system port-forward svc/hubble-relay`), and `kubectl port-forward svc/proxy` is the documented fallback.
(The CNP language page was not fetchable today: every `docs.cilium.io/.../policy/language/` URL redirected; recorded, not needed.)

**Kyverno v1.19.1** (cluster; https://kyverno.io/docs/policy-types/validating-policy/): [V] the cluster's two
`kyverno.io/v1 ClusterPolicy` objects are `disallow-latest-tag` (Enforce, all namespaces, `image: '!*:latest'`) and
`add-security-context` (mutate, namespace `demo` only: does not touch us); `kubectl` prints "kyverno.io/v1 ClusterPolicy
is deprecated … migrate to ValidatingPolicy, MutatingPolicy, GeneratingPolicy or ImageValidatingPolicy
(policies.kyverno.io)". [V] `policies.kyverno.io/v1 ValidatingPolicy` (cluster-scoped; stable in 1.19): `spec.
validationActions: [Deny]`, `matchConstraints.resourceRules[]` (apiGroups/apiVersions/operations/resources),
`validations[].expression` (CEL) + `message`. → pin 10 writes a ValidatingPolicy, not a ClusterPolicy.

**Falco 0.44.1, Helm chart `falco-9.1.0`** (cluster; `helm -n falco get values falco` = `driver.kind: modern_ebpf`,
`tty: true`; https://raw.githubusercontent.com/falcosecurity/charts/falco-9.1.0/charts/falco/values.yaml;
https://falco.org/docs/concepts/rules/basic-elements/): [V] `rules_files` = `falco_rules.yaml`, `falco_rules.local.yaml`,
`/etc/falco/rules.d`; chart value `customRules: { <file>.yaml: |- ... }` mounts under `/etc/falco/rules.d`; rule elements
`rule, desc, condition, output, priority, tags`; macros `spawned_process`, `container`; fields `container.image.repository`,
`k8s.ns.name`, `k8s.pod.name`, `proc.name`, `proc.cmdline`. The container plugin 0.7.1 is installed (provides `k8s.*`).
→ pin 10: a Helm `--reuse-values -f` upgrade, never a DaemonSet patch.

**Storage** (https://github.com/rancher/local-path-provisioner, manifest `v0.0.37/deploy/local-path-storage.yaml`): [V]
cluster has NO StorageClass. The manifest creates Namespace `local-path-storage`, ServiceAccount, Role, ClusterRole,
RoleBinding, ClusterRoleBinding, Deployment (`v0.0.37`, not privileged), ConfigMap (`/opt/local-path-provisioner`),
StorageClass `local-path` (provisioner `rancher.io/local-path`, `WaitForFirstConsumer`, reclaim `Delete`); the helper pod
creates the directory with `mkdir -m 0777`; ReadWriteOnce only. Honest consequence: the ledger lives on ONE worker's disk
and dies with the PVC; the Mac-side anchor (pin 7) is the off-machine copy.

**Postgres** (https://hub.docker.com/_/postgres; tags API): [V] newest 17 = **17.11**, alpine tag `17.11-alpine3.24`
(2026-09-21). 18 moved PGDATA to `/var/lib/postgresql/18/docker`; 17 persists at `/var/lib/postgresql/data`.
`POSTGRES_PASSWORD` is mandatory; `/docker-entrypoint-initdb.d` scripts (`.sh`, `.sql`) run once on an empty data dir;
`initdb` "requires the user to exist in `/etc/passwd`" (uid 999 `postgres` exists in the image). [H] Under `runAsUser:
999` with a 0777 host directory, `initdb` cannot chmod the mount root, so `PGDATA` must be a SUBDIRECTORY
(`/var/lib/postgresql/data/pgdata`); the official docs recommend exactly this for non-root use. Step 8 verifies. The
existing `app/db` runs `postgres:16` as root on an `emptyDir` with PSA `enforce=baseline`: our StatefulSet is the hardened
contrast Ryan can show.

**Images and build** (https://raw.githubusercontent.com/GoogleContainerTools/kaniko/main/README.md;
https://gcr.io/v2/distroless/nodejs24-debian12/manifests/nonroot; Docker Hub tags; https://raw.githubusercontent.com/
nodejs/Release/main/schedule.json): [V] **Kaniko is archived (2025-06-03)**, code still available; the cluster's
`gcr.io/kaniko-project/executor:v1.23.2` built `homelab-api:v1` 12 days ago and is kept for 2a (replacing the builder
is 2b: BuildKit rootless or buildah). Contexts: `dir://`, `tar://[path to a .tar.gz in the kaniko container]`;
`--digest-file` "will receive the digest of a built image"; `--reproducible`; credentials at `/kaniko/.docker/config.json`
(the `build/ghcr-auth` dockerconfigjson secret). The repo has NO git remote, so the context is a tarball: `git archive`
of `src policies package.json package-lock.json tsconfig*.json .npmrc` is **142 KB gzipped**, under the 1 MiB ConfigMap
limit → `binaryData` ConfigMap, same pattern as the existing `build-context` ConfigMap. [V] `gcr.io/distroless/
nodejs24-debian12:nonroot` exists (OCI index, amd64 present); entrypoint is `node`, "expects users to supply a path to a
.js file in the CMD". [V] Node 24 "Krypton" is Active LTS until 2026-10-20, maintenance to 2028-04-30; 26 becomes LTS
2026-10-28. Builder image `node:24-alpine3.24` (2026-09-18). The Mac runs Node 25.8.2: anything Node-25-only breaks in
the image; the smoke Job (pin 12) is the catch. [V] GHCR packages are private here (`app` pulls with imagePullSecret
`ghcr-pull`): the new namespace needs its own pull secret (HOMELAB step 3).

**Testing Postgres without Docker** [V]: the Mac has Homebrew `postgresql@16` (`pg_ctl 16.13`, `initdb`, `psql` on PATH)
and no Docker. A throwaway cluster (`initdb` into a tmp dir, `pg_ctl start` on a unix socket only) gives a REAL Postgres
with roles, advisory locks and multiple connections, which is exactly what the chain and the append-only grants must be
tested against; PGlite (`@electric-sql/pglite` 0.5.8) is "a single exclusive connection", so it could not test either,
and would be a new dependency. Version skew 16 (Mac) vs 17.11 (cluster) is closed by the in-cluster integration Job
(pin 12). `pg` 8.23.1 (deps: pg-pool, pg-types, pg-protocol, pg-connection-string, pgpass, pg-cloudflare; no bundled
types → `@types/pg` dev) is the only new runtime dependency, flagged in ADR-013.

## Ownership (disjoint)

- **Package A, Fable (Claude Code), role brief `.claude/agents/backend-builder.md`** (branch `slice-2a-proxy`, worktree
  `~/agent-ledger-fable`): `src/front/**`, `src/upstream/**`, `src/secrets/**`, `src/server/**` (new: composition root,
  demo upstream, smoke client), `src/pipeline/**` (ONLY the ADR-012 `none` branch), `src/types/index.ts` (ONLY the
  ADR-012 lines in pin 1), `src/approvals/README.md` (one paragraph), `src/cli/**` (ONLY the `--ledger` option, pin 7),
  `test/front*.test.ts`, `test/upstream*.test.ts`, `test/secrets*.test.ts`, `test/server*.test.ts`,
  `test/pipeline*.test.ts`, `test/cli*.test.ts`, `test/types.test.ts`, `test/helpers/mcp-client.ts`,
  `test/helpers/e2e-server.ts`, `test/e2e-slice-2a.test.ts`, `test/todo/front.todo.md`, `test/todo/upstream.todo.md`,
  `test/todo/secrets.todo.md`, `test/todo/pipeline.todo.md`.
- **Package B, Astra (Codex), role briefs `ledger-engineer.md` (Postgres store, SQL), `test-engineer.md` (real-Postgres
  harness), and the deployment** (branch `slice-2a-deploy`, worktree `~/agent-ledger-astra`): `src/ledger/**`
  (`postgres.ts`, `chain.ts` extracted from `jsonl.ts`, `validate.ts` ONLY for pin 1's channel enum, README),
  `deploy/**` (k8s manifests, kustomization, SQL, kaniko, falco values), `Dockerfile`, `.dockerignore`,
  `docker-compose.yml`, `docs/HOMELAB.md`, `package.json` + `package-lock.json` (B is the ONLY one who touches them:
  adds `pg`, `@types/pg`; A adds no dependency), `test/ledger-postgres*.test.ts`, `test/ledger-chain-parity.test.ts`,
  `test/helpers/pg-cluster.ts`, `test/helpers/ledger-child.ts` (URL support), `test/timing/**`, `test/todo/ledger.todo.md`.
- **Nobody touches:** `docs/spec.md`, `src/hooks/**`, `src/policy/**`, `src/identity/**` (its `file` backend already
  authenticates `kind: api_key`), `src/anchor/**`, `src/report/**`, `policies/**`, `~/.claude`, `~/.codex`, the cluster.

## Pin 1: `src/types` and the validator (A writes types; B writes the validator line; **ADR-012**)

```ts
// ApprovalChannel gains the proxy's explicit "nobody can approve" choice. Spec §6 step 3 refuses hook-ask in proxy mode
// and the only other kind is slack, which is unimplemented (its validator stub makes EVERY call a deny): without this a
// server-mode pipeline cannot be constructed at all.
export type ApprovalChannel = | { kind: "slack"; ... } | { kind: "hook-ask" } | { kind: "none" };
export const APPROVAL_CHANNEL_KINDS = ["slack", "hook-ask", "none"] as const;     // the ONE enum the validator uses
export const PROXY_NO_CHANNEL_REASON = "agent-ledger: no approval channel is configured for this proxy; risky and unreviewed calls are denied until a Slack channel (ADR-006) is configured" as const;
```
`ApprovalResult.channel` is `ApprovalChannel["kind"]` and therefore already admits `"none"`. B changes
`src/ledger/validate.ts` line 200 from the literal `["slack", "hook-ask"]` to `APPROVAL_CHANNEL_KINDS` (lenient append AND
strict read; a record with `channel: "none"` must round-trip and verify). Nothing else in `src/types` changes.

## Pin 2: pipeline (A; **ADR-012**)

- `createPipeline`: `approvals.kind === "none"` is accepted in proxy mode; with `hookAgent` set it throws ("decide-only
  mode uses hook-ask or slack") so hook semantics do not change this slice. `hook-ask` in proxy mode is still refused.
- `require_approval` + `none`: `approval = { callId, decision: "no-channel", reason: PROXY_NO_CHANNEL_REASON, decidedAt,
  channel: "none" }`, intent record appended WITH that approval, then a `blocked` outcome record, then
  `deny(callId, "agent-ledger: denied (<risk>; <ruleId>): " + PROXY_NO_CHANNEL_REASON)` → `handle` returns `{ content:
  [{ type: "text", text }], isError: true }`, upstream never called. Same order as the Codex no-channel branch.
- The report already labels `decision === "no-channel"` as `denied: no channel` (`src/report/render.ts:82`) and excludes it
  from "Asks" (`:157`); no report change.
- Everything else in `handle` is unchanged: `handle` logs nothing itself; the server (pin 8) logs.

## Pin 3: front (A): Streamable HTTP server, revision 2026-07-28 only

`startFront(handler, { mode: "http", port, bindHost, allowedOrigins, tools })` → `{ stop }`. One `node:http` server, no
framework, no SDK (the published SDK is legacy-era, §0). `mode: "stdio"` stays `notImplemented` (2b: not needed for
server mode). Routes, in this order of checks:
- `GET /healthz` → `200 {"ok":true}`, no auth, no ledger access (probes). Any other path → `404` empty.
- `/mcp`: method not POST → `405` with `Allow: POST` (covers legacy GET/DELETE). `Origin` present and not in
  `allowedOrigins` → `403` (JSON-RPC error body, no `id`); absent `Origin` passes. `Authorization: Bearer <token>`
  missing or malformed → `401`, `WWW-Authenticate: Bearer realm="agent-ledger"`, nothing logged about the token. Body
  > `MAX_BODY_BYTES` (1 MiB) → `413`. `Content-Type` not `application/json` → `415`. Invalid JSON → `400` `-32700`.
  `MCP-Protocol-Version` missing, or ≠ `_meta["io.modelcontextprotocol/protocolVersion"]`, or `Mcp-Method` ≠ `method`,
  or (`tools/call`) `Mcp-Name` missing/≠ `params.name` (Base64 sentinel `=?base64?…?=` decoded first) → `400` `-32020`.
  Version present but not `2026-07-28` → `400` `-32022` `data: { supported: ["2026-07-28"], requested }`. `_meta`
  lacking `protocolVersion` or `clientCapabilities` → `400` `-32602`. `Mcp-Session-Id`, `Last-Event-ID` → ignored, never
  echoed. A notification (no `id`) → `202`, no body. `initialize` → `404` `-32601` with message "unknown method
  initialize: this server speaks MCP 2026-07-28 only (no initialize handshake)". Any other unknown method → `404` `-32601`.
- `server/discover` → `{ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta:
  { "io.modelcontextprotocol/serverInfo": { name: "agent-ledger", version: <package.json version> } }, instructions:
  <one sentence: every call is classified and recorded; risky calls need an approval channel>, ttlMs: 3_600_000,
  cacheScope: "private" }`.
- `tools/list` → `{ resultType: "complete", tools: [...], ttlMs: 60_000, cacheScope: "private" }` from `opts.tools()`
  (pin 5 names; sorted by exposed name; `inputSchema` and `annotations` passed through verbatim; `description` prefixed
  `[<server>] `), no `nextCursor`.
- `tools/call` → `params.name` looked up in the CURRENT exposed-name table (pin 5); unknown → `400`-class JSON-RPC
  `-32602 "Unknown tool: <name>"` and NO IncomingCall (a non-existent tool has no identity to record; stated in README).
  Known → `IncomingCall { callId: randomUUID(), credential: { kind: "api_key", value: token }, server, tool, args:
  params.arguments ?? {} (must be a plain object, else -32602), receivedAt }` → `await handler(incoming)` →
  `{ resultType: "complete", content: result.content, isError: result.isError }` with `_meta.serverInfo`. A handler
  throw → `500` JSON-RPC `-32603` with a generic message (never the exception text).
- Responses are always `application/json` (no SSE in 2a: the server chooses per request). Every result carries
  `_meta["io.modelcontextprotocol/serverInfo"]`. Constants exported: `MCP_ENDPOINT_PATH = "/mcp"`,
  `HEALTH_PATH = "/healthz"`, `MAX_BODY_BYTES`, `JSONRPC_HEADER_MISMATCH = -32020`, `JSONRPC_UNSUPPORTED_VERSION =
  -32022`. `DEFAULT_BIND_HOST` stays `127.0.0.1`; the server (pin 8) passes `0.0.0.0` explicitly.
- All six `test/todo/front.todo.md` items become tests, plus: bearer → credential, 401 shape, `initialize` message,
  notification 202, body cap, discover shape, `resultType`/`ttlMs`/`cacheScope` present, unknown tool makes no handler call.

## Pin 4: upstream and secrets (A)

- `UpstreamConfig` is unchanged; 2a implements `transport: "http"` only (`stdio` → `notImplemented`, 2b). New optional
  field is NOT added; auth comes from secrets: `connectUpstreams(config, secrets)` calls `secrets.get(name)` per upstream
  and, when the map has `bearerToken`, sends `Authorization: Bearer <value>` on every request to that upstream; the
  value is held in a closure, never on the returned object, never in an error message.
- Client requests carry `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`, `Mcp-Name` (tools/call), `Accept:
  application/json, text/event-stream`, `_meta` with `protocolVersion`, `clientCapabilities: {}`, `clientInfo
  { name: "agent-ledger-proxy", version }`. A `text/event-stream` response is read to its final JSON-RPC response (so a
  conforming upstream that streams still works); a response without a terminal message → throw.
- `connectUpstreams`: at construction, `server/discover` (must list `2026-07-28`, else throw naming the upstream and its
  `supportedVersions`) then `tools/list` once; the combined `ToolInfo[]` keeps `server` = the config `name`
  (`MCP_SERVER_NAME_RE` enforced on config names; duplicates refused). `listTools()` returns the cached list (refresh is
  2b). `execute(call)`: `call.server` must be a configured upstream (else throw `unknown upstream`), `tools/call` with
  `name: call.tool`, `arguments: call.args`, 30 s `AbortController` timeout → throw `UpstreamTimeout` (name used as
  `errorClass`), response cap 4 MiB. Result: `{ content: result.content, isError: result.isError === true }`;
  `resultType !== "complete"` (an `input_required` MRTR result) → `{ content: [{type:"text", text: "upstream requires
  interactive input; not supported by the proxy"}], isError: true }` (never forwarded: the agent must not be asked by an
  upstream through us). `close()` aborts in-flight requests.
- `createSecretsProvider("file", dir)`: `dir` is a directory; every regular file named `<server>.<key>` (K8s Secret keys
  become files) is an entry; `get(server)` returns `{ [key]: trimmed contents }` for that server, `{}` when none; file
  names are validated (`^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+$`), symlinks refused (`O_NOFOLLOW`), the directory is read once
  at construction. `"env"` → `notImplemented` (2b). Errors name the file, never the value. Tests: the three todo items.

## Pin 5: exposed tool names (A implements; B's registry rows and HOMELAB use them)

Exposed MCP name = `${server}__${tool}` (e.g. `demo__echo`; Claude Code shows `mcp__agent-ledger__demo__echo`). The
front builds a `Map<exposed, { server, tool }>` from `opts.tools()` and refuses to start when two pairs collide (fail
closed; ADR-006 showed why `__` must never be parsed back). Registry rows stay keyed by the RAW pair (`demo` / `echo`):
policy sees raw identity, as spec §3 requires. Name length ≤ 128 is checked at start.

## Pin 6: the demo upstream (A; `src/server/demo-upstream.ts`, same image, second entrypoint)

`node dist/server/demo-upstream.js` = `startFront(localHandler, { mode: "http", bindHost: "0.0.0.0", port:
$AGENT_LEDGER_DEMO_PORT (3001), allowedOrigins: [], tools })` whose handler accepts only `credential.value ===
$AGENT_LEDGER_DEMO_TOKEN` (constant-time compare; wrong → `isError` "unauthorized"; the front itself still 401s a missing
bearer) and implements, server name **`demo`**: `echo { message }` → the message; `now {}` → ISO time; `add { a, b }` →
sum; `wipe { target }` → the text "nothing was wiped: demo tool" (a harmless tool REVIEWED AS RISKY so the no-channel
deny is demonstrable); `whoami {}` → "demo upstream" (deliberately NOT in the registry → `unreviewed`). The demo upstream
reads the token from a file (`AGENT_LEDGER_DEMO_TOKEN_FILE`), never from argv. It is the credential boundary of the
demo: Claude Code holds the proxy key, only the proxy holds this token, and the NetworkPolicy (pin 10) makes the
upstream unreachable from anything but the proxy. Registry rows shipped in `deploy/k8s/config/registry.yaml` (B copies A's
tool list): `demo/echo read storeArgs [message]`, `demo/now read`, `demo/add write storeArgs [a, b]`, `demo/wipe risky
storeArgs []`, `reviewedBy: ryan`, `reviewedAt: <the day Ryan applies it>` (HOMELAB step 6 says: edit the date and read
the five rows before applying; applying is the review).

## Pin 7: CLI `--ledger` (A)

```text
agent-ledger anchor | verify | report ... [--ledger postgres://user@host:port/db]
```
When `--ledger` is given (must start with `postgres://` or `postgresql://`), the CLI uses `createLedger("postgres", url)`
instead of the jsonl file and skips the `<dir>/ledger` existence check; `--dir` still holds `anchors.jsonl` (so the Mac
keeps the anchor: the off-machine copy the Postgres ledger needs). The password is NOT put on the command line: `pg`
reads `PGPASSWORD` from the environment (libpq variables; the builder cites the node-postgres "connecting" page when
ticking the item [H until cited]). `hook`, `init`, `install-hooks` refuse `--ledger` (usage error, exit 2). Exit codes
unchanged. `src/cli/README.md` documents it and the fact that the URL is never printed.

## Pin 8: the server composition root (A; `src/server/main.ts`; **ADR-013** names it as the server-mode composition root)

Environment contract (B's Deployment sets exactly these; nothing else is read):

| Variable | Meaning |
|---|---|
| `AGENT_LEDGER_CONFIG_DIR` | directory holding `registry.yaml`, `agents.yaml`, `upstreams.yaml`, `hmac.key` (32 raw bytes, mode 0600), `ledger.password`, `secrets/` (pin 4 dir). Every file must be owned by the process uid and not group/world-writable (`readConfigFile` rule); the staging initContainer guarantees it |
| `AGENT_LEDGER_LEDGER_URL` | `postgres://ledger_app@postgres.agent-ledger.svc.cluster.local:5432/ledger` (no password; the root inserts the contents of `ledger.password` into the URL it hands `createLedger`; the URL is never logged) |
| `AGENT_LEDGER_PORT` / `AGENT_LEDGER_BIND_HOST` | default `8787` / `0.0.0.0` (the only place `0.0.0.0` is chosen, on purpose) |
| `AGENT_LEDGER_ALLOWED_ORIGINS` | comma-separated; empty = no browser origin allowed |
| `AGENT_LEDGER_APPROVALS` | must be `none` in 2a (anything else → refuse to start; `slack` arrives with the approvals module) |

`upstreams.yaml`: `version: 1`, `upstreams: [{ name: demo, transport: http, url: http://demo-upstream.agent-ledger.svc.cluster.local:3001/mcp }]`
(parsed with the shared `parseConfigDocument`; unknown fields refused). Start order: load registry (refuse on any loader
error) → identity (`file`) → hmac key → secrets → `createLedger("postgres")` and `await ledger.head()` (unreachable DB =
refuse to start, exit 1, reason without the URL) → `connectUpstreams` → `createPipeline({ approvals: { kind: "none" } })`
→ `startFront`. Log one JSON line per request to stderr: `{ ts, callId, agentId?, server, tool, verdict, ruleId,
status, ms }`: no args, no credential, no token, no URL (the leak sweep covers the log). `SIGTERM` → `front.stop()` →
`upstream.close()` → pool end → exit 0 within 10 s. The process refuses to start when `NODE_OPTIONS` is set (spec §7
launch-environment residual; Kyverno also forbids it, pin 10). `docker-compose.yml` (B) is updated to this contract.

**Smoke client** `src/server/smoke.ts` (A): `node dist/server/smoke.js --url <proxy mcp url> --key-file <path>
[--expect-upstream-401 <upstream url>]` runs: discover (version listed) → list (exactly the 5 demo tools, sorted) → call
`demo__echo {message:"hello"}` (ok) → `demo__now` (ok) → `demo__add` (ok) → `demo__wipe` (isError, text contains
`PROXY_NO_CHANNEL_REASON`) → `demo__whoami` (isError, unreviewed) → wrong key → 401 → missing `Mcp-Name` → 400/-32020 →
`GET /mcp` → 405 → (optional) direct call to the upstream URL without token → 401. Prints one line per check,
`SMOKE PASS` / `SMOKE FAIL <check>`, exit 0/1. Used by B's integration Job (pin 12) and by Ryan from the Mac.

## Pin 9: Postgres ledger (B; ledger-engineer brief; **ADR-013** records the storage shape)

Same chain, same bytes: a row stores the sealed record's exact RFC 8785 line (what jsonl writes minus `\n`), so
`verify()` and `read()` run the SAME validation code as jsonl. B extracts that code from `jsonl.ts` into
`src/ledger/chain.ts` (`sealRecord`, `checkStoredLine`, `verifyLines(AsyncIterable<string>)`, `parseStored`) and makes
`JsonlLedger` call it; `test/ledger-chain-parity.test.ts` runs one fixture table (edit, delete, reorder, truncate,
duplicate id, injected field, canonicalisation variants, `:60`, duplicate JSON member) against BOTH backends.

`deploy/sql/001_init.sql` (applied once by the image's initdb hook through `001_init.sh`, which passes the role passwords
as `psql -v` variables from env, never inside the ConfigMap):
```sql
CREATE SCHEMA ledger; REVOKE ALL ON SCHEMA ledger FROM PUBLIC;
CREATE TABLE ledger.records (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id         text NOT NULL UNIQUE,
  hash       text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  prev_hash  text NOT NULL,
  written_at timestamptz NOT NULL,
  call_id    text NOT NULL,
  phase      text NOT NULL CHECK (phase IN ('intent','outcome')),
  line       text NOT NULL);                           -- the canonical JSON of the sealed record, byte-exact
CREATE INDEX records_written_at ON ledger.records (written_at, seq);
CREATE INDEX records_call_id ON ledger.records (call_id);
CREATE FUNCTION ledger.refuse_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger.records is append-only'; END $$;
CREATE TRIGGER records_append_only BEFORE UPDATE OR DELETE ON ledger.records FOR EACH ROW EXECUTE FUNCTION ledger.refuse_mutation();
CREATE TRIGGER records_no_truncate  BEFORE TRUNCATE ON ledger.records EXECUTE FUNCTION ledger.refuse_mutation();
CREATE ROLE ledger_app    LOGIN PASSWORD :'app_pw';    GRANT USAGE ON SCHEMA ledger TO ledger_app;    GRANT SELECT, INSERT ON ledger.records TO ledger_app;
CREATE ROLE ledger_reader LOGIN PASSWORD :'reader_pw'; GRANT USAGE ON SCHEMA ledger TO ledger_reader; GRANT SELECT ON ledger.records TO ledger_reader;
```
(`IF NOT EXISTS` guards everywhere so a re-run is a no-op; forward-only; versioned migrations are 2b.)

`PostgresLedger` (`createLedger("postgres", url)`; one `pg.Pool`, max 4):
- `append`: one transaction: `SELECT pg_advisory_xact_lock(hashtext('agent-ledger.records'))` → read the tail row
  (`ORDER BY seq DESC LIMIT 1`) → `checkStoredLine` on its `line` and column/line equality (a tampered tail fails closed:
  "run verify()", exactly the jsonl rule) → seal (same clock/format rules) → `INSERT` with columns derived from the sealed
  record → commit. Any error → throw (the pipeline denies; spec §7). `UNIQUE(id)` is the duplicate-id refusal.
- `head()`: tail row's line re-hashed and checked, or `"0"`.
- `verify()`: keyset pagination (`WHERE seq > $1 ORDER BY seq LIMIT 1000`, no extra package) through `verifyLines`, PLUS
  the Postgres-only check that every row's columns equal the values inside its line (`id`, `hash`, `prevHash`,
  `writtenAt`, `call.callId`, `phase`): a lying index column is a broken record (`brokenAt` = id). `checked` counts rows.
- `read(range)`: `WHERE written_at BETWEEN $1 AND $2 ORDER BY seq`, every row through `parseStored` + column equality;
  a bad row throws (a report must fail, never skip). Range validation identical to jsonl.
- Never logs the URL or SQL parameters; errors are wrapped with the operation name only.
- Real-Postgres tests (`test/helpers/pg-cluster.ts`: `initdb --auth=trust -U agent_ledger_test`, `pg_ctl start -o "-k
  <tmp> -c listen_addresses=''"` on a unix socket, `psql -f deploy/sql/001_init.sql`; skipped with a visible reason when
  `pg_ctl` is absent, overridable with `AGENT_LEDGER_PG_BIN`): parity table; 4 real processes × 100 appends
  (`test/helpers/ledger-child.ts` gains a URL mode); a contention proof with the advisory lock held; **the database refuses
  UPDATE/DELETE/TRUNCATE as `ledger_app` AND as the superuser (trigger)**; `ledger_reader` cannot INSERT; a superuser
  edit of a middle row's `line` → `verify()` fails at that id; an edited `written_at` column → `verify()` fails at that id
  and `read()` throws; chain verifies after pool restart. Timing items stay generous and in `test/timing/`.

## Pin 10: deployment (B; `deploy/`)

Layout: `deploy/k8s/` numbered manifests applied with `kubectl apply -k deploy/k8s` (kustomize, built into kubectl)
whose `kustomization.yaml` `images:` block pins `ghcr.io/ryan-zeleznock/agent-ledger` to `newTag: slice-2a` +
`digest: sha256:<from the Kaniko digest file>`; `deploy/kaniko/job.yaml`; `deploy/falco/values.yaml`; `deploy/sql/`;
`deploy/k8s/config/` (registry.yaml, upstreams.yaml, 001_init.sh); `deploy/k8s/test/` (negative-test pods for Kyverno
and PSA). Secrets are NEVER in the repo: HOMELAB steps create them with `kubectl create secret … --from-file`.

| Resource (namespace `agent-ledger` unless noted) | Pins |
|---|---|
| `Namespace agent-ledger` | labels `pod-security.kubernetes.io/{enforce,audit,warn}: restricted`, `*-version: latest` |
| `ServiceAccount proxy`, `postgres`, `demo-upstream`, `integration` | `automountServiceAccountToken: false` on all four; every Pod also sets it `false` |
| `Secret ghcr-pull` (dockerconfigjson), `proxy-config` (`agents.yaml`, `hmac.key`, `ledger.password`, `secrets/demo.bearerToken`), `demo-upstream` (`token`), `postgres-credentials` (`POSTGRES_PASSWORD`, `LEDGER_APP_PASSWORD`, `LEDGER_READER_PASSWORD`) | created by Ryan (steps 3, 5); `agents.yaml` holds the api_key SHA-256 only |
| `ConfigMap proxy-registry` (`registry.yaml`, `upstreams.yaml`), `postgres-init` (`001_init.sh`, `001_init.sql`) | from `deploy/k8s/config/` |
| `StatefulSet postgres` (1 replica) + `volumeClaimTemplates data` 2Gi `local-path` | image `docker.io/library/postgres:17.11-alpine3.24`; `securityContext`: `runAsUser/runAsGroup/fsGroup 999`, `runAsNonRoot`, seccomp `RuntimeDefault`, drop `ALL`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`; emptyDirs at `/var/run/postgresql`, `/tmp`; `PGDATA=/var/lib/postgresql/data/pgdata`; initdb hook from the ConfigMap; env from `postgres-credentials`; requests 250m/256Mi, limits 1/1Gi; readiness `pg_isready -U postgres` |
| `Service postgres` ClusterIP 5432, `demo-upstream` ClusterIP 3001, `proxy` **NodePort 30787**, `externalTrafficPolicy: Local` | |
| `Deployment proxy` (1 replica) | image `ghcr.io/ryan-zeleznock/agent-ledger:slice-2a@sha256:…`, CMD `["dist/server/main.js"]` (distroless entrypoint is `node`); `runAsUser/Group 65532`, `runAsNonRoot`, seccomp `RuntimeDefault`, drop `ALL`, no escalation, `readOnlyRootFilesystem: true`; **initContainer `stage-config`** `docker.io/library/busybox:1.37.0`, same uid, copies `/mnt/secrets/*` + `/mnt/registry/*` into the `Memory` emptyDir `/run/agent-ledger` with `chmod 600`; env per pin 8; requests 100m/128Mi, limits 500m/256Mi; readiness/liveness `GET /healthz` |
| `Deployment demo-upstream` (1 replica) | same image, CMD `["dist/server/demo-upstream.js"]`, same hardening, token file from Secret via the same staging pattern |
| `NetworkPolicy`: `00-default-deny` (all pods, Ingress+Egress), `10-allow-dns` (egress to `kube-system` pods labelled `k8s-app=kube-dns`, 53 UDP+TCP), `20-proxy-egress` (→ `app=postgres` 5432, → `app=demo-upstream` 3001), `21-proxy-ingress` (8787 from `ipBlock 10.20.0.0/24` and from `app=integration`), `22-postgres-ingress` (5432 from `app=proxy`, `app=integration`), `23-demo-upstream-ingress` (3001 from `app=proxy`, `app=integration`), `24-integration-egress` (→ proxy, postgres, demo-upstream) | nothing else; Postgres has NO egress; the demo upstream has NO egress |
| `Job integration` (pin 12) | same image; `ServiceAccount integration` |
| `policies.kyverno.io/v1 ValidatingPolicy agent-ledger-hardening` (cluster-scoped kind; `matchConstraints` on `pods` CREATE/UPDATE in namespace `agent-ledger` via `namespaceSelector` `kubernetes.io/metadata.name=agent-ledger`) | `validationActions: [Deny]`; CEL: every container image starts with `ghcr.io/ryan-zeleznock/agent-ledger` or `docker.io/library/postgres:17.` or `docker.io/library/busybox:1.`; an `agent-ledger` image contains `@sha256:`; no container has an env var named `NODE_OPTIONS`; `spec.automountServiceAccountToken == false`; every container has `securityContext.readOnlyRootFilesystem == true`. Proven by `kubectl apply --dry-run=server -f deploy/k8s/test/bad-pod-*.yaml` → denied (step 7) |
| Falco (`deploy/falco/values.yaml`, Helm `--reuse-values`) | `customRules.agent-ledger.yaml`: rule 1 `Agent Ledger proxy spawned a process`: `spawned_process and container and k8s.ns.name = "agent-ledger" and container.image.repository startswith "ghcr.io/ryan-zeleznock/agent-ledger" and not proc.name = "node"`, priority WARNING (distroless: any exec is anomalous); rule 2 `Shell in agent-ledger namespace`: `spawned_process and container and k8s.ns.name = "agent-ledger" and proc.name in (sh, ash, bash) and not container.image.repository = "docker.io/library/busybox"`, priority NOTICE (testable: `kubectl exec postgres-0 -- sh -c id` must appear in `kubectl -n falco logs ds/falco`). Both tagged `agent-ledger` |
| `local-path-provisioner v0.0.37` (namespace `local-path-storage` + RBAC + Deployment + StorageClass) | upstream manifest URL applied verbatim (step 1) |
| Namespace `build`: `ConfigMap agent-ledger-context` (binaryData `context.tar.gz`), `Job kaniko-agent-ledger` | executor `gcr.io/kaniko-project/executor:v1.23.2`, `--context=tar:///work/context.tar.gz --dockerfile=Dockerfile --destination=ghcr.io/ryan-zeleznock/agent-ledger:slice-2a --digest-file=/dev/termination-log --reproducible --cache=false`, `ghcr-auth` at `/kaniko/.docker` as the existing job does; the digest is read from the pod's termination message (step 4) |

`Dockerfile` (B; multi-stage): `node:24-alpine3.24` builder: `npm ci` (`.npmrc` already pins `ignore-scripts`,
`save-exact`) → `npm run build` → `npm ci --omit=dev`; runtime `gcr.io/distroless/nodejs24-debian12:nonroot`: `COPY
--from=builder /app/dist /app/node_modules /app/package.json`, `WORKDIR /app`, `CMD ["dist/server/main.js"]`, `USER
65532`. No `policies/` (the server reads the registry from the ConfigMap), no shell, no npm.

## Pin 11: `docs/HOMELAB.md` (B): the runbook, one approved command per cluster change

Every step: what it changes (resource list), the exact command, how to verify (read-only), how to undo. Steps:
0 prerequisites on the Mac (kubectl context `kubernetes-admin@kubernetes`, helm 4.3.0, Claude Code ≥ 2.1.274, Homebrew
Postgres only for tests; NO Docker needed) · 1 storage (local-path manifest; verify `kubectl get sc`) · 2 namespace + PSA
(`kubectl apply -f deploy/k8s/00-namespace.yaml`; prove: `kubectl -n agent-ledger apply --dry-run=server -f
deploy/k8s/test/root-pod.yaml` is rejected by PSA) · 3 GHCR pull secret · 4 build (tarball → ConfigMap → Kaniko Job →
digest → `kustomization.yaml`) · 5 secrets (`openssl rand -hex 32` for the API key; its SHA-256 via the documented
`node -e` one-liner into `agents.yaml`; `openssl rand 32 > hmac.key`; three Postgres passwords; demo token) · 6 ConfigMaps
(read the five registry rows: applying is the review) · 7 Kyverno policy + negative proofs · 8 Postgres (StatefulSet,
Service, NetworkPolicies; verify `pg_isready`, PVC Bound, pod uid 999, `kubectl -n agent-ledger exec postgres-0 -- psql
… -c '\du'` shows the two roles; a `DELETE` as `ledger_app` is refused) · 9 proxy + demo-upstream (verify `/healthz` via
`kubectl port-forward`, the stderr log shows the ledger head) · 10 Falco rule (helm upgrade; trigger rule 2; show the
alert) · 11 integration Job (`SMOKE PASS`, the anchor line printed in the Job log = copy it into the vault pack dir,
`verify` exit 0 `head`) · 12 Claude Code on the Mac (sandbox project; `MCP_SDK_GENERATION=v2 MCP_PROTOCOL_NEGOTIATION=auto
claude mcp add --scope local --transport http agent-ledger http://10.20.0.11:30787/mcp --header "Authorization: Bearer
${AGENT_LEDGER_KEY}"`; `/mcp` shows 5 tools; ask Claude to echo, to add, to run `demo__wipe` (denied: no channel) and
`demo__whoami` (denied: unreviewed); Hubble shows the flow; fallback `kubectl port-forward svc/proxy 8787:8787`) · 13
evidence from the Mac (`kubectl port-forward svc/postgres 15432:5432`; `PGPASSWORD=… agent-ledger anchor|verify|report
--ledger postgres://ledger_reader@127.0.0.1:15432/ledger --dir ~/agent-ledger-lab`; the pack says `channel: none` denials
and the Mac-side anchor) · 14 CKS tour (PSA rejection, Kyverno denial, NetworkPolicy proof from `attacker/netshoot`:
`curl --max-time 3 http://proxy.agent-ledger.svc.cluster.local:8787/healthz` and `…demo-upstream…:3001/mcp` both time
out; `kubectl get vulnerabilityreports -n agent-ledger` from trivy-operator; Falco alert) · 15 teardown (reverse order;
PVC deletion = ledger deletion, say so; the anchor and the pack survive on the Mac).
Residuals stated in the runbook, verbatim: plain HTTP on the lab LAN (TLS is 2b); one Postgres replica on one node's
disk; the Kaniko project is archived; no approval channel means risky calls are denied, not approved; the server-mode
trust-boundary sentence from spec §3.

## Pin 12: the in-cluster integration Job (B writes the manifest; A's binaries)

`Job integration` (`backoffLimit: 0`, `ttlSecondsAfterFinished: 86400`, same image, emptyDir `/work`, `proxy-config`'s
API key file mounted read-only): `node dist/server/smoke.js --url http://proxy:8787/mcp --key-file /mnt/key/api-key
--expect-upstream-401 http://demo-upstream:3001/mcp` then `node dist/cli/main.js anchor --ledger $URL --dir /work` then
`node dist/cli/main.js verify --ledger $URL --dir /work` (expects exit 0 and `"status":"head"`; `PGPASSWORD` from the
`postgres-credentials` reader password). Pod log = the acceptance evidence; step 11 copies the anchor line out.

## Gates for both

`npm run typecheck && npm test` green before every commit (master today: `npm run check` green, 1075 unit + 77 timing);
test-first; tick todo items; README `Status: implemented` only when no export in the module is a stub (`front` and
`upstream` keep a "not implemented: stdio / env / legacy era" line); commit on your branch only; never merge; never
touch the cluster, `~/.claude`, `~/.codex`. New runtime dependency: `pg` only, by B (ADR-013). Reviews follow the Build
loop: one full cross-review (A reviews B's range, B reviews A's), fix, one scoped verification pass.

## Acceptance bar

**Package A**
- Tests: every `front`/`upstream`/`secrets` todo item; the pin 3 status/code matrix as a table test with a real
  `node:http` server; bearer → credential and the credential never in any log line; `initialize` message names
  2026-07-28; `tools/list` deterministic and `demo__*` names; collision at start → refuse; `connectUpstreams` refuses an
  upstream whose discover lacks 2026-07-28; 30 s timeout → `UpstreamTimeout` outcome `error`; an `input_required` result
  is never forwarded; secrets dir parsing, symlink refusal; pipeline `none` branch: record shapes (approval `no-channel`
  + `channel: none`, blocked outcome), `hookAgent` + `none` refused; CLI `--ledger` parsing and refusal rows (using a fake
  `createLedger` injected through `CliDeps`); `test/e2e-slice-2a.test.ts` steps 1-12 below, jsonl backend.
- Todo: `front.todo.md`, `upstream.todo.md`, `secrets.todo.md` ticked or rewritten as 2b items; `pipeline.todo.md` gains
  the `none` items, ticked.
- Demo steps that must work: HOMELAB 9 (`/healthz`, head logged), 11 (`SMOKE PASS` locally against the e2e sandbox), 12
  (tool list and the two denials as Claude sees them).

**Package B**
- Tests: the pin 9 list (parity table on both backends; 4-process appends; contention; append-only enforced by the
  database for every role; column-vs-line tamper; restart) on the Homebrew cluster, skipped visibly without it;
  `validate.ts` accepts and round-trips `channel: "none"`; `verify()` keyset pagination crosses a 1000-row boundary;
  `read()` on a lying `written_at` throws; `npm test` green 3/3 with the real cluster running; the image builds with
  `npm ci --omit=dev` and starts (`node dist/server/main.js` refuses to start with no config: exit 1, no stack trace).
- Deployment: every manifest passes `kubectl apply --dry-run=client -k deploy/k8s` on the Mac; `kubectl kustomize`
  output reviewed for the digest placeholder; the Kyverno policy's negative pods and the PSA root pod exist under
  `deploy/k8s/test/`; HOMELAB.md has every step's verify and undo lines; residuals paragraph present verbatim.
- Todo: `ledger.todo.md` postgres item ticked with the harness cited; `README` documents the column/line rule and the
  append-only grants + trigger.
- Demo steps: HOMELAB 1-8, 10, 13, 14 (B writes them; Ryan runs them; the coordinator reads the outputs).

## Integration seams (`test/e2e-slice-2a.test.ts`: A writes steps 1-12 against jsonl; the coordinator runs the SAME file
with `AGENT_LEDGER_E2E_LEDGER=<url from test/helpers/pg-cluster.ts>` after both reviews, which is the docker-less Postgres
e2e; then Ryan's HOMELAB steps 11-13 are the cluster e2e)

Real processes from the private build root (as in 1c): the demo upstream (`demo-upstream.js`, token T), the proxy
(`main.js`, API key K in `agents.yaml`, registry = the five pin 6 rows, jsonl ledger or the URL from the env), and
`test/helpers/mcp-client.ts` (a 40-line 2026-07-28 client over `fetch`; also used by `smoke.ts`).
1. `GET /healthz` 200 before any auth; the proxy stderr shows the ledger head line and no key, token or URL.
2. `server/discover` lists `2026-07-28`; `tools/list` = `demo__add, demo__echo, demo__now, demo__whoami, demo__wipe` in
   that order with `ttlMs`, `cacheScope`, `resultType`.
3. `demo__echo {message: "hello <canary-clear>"}` → ok; intent + outcome records; `call.args.message` in the clear;
   `call.agentSessionId` absent; `approval` absent; `policy.ruleId = registry:demo/echo`.
4. `demo__add {a: 2, b: 3, note: "<canary-hashed>"}` → ok, `args.note` is `hmac-sha256:` (storeArgs [a, b]).
5. `demo__wipe {target: "prod"}` → `isError`, text contains `PROXY_NO_CHANNEL_REASON`; intent carries `approval
   { decision: "no-channel", channel: "none" }`; a `blocked` outcome follows; the upstream's own log shows NO call.
6. `demo__whoami` → `isError`; `policy.risk = unreviewed`, `ruleId = unreviewed:demo/whoami`, `no-channel`, blocked.
7. Wrong key → 401 and no record; missing `Mcp-Name` → 400 `-32020`, no record; `MCP-Protocol-Version: 2025-11-25` →
   400 `-32022` with `supported: ["2026-07-28"]`; `Origin: https://evil.example` → 403; `GET /mcp` → 405; `initialize`
   → 404 `-32601` naming 2026-07-28; a notification → 202; a 2 MiB body → 413. None of these writes a record.
8. Direct `tools/call` to the demo upstream with K (the agent's key) → 401/`isError`: the agent's credential is not the
   upstream's (spec §9), and the upstream token never appears in any proxy response.
9. `smoke.js` against the same sandbox prints `SMOKE PASS`, exit 0; with a wrong key file → `SMOKE FAIL`, exit 1.
10. `verify` exit 0 (`--ledger` form when the env URL is set; jsonl form otherwise); `anchor` → `head`; `report --from
    --to` renders `denied: no channel` for steps 5-6 and `executed (allowed)` for 3-4; the pack's CC8.1 table has the four rows.
11. SIGTERM to the proxy → exit 0 within 10 s; a call in flight gets its outcome record or an `error` outcome, never a
    missing intent.
12. Leak sweep: K, T, the hashed canary, the Postgres URL/password and `NODE_OPTIONS` canary absent from the ledger (file
    or table dump), both process outputs, the pack, and the smoke output.

Where two correct halves could still fail together: A's `channel: "none"` records rejected by B's validator (pin 1; step
5 catches it on jsonl, the Postgres run catches `parseStored` on read-back); A's server passes a URL `pg` parses
differently than B's tests assumed (password with `@`/`%` → B's README states the URL-encoding rule, A's root
`encodeURIComponent`s the password; the Postgres e2e run catches it); the exposed name table (A) and the registry rows
(B's ConfigMap) disagree on a tool name (steps 2-6 against the SAME `registry.yaml` file B ships: A's e2e loads
`deploy/k8s/config/registry.yaml`, not a private copy); the staging initContainer leaves a file group-writable or
root-owned → `readConfigFile` refuses at start (HOMELAB step 9 verify line shows the exact stderr reason; A's root prints
which file failed, never its contents); the Kyverno policy denies B's own Pods (the `kubectl --dry-run=server` of the
real manifests is step 7's last verify); Claude Code's v2 probe not accepting a modern-only server (§0 [H]: step 12; fallback port-forward does not change the
protocol, so the real fallback is the 2b dual-era front); `--digest-file=/dev/termination-log` truncated by the 4 KiB
termination-message limit (a digest is 71 bytes; fine) or missing because Kaniko wrote it after the log was captured
(step 4 reads `state.terminated.message`).

## ADR items (drafted in the vault, `status: proposed`; Ryan accepts or rejects before the marked pins are implemented)

- **ADR-012** (`decisions/ADR-012-approval-channel-none.md`): pin 1 (`ApprovalChannel` `none`, `APPROVAL_CHANNEL_KINDS`,
  `PROXY_NO_CHANNEL_REASON`), pin 2 (pipeline branch), the validator line. Without it server mode cannot construct a
  pipeline; there is no fallback that keeps the slice.
- **ADR-013** (`decisions/ADR-013-server-mode-slice-2a.md`): `src/server/` as the server-mode composition root (spec §4
  table addition), the Postgres storage shape and database-enforced append-only (pin 9), `pg` as a runtime dependency,
  exposed tool names (pin 5), API-key bearer auth without OAuth (spec §9 reading), 2026-07-28-only front/upstream with our
  own demo upstream (and the explicit 2b items: dual-era upstream client for legacy third-party servers, TLS, Slack,
  stdio front, `env` secrets, Kaniko replacement), the home-lab Kubernetes target replacing the compose skeleton as the
  reference deployment, CLI `--ledger`. Rejecting single items: tool naming and `--ledger` have no fallback that keeps
  the demo; the Postgres shape could fall back to a JSONB column at the cost of the byte-exact parity argument (not recommended).

## Risks (architect)

- **Era mismatch is the biggest unknown**: the only modern-era MCP implementations we can point at today are ours and
  Claude Code's v2 runtime. If step 12 fails, the demo still runs through `smoke.js` (our client), and 2b adds the
  legacy handshake to the front. The upstream side is already decided (own demo upstream).
- Kyverno/PSA interplay: `readOnlyRootFilesystem` + distroless + Node is fine (Node writes nothing), Postgres needs its
  two emptyDirs; a forgotten mount shows as CrashLoopBackOff in step 8/9, not as a silent allow.
- `externalTrafficPolicy: Local` means only the node running the proxy answers on 30787; HOMELAB says to read the node
  from `kubectl get pod -o wide` and documents the port-forward fallback.
- Postgres as uid 999 with the 0777 host dir: [H] above; if `initdb` still refuses, the fallback is a `fsGroupChangePolicy`
  +`subPath` variant, recorded in HOMELAB, never `runAsUser: 0`.
- Reproducible-ish builds: `--reproducible` strips timestamps but `npm ci` fetches from the registry at build time;
  the lockfile pins versions, `.npmrc` disables scripts; integrity is the lockfile's hashes. Stated, not solved.
- The Falco shell rule fires on `kubectl exec` into Postgres by design (that is the demo); the proxy rule can only be
  shown as "no alerts", because distroless has nothing to exec. Both are said plainly in HOMELAB.
- Kaniko archived: works today; its executor image will not receive CVE fixes; trivy-operator will show that. 2b item.
- B's branch is wide (ledger + deploy + runbook) but its code surface (`postgres.ts`, `chain.ts`) is the part that needs
  the ledger-engineer bar; the YAML is reviewable by `kubectl --dry-run` and by A's read of the manifests against pins
  8-10. If B runs long, the coordinator may pull `docs/HOMELAB.md` steps 12-15 into A's package after the manifests land.

## Amendments (coordinator, 2026-10-03, after Astra's blocker handoff)
- Postgres pod identity: `postgres:17.11-alpine3.24` defines user/group `postgres` = **70/70** (official Dockerfile,
  docker-library/postgres 17/alpine3.24). Use `runAsUser: 70`, `runAsGroup: 70`, `fsGroup: 70`; drop the uid-999
  rationale. Keep the PGDATA subdirectory on the local-path volume.
- `channel: "none"` before integration: B codes the validator's one enum line against the pinned literal `"none"`
  (comment `// PIN-2A: replace with APPROVAL_CHANNEL_KINDS at merge`); B never edits src/types. The coordinator swaps it
  to A's exported constant at integration. B's tests use the literal.
