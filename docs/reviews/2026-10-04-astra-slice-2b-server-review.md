**Astra security review — Slice 2b, Package B (Fable), 2026-10-04**

**GATE: FAIL.** One P1, one P2, one P3. The required concurrent-approval e2e cannot pass as written once Package A is present. No production deny-to-allow path, plaintext fallback, or Slack-token disclosure was demonstrated in this range. This is a review verdict; only Ryan merges or closes the gate.

**Scope and binding inputs.** One full defensive quality review of `b265a54..bdec427` (five commits), on `slice-2b-server`, HEAD `bdec42756e96c996e49b25cac7c3c13b73b5502f`. Read the security-reviewer brief, repository/vault instructions, Slice 2b Package B pins (especially 5–11 and the acceptance bar), accepted ADR-015/016/017, and relevant spec §3/§6/§7/§9. Reviewed the changed server composition, file readers, client/smoke code, deployment/build inputs and checks, runbook, unit/e2e tests and all three new helpers. Package A was not re-reviewed.

The coordinator's separate retry budgets and 160-second startupProbe, loopback certificate SAN, everything image placeholder name, 2000 ms fake Slack timeout, runtime `// PIN-2B` seams, and TLS-forced edits to 2a tests/Compose are accepted decisions, not findings. This branch's pre-integration skips are intentional; they do not establish integrated acceptance.

**F1 — P1: concurrent e2e calls all select the same Slack message.**

Location: `test/e2e-slice-2b.test.ts:103–108`, called concurrently at `:329`, with clicks/results at `:336–341`.

Scenario: step 8 invokes three `riskyCall()` helpers in one `Promise.all`. Each captures the same `slack.posted.length` before any asynchronous HTTP request can post a message. All wait on the same length condition and return `slack.posted[before]`. Thus three different pending MCP calls are paired with the first message's timestamp, nonce and callId. The three injected decisions address one approval; the other two time out. The expected `[false, true, false]` results and three independent recorded decisions cannot hold with a correct approval router. This blocks the mandatory pin-8 concurrency/reconnect acceptance row; it is a harness defect, not evidence that the product misroutes approvals.

Evidence: a scratch Vitest regression extracted and executed the actual `riskyCall` function (Node's TypeScript stripping, no rewritten implementation), used the checked-in `FakeSlack.waitFor`, and delivered three asynchronous posts. Output: `posted: ['1','2','3']; selected: ['1','1','1']`; the distinct-message assertion failed (`expected 1 to be 3`). This reproduces without loopback or Package A. The coordinator's green branch suite can coexist with this defect because this row is skipped while Package A is absent.

Fix: obtain each message before launching the next helper, while keeping all tool-result promises pending, e.g. a loop that does `calls.push(await riskyCall(...))` without awaiting `pending`; alternatively correlate each post explicitly with its originating request. Assert three distinct timestamps and callIds before any clicks. Run integrated step 8 and the whole integrated e2e twice outside the sandbox; require the row to run rather than skip.

**F2 — P2: the connect budget does not bound an in-progress attempt.**

Location: `src/server/main.ts:152–160`, especially the unconditional success return at `:156`; consumers at `:185` and `:221`.

Scenario: `retrying` checks elapsed time only after a rejected attempt, to decide whether another sleep fits. A successful attempt is accepted regardless of duration, and a stalled attempt has no root deadline. `connectUpstreams` performs multiple requests sequentially, each with its own 30-second timeout (discovery, then paginated tool lists, for each upstream). Eight list pages taking 20 seconds each plus a 20-second discovery are individually legal but take 180 seconds, beyond the configured 60-second budget and the agreed 160-second startupProbe before Slack startup even begins. The pod can be restarted indefinitely despite responses arriving within each request timeout. This remains fail closed, but contradicts the advertised total budget and invalidates the probe calculation. The finding concerns enforcement of each budget, not the accepted decision to have separate budgets.

Evidence: a scratch regression called the compiled real `startServer` and real upstream connector, with injected fetch responses/clock and a mock listening front. It served discovery plus eight list pages, advancing the injected clock 20 seconds per response. With `AGENT_LEDGER_UPSTREAM_CONNECT_BUDGET_MS=60000`, the root reached `listening` at simulated 180000 ms. The budget assertion failed. Existing retry tests advance time only in `sleep`, so they cover backoff sums but miss time spent inside attempts.

Fix: enforce a deadline around the whole connection/probe operation, including successful and pending attempts, with bounded cancellation/cleanup and no late activation after refusal. Preserve the intentional budget-0 single-attempt behavior with an explicit finite attempt bound. Coordinate any needed additive cancellation interface rather than silently changing frozen pins. Test slow successful multi-page discovery, a stalled attempt, failure near the deadline, and cleanup of a late result. Keep the coordinator's separate budgets and 160-second probe; make the implementation satisfy them.

**F3 — P3: the runbook's closing residual summary still describes Slice 2a.**

Location: `docs/HOMELAB.md:828–833` (also the four-ServiceAccount undo wording at `:352–353`).

Scenario: after following the new approval and TLS steps, a reader reaches a summary saying the risky demo action is denied, that third-party legacy upstreams/TLS/Slack remain Slice 2b, and that only the published Agent Ledger workload image is digest-resolved. These conflict with the new approval demo, the shipped features, and the BusyBox/Postgres/everything base pins. The earlier exception sentence at `:820` helps, but leaves contradictory evidence guidance.

Fix: rewrite this closing paragraph for the integrated 2b result and retain only the actual 2c residuals; update the undo count to five ServiceAccounts. This is documentation cleanup, not a wider enforcement claim or a missing implementation.

**Checks completed and limits.**

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `git diff --check b265a54..bdec427` | PASS |
| `node deploy/check.mjs` | PASS: 26 rendered resources, five workloads; expected approvals/digest placeholder notices |
| `perl -e 'alarm shift; exec @ARGV' 900 npx vitest run test/config-hardening.test.ts test/secrets.test.ts test/approvals-shape.test.ts test/pipeline.test.ts --configLoader native` | PASS: 132 tests |
| Same alarm wrapper, `npx vitest run test/smoke-2b.test.ts -t parseSmokeArgs --configLoader native` | PASS: one test; two filtered out |
| Scratch root/config refusal checks | PASS: two tests covering absent TLS, invalid approval mode, missing Slack config, rejected token fields, timeout overflow, foreign API URL, reserved upstream and loose private-key permissions |
| Scratch F1/F2 regressions | FAIL as described above: two independently reproduced defects |
| `test/server-2b.test.ts -t 'AGENT_LEDGER_TLS absent' --configLoader native --testTimeout 1500` under the alarm wrapper | Environment-blocked: its fixture opens loopback first and gets `listen EPERM`; not counted as a product failure |
| `kubectl apply --dry-run=client --request-timeout=5s -k deploy/k8s` | Environment-blocked: OpenAPI fetch to the cluster API is denied; no resource was changed |

The default Vitest config loader initially failed because its temporary bundle was written through the shared `node_modules` symlink into a non-writable worktree. `--configLoader native` resolved that without editing configuration. Scratch probes and config are retained at `/private/tmp/astra-2b-review/`; no probe was added to the repository. Reproduce the two findings after the repository's normal test build with:

```sh
perl -e 'alarm shift; exec @ARGV' 900 npx vitest run \
  --config /private/tmp/astra-2b-review/vitest.config.mjs --configLoader native
```

The scratch root probe mocks only front listening and external fetch responses and uses the root's injected clock. It is a deterministic deadline check, not a claim of a live 180-second network run. The coordinator's full-suite green report is accepted as supplied, but this reviewer did not independently run the loopback/Postgres/integrated suites, the real everything server, a Node 24 container, or the two real-process reruns. No cluster write or real Slack call occurred.

**Security and pin assessment outside the findings.**

- Root startup: absent/invalid TLS and approval mode refuse. Slack configuration is parsed before network startup; unknown config fields, invalid IDs, invalid timeout and non-approved API URLs refuse. Slack mode calls configure only for an explicit override, requires an empty validation-problem list and a successful live probe before pipeline/front startup. An absent Package A export refuses through the accepted seam. There is no fallback to approval `none` or plaintext after a Slack/TLS failure. Real missing-token behavior remains delegated to Package A validation and must run in integrated acceptance; B's mocked validator does not itself read the tokens.
- Credentials: exact upstream name `approvals` is refused before `connectUpstreams` can request its secrets. The provider's lookup is case-sensitive; no alternate case maps to those entries. Tokens are file refs into `secrets/approvals.*`, not upstream URLs or environment entries. The root logs only approval channel/count/timeout/team. Its generic error logger relies on the pinned value-free module errors; it does not independently redact Slack token contents. No concrete leak from the reviewed dependencies/call sites was found. The staging initContainer uses `umask 077`, copies both Slack tokens and the TLS key, and chmods staged files to 0600 as uid 65532. Private-key reading checks a non-following, non-blocking fd, ownership and group/other permission bits.
- Shutdown: `closeSlackApprovals` precedes front draining, upstream closure, inflight outcome settlement and ledger closure. The root retains the pipeline's record-before-execute path and does not manufacture an allow. B's shutdown unit row verifies persisted unavailable/blocked records; the integrated e2e checks the SIGTERM result and `drained:true`. The graceful-close guarantee still depends on the ledger completing within the existing shutdown grace; the existing timeout log does not establish that all storage writes completed. This review did not identify a new bypass of persisted intent in that path.
- Smoke: flags validate supported approval modes, PEM/HTTPS pairing and server-name shape; Slack mode intentionally skips the two human-gated demo calls. Tool-list inclusion/sorting and the named upstream echo are checked. The CA path uses verified HTTPS with TLS 1.2 minimum and no redirects. `--expect-legacy` demonstrates the named echo path, not independently the negotiated era; the runbook and e2e additionally require the startup `eras` field.
- Deployment: rendered proxy is one replica with Recreate and HTTPS probes; the accepted startupProbe is 32×5 seconds. Existing ingress rules are unchanged. Only the proxy gains public IPv4 TCP 443 egress, with the pinned RFC1918 exclusions, plus the named everything upstream. `everything` has proxy-only ingress on 3001 and no egress allowance from any policy in this kustomization, including DNS. It has no mounted secret or volume, no service links, and only PORT configured. These are manifest checks, not live Cilium evidence.
- Images: the everything Dockerfile copies the exact package/lock/.npmrc inputs and runs `npm ci --omit=dev --ignore-scripts`; its runtime is distroless uid 65532. The lock's exact server-everything version/integrity match pin 10; all dependency entries have npm registry URLs and sha512 integrity, with no install-script marker. BusyBox/Postgres digest literals are consistent across the relevant manifests, Compose and checker. The zero everything digest is an acknowledged Ryan build step, not an accepted deployable image.
- Admission/RBAC/Slack app: the projected-token CEL guard rejects an explicit serviceAccountToken source independently of automount=false; its negative Pod has that explicit source. The reports ClusterRole contains exactly get/list/watch on pods/ephemeralcontainers and the prescribed aggregation label, outside the namespace kustomization. The manifest has bot chat:write only, Socket Mode and interactivity enabled, and no request URL. Live admission and RBAC aggregation are explicitly runbook verifications.
- Runbook: added steps provide changes, verify and undo; the CA key stays on the Mac, keys are private, leaf SANs include service names/node IPs/loopback, P-256 and 825-day validity are specified. TLS/NodePort/Slack isolation and late-client-abort residuals are stated. No new broad claim that local hooks enforce execution was introduced. F3 is the remaining stale summary.
- Helpers: fake Slack checks bearer type/value, drops Authorization from recorded calls, sends single-use connection URLs/hello, accepts masked client text frames and records envelope acks. Click payloads include the relevant team/app/channel/timestamp/action fields. Legacy helpers cover initialize/session/version headers, JSON/SSE including empty priming events, missing/expired sessions and DELETE. They are purpose-built fixtures, not complete protocol implementations. F1 specifically breaks the required concurrent helper pairing.

**Primary-source rechecks (2026-10-04).**

- [V] Slack documents app-level `apps.connections.open`, hello/envelope/ack shapes, refresh behavior, and distribution across open connections: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/). This supports the fake's basic shapes and the accepted single-proxy constraint. [App manifest reference](https://docs.slack.dev/reference/app-manifest/) and [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/) support the manifest and invited-channel scope choice.
- [V] Kubernetes policies combine allowed traffic across all matching policies: [NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/). Reviewed the whole rendered policy set for everything, not only its empty egress list. Kyverno documents the chosen reports aggregation label: [customizing permissions](https://kyverno.io/docs/installation/customization/#customizing-permissions).
- [V] npm documents lockfile-based `ci` and `ignore-scripts`: [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/). MCP documents Accept headers, JSON/SSE responses, empty priming events, sessions, 404 and DELETE: [2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
- [V] The upstream [local-path v0.0.37 manifest](https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.37/deploy/local-path-storage.yaml) contains the untagged BusyBox helper line matched by the runbook's substitution. Its hardcoded source-line number is not needed for the substitution.
- [V, published registry metadata] Docker's [Postgres 17.11-alpine3.24 image page](https://hub.docker.com/layers/library/postgres/17.11-alpine3.24/images/sha256-7456ef82e5f5bc43d997f4781bbd7c0d6389bff397564649a356e206ba473aee) reports the committed `b0f9560a…` index digest. Docker's indexed [Node 24-alpine3.24 image page](https://hub.docker.com/layers/library/node/24-alpine3.24/images/sha256-d3724e44ee368606d753e0027eb8d2a94fc1f275e5d9e4620178a12edb655f5f) reports the committed `ebfe2f90…` index digest.
- [H / verification limit] Independent live registry-manifest verification of all four digests was unavailable: shell DNS is blocked, and the browser could not retrieve the BusyBox official image or distroless manifest endpoints. No digest mismatch was found, but local literal equality is not proof of provenance. Retain the coordinator's registry-resolution evidence and Ryan's image-build/pull verification; do not treat this review as an independent pull of those images.

Tracked files were not modified and nothing was committed. The tracked vault `_state.md` and `research.md` were left unchanged under the user's no-tracked-edits instruction; source rechecks and current review status are recorded here and in the untracked handoff/run note.

**GATE: FAIL**
