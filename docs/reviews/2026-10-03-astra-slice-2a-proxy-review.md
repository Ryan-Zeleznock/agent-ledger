# Astra security review: Slice 2a, Package A

Date: 2026-10-03. Reviewer: Astra, adopting `.claude/agents/security-reviewer.md`.
Builder: Fable. Branch: `slice-2a-proxy`. Reviewed range: `5f998f8..cdd7894` (six commits); HEAD verified as `cdd7894f1ead6d54ba8b9c139d4a0ab969b864ab`.

**GATE: FAIL — 3 P1, 7 P2, 1 P3.** This is an independent defensive quality review, not a merge approval. Only Ryan merges/closes the gate.

Binding inputs: `docs/slices/slice-2a-pins.md`, accepted ADR-012 and ADR-013 in the vault, and relevant frozen spec §§3/6/7/9. The known Package B `src/ledger/validate.ts` channel-enum seam is explicitly NOT a finding. No tracked files were changed and no commits were made.

## Findings

### F1 — P1: upstream diagnostics expose upstream credentials and raw arguments

**Location:** `src/upstream/contract.ts:156`, `:166`; propagation through `src/server/main.ts:114` and existing `src/pipeline/contract.ts:410`.

**Scenario:** An upstream returns a JSON-RPC error whose message or data includes the received Authorization token or a request argument. The new upstream client serializes the entire error object into its exception, merely clipping its length. The pipeline puts that exception text into the agent-visible tool error. During discovery/listing, the composition root logs it in the startup refusal. The root strips ledger credentials only, not upstream credentials. Clipping is not redaction. The same issue applies to untrusted diagnostic fields such as discovery version strings.

**Evidence:** Scratch probes against the unchanged compiled modules returned `tokenLeaked:true` and `rawArgumentLeaked:true` in a proxy tools/call response, and `errorLeaked:true, logLeaked:true` on startup. Both HTTP 200 JSON-RPC errors and non-200 JSON-RPC errors expose the canaries. These were synthetic scratch values, never real credentials. The ledger itself stored only the error class in this probe.

**Fix:** Construct value-free upstream errors from validated status/code and fixed context. Do not copy upstream message/data, response headers, or arbitrary version strings into externally visible diagnostics. Keep the required unsupported-version diagnostic bounded to validated version syntax. Audit smoke failure output too: `src/server/smoke.ts:54` and `src/server/client.ts:48` currently print arbitrary remote error text. Add reflected-token/raw-argument fixtures for connect-time and execute-time failures, including error data and SSE errors, and sweep exceptions, proxy replies, stderr and smoke stdout.

**Missing/incorrect test:** `test/upstream.test.ts:193` claims credential-free errors but its remote errors contain no token; `:203` actually requires copying their free-form messages. The e2e leak sweep covers benign demo responses only. Violates pins 4/8 and spec §9's upstream-secret boundary.

### F2 — P1: malformed upstream responses become successful evidence

**Location:** `src/upstream/contract.ts:107`, `:164`; related front fallback at `src/front/contract.ts:192`.

**Scenario:** A matching-id reply with `result: { resultType: "complete", content: "not-content", isError: "true" }` resolves to `{ content: [], isError: false }`. The pipeline then writes an `ok` outcome and the front answers success. A response with `jsonrpc:"1.0"` is also accepted, and `content:[null]` passes through. This manufactures successful results from invalid responses; it does not bypass the initial intent append, but it falsifies the execution outcome.

**Evidence:** The scratch root/pipeline probe returned `isError:false` with empty content and persisted `outcome.status:"ok"` for the malformed result. Independent probes accepted the wrong JSON-RPC version and invalid content block.

**Fix:** Validate the JSON-RPC envelope, exactly one result/error, matching valid id, result object, optional boolean `isError`, and supported content-block shapes before returning a ToolResult. Throw a value-free `UpstreamError` on malformed data. Likewise reject an invalid handler result instead of defaulting it to a successful empty result. Validate discovery/list envelopes and result types rather than admitting arbitrary partial shapes. Preserve the pinned fixed denial for unsupported interactive results.

**Tests:** Add malformed result/envelope cases through the real pipeline and assert an error outcome, never `ok`; assert invalid content never reaches the client. MCP's [base message contract](https://modelcontextprotocol.io/specification/2026-07-28/basic) supplies the wire shapes; the defect and recorded-success consequence were reproduced locally.

### F3 — P1: shutdown closes storage and exits before in-flight outcomes settle

**Location:** `src/front/contract.ts:204`; `src/server/main.ts:165`, `:168`, `:183`; test `test/e2e-slice-2a.test.ts:284`.

**Scenario:** An allowed call has a durable intent and is awaiting the upstream. SIGTERM destroys front connections, aborts upstream fetches and closes the ledger, without waiting for handler promises. The abort handler is still trying to append its error outcome when `stop()` resolves and `serverMain` calls `process.exit(0)`. With Postgres, ending the pool before that append is another way to lose the outcome. The ten-second timer is a maximum exit deadline, not a drain of pending work.

**Evidence:** An unchanged-root probe with a delayed outcome store reported `storeClosed:true, outcomeFinished:false` when `stop()` resolved. The outcome completed only afterward when the probe deliberately kept the process alive. The OS listener was replaced in memory because binding is prohibited here; this is lifecycle evidence, not a successful live SIGTERM test.

**Fix:** Track active handlers. Stop admitting requests, abort or finish upstream work as appropriate, await every admitted handler's outcome attempt within the grace period, then close the ledger and exit. Keep forced termination bounded and report whether the drain completed.

**Missing test:** The e2e launches `mcpPost()` and immediately sends SIGTERM without waiting for a persisted intent or an upstream-received-call latch. Its assertion can pass when the new call never enters the server. Use a deliberately pending upstream; wait for that exact call's intent and receipt, signal the proxy, then require its outcome. Repeat the real-process case twice after fixing. Violates pin 8/integration step 11 and the README's shutdown claim.

### F4 — P2: advertised custom MCP parameter headers are neither validated nor sent

**Location:** `src/front/contract.ts:169`, `:188`; `src/upstream/contract.ts:88`, `:142`.

**Scenario:** An upstream publishes `inputSchema.properties.tenant["x-mcp-header"] = "Tenant"`. The proxy advertises that annotation unchanged. A caller supplies `arguments.tenant="body-tenant"` but omits `Mcp-Param-Tenant` or sends `header-tenant`. The front still invokes the handler. The upstream client then omits the header entirely, so a conforming upstream rejects the forwarded call. Invalid header annotations are also included in the cached tool list.

**Evidence:** Both missing/mismatched-header probes returned HTTP 200 and invoked the handler; captured upstream request headers had no `mcp-param-tenant`.

**Fix:** Validate annotated tool definitions, omit invalid tools, derive/encode required headers from arguments in the upstream client, and validate recognized headers against their exact property paths at the front. Cover nested properties, absent/null values, integer/boolean encoding and case-insensitive header names. The [Streamable HTTP custom-header rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#custom-headers-from-tool-parameters) require client support and header/body validation. The five current demo schemas do not trigger this defect, which limits its immediate impact but does not make the advertised client conformant.

### F5 — P2: malformed request IDs, capabilities and Base64 headers reach execution

**Location:** `src/front/contract.ts:154`, `:156`, `:177`, `:218`.

**Scenario/evidence:** Separate scratch requests with `id:null`, `id:1.5`, and `clientCapabilities:[]` each returned 200 and invoked the handler. An encoded `Mcp-Name` with excess Base64 padding also decoded to the accepted tool and executed. `Buffer.from(...,"base64")` is permissive and generally does not throw on malformed encodings, so the catch does not provide the claimed strict validation.

**Fix:** Require a string or finite integer request id, validate capabilities as an object of the protocol's expected shapes, and use a strict Base64/UTF-8 decoder for sentinel headers. Reject before constructing IncomingCall. Also test unsupported-version headers that disagree with the body: line 174 currently answers `-32022` before detecting the mismatch at line 178; the binding pin orders header/body validation first.

**Tests:** Expand the status/code matrix with these cases and assert zero handler calls. The [MCP base protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic#requests) explicitly excludes null/noninteger request IDs. Header decoding must preserve unambiguous header/body agreement; see the [transport validation rules](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation).

### F6 — P2: initialize bypasses mandatory HTTP validation

**Location:** `src/front/contract.ts:160`; tests `test/front.test.ts:82`, `test/e2e-slice-2a.test.ts:212` (initialize case).

**Scenario:** Legacy initialize without the required HTTP metadata headers gets 404/-32601; even an initialize body paired with a conflicting modern Mcp-Method header takes the same shortcut. The diagnostic motivation does not justify skipping validation.

**Evidence:** Scratch request without both required headers returned 404/-32601. The primary [version compatibility matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#compatibility-matrix) explicitly says legacy-to-modern HTTP fails with 400 for missing headers. Its diagnostic recommendation permits naming supported versions in that error; it does not require a 404.

**Fix:** Restore validation before method dispatch. Include the supported version and useful initialize explanation in the validation error. Reserve 404/-32601 for an otherwise valid request using that unsupported method. Correct the two tests and README. This is the rejected flagged pin deviation.

### F7 — P2: SSE parser accepts incomplete events and waits past the terminal event

**Location:** `src/upstream/contract.ts:153`, `:182`, `:234`; test `test/upstream.test.ts:264`.

**Scenario:** EOF after a `data:` JSON response without its terminating blank line is treated as a completed event. Conversely, a fully framed terminal response on a stream that stays open is ignored until EOF, eventually timing out or failing on unrelated subsequent bytes. The spec only recommends stream termination; receipt of the terminal event is the useful completion boundary.

**Evidence:** The partial-SSE probe returned success. A ReadableStream containing a complete final event but no EOF stayed pending until explicit close produced `UpstreamClosed`.

**Fix:** Parse incrementally within the byte/deadline bounds, settle on the complete matching terminal event, and cancel/release the response reader. Discard pending, unterminated event data at EOF. Correct the test that currently asserts EOF dispatch as desired behavior, and add chunk-boundary/unterminated/open-after-terminal cases.

Sources: [MCP receiving messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#receiving-messages); [WHATWG event-stream interpretation](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation), which requires discarding an incomplete event at EOF.

### F8 — P2: a FIFO secret or private file hangs startup before type checking

**Location:** `src/secrets/contract.ts:54`; `src/server/files.ts:16`.

**Scenario:** A correctly named `demo.bearerToken` FIFO has no writer. `openSync(O_RDONLY | O_NOFOLLOW)` blocks before `fstatSync` can reject it as nonregular. The same pattern affects hmac/password/demo-token private-file reads. No JavaScript startup/shutdown timer can run while blocked in this synchronous open.

**Evidence:** A FIFO in a scratch secrets directory caused the child to hang until a two-second Perl alarm terminated it (exit 142), rather than throwing the promised file-type error. No real configuration was used.

**Fix:** Open nonblocking and retain same-fd regular-file/owner/mode checks before reading (and platform-appropriate equivalents). Avoid a separate check/open race. Add bounded child-process tests for FIFOs to both readers. Existing tests cover directories/symlinks but not this special-file case. This is an availability/refusal defect, not an execution authorization bypass.

### F9 — P2: the demo accepts inputs forbidden by its published schemas

**Location:** `src/server/demo-upstream.ts:25`, `:53`; generic front validation at `src/front/contract.ts:186` only checks object shape.

**Scenario/evidence:** The echo schema advertises `additionalProperties:false`. Calling the actual demo handler with `{message:"hello", unexpected:1}` succeeds. The front performs no schema validation; the demo only checks message type. Likewise `now`/`whoami` advertise no additional properties but ignore them. Invalid input therefore passes an explicit tool contract.

**Fix:** Validate supported published schemas before execution, or enforce the demo's small declared schemas directly and reject unsupported input shapes. Keep upstream schema validation bounded; do not fetch external schema references. Add tests for extra properties, wrong types and required fields. [MCP tools security requirements](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations) require input validation. This is distinct from F5's transport-envelope validation and does not imply the harmless demo has destructive effects.

### F10 — P2: tool invocations have no rate or concurrency bound

**Location:** `src/front/contract.ts:124`, `:190`; `src/upstream/contract.ts:146` tracks requests but imposes no admission limit.

**Scenario:** A valid client can start arbitrarily many allowed calls against a slow upstream. Each retains a handler, request/argument state, ledger work and an upstream request until its deadline. The 1 MiB and 4 MiB limits are per message, not aggregate capacity bounds. There is no rejection/backpressure mechanism for an overloaded proxy or demo server.

**Evidence:** Static control-flow review of front, root and upstream found no rate limiter, semaphore or bounded admission queue. This is not a measured load-test failure; no live network load was generated.

**Fix:** Add a bounded tool-invocation rate and concurrency policy, with a small/bounded queue or explicit rejection, releasing capacity on all failure/disconnect/shutdown paths. Add deterministic overload/recovery tests. [MCP tools security requirements](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations) call for invocation rate limiting; per-request timeouts do not supply it.

### F11 — P3: a test binds all interfaces despite the loopback-only test rule

**Location:** `test/front.test.ts:49`.

**Scenario:** The default-bind test starts a real listener with `bindHost:"0.0.0.0"`. On a normal unrestricted run that fake handler is reachable beyond loopback, contrary to the pins' hard test rule and the claim that these tests bind 127.0.0.1 only.

**Fix:** Assert the explicit all-interface option through a mocked listener/unit boundary; keep every actual test server on 127.0.0.1. The current environment denied binds before this behavior could be exercised on the wire.

## Decisions on Fable's seven flagged deviations

“Accept” here means accepted by this independent review for Package A, not a change to merge authority or a blanket approval of the package.

| Flagged deviation | Decision | Reason and limit |
|---|---|---|
| Demo upstream `naming:"tool"` option | **Accept** | The proxy must see raw upstream names to construct exactly `demo__echo`. Default exposure remains `server__tool`; lookup/collision checks still apply. This resolves the two uses of one front without parsing names. |
| `RunningFront.port` addition | **Accept** | Necessary to observe OS-assigned ephemeral ports; additive for consumers of `{stop}`. No authorization change. Keep the addition documented for implementations/mocks. |
| Wrong key yields HTTP 200 `isError:"unknown agent"`, not 401 | **Accept, narrowly** | The frozen front contract deliberately receives an unauthenticated IncomingCall and only the injected pipeline can resolve the key. Governed calls fail closed before any intent or upstream execution. Missing/malformed bearers still get 401. This does **not** mean discover/list authenticate keys: any syntactically valid bearer can read their metadata, as the pins' architecture allows. An authenticated-discovery/transport-401 requirement needs a coordinated contract change; do not claim it already exists. |
| Initialize answered before header checks | **Raise F6 (P2)** | Contradicts mandatory HTTP validation and the primary versioning matrix. A helpful supported-version diagnostic can accompany the required 400. |
| CC8.1 three relevant calls instead of four | **Accept** | The existing report excludes read calls; add/write, wipe/risky and whoami/unreviewed are the relevant three. Smoke repeats these, so the e2e's six rows when integrated are correct. No report change needed. |
| Shared client in `src/server`, re-exported from test helper | **Accept** | The built smoke program cannot import an omitted test directory. The helper path remains available. This accepts placement, not unchecked remote diagnostics (F1) or claims of independent interoperability. |
| Demo bind-host env and `file://` ledger URL | **Accept for the stated test use** | Loopback override enables safe tests; explicit file scheme enables the pinned jsonl e2e. There is no fallback from a failed Postgres connection to JSONL. The lab deployment must still select Postgres and use its database-enforced append-only boundary; file-backed smoke evidence does not prove that deployment property. |

## Validation and limitations

- Requested command attempted unchanged in the worktree: `perl -e 'alarm shift; exec @ARGV' 900 npm run check`. Typecheck passed; Vitest could not write through the existing `node_modules` symlink to the other checkout (`EPERM` in `.vite-temp`). No tracked worktree file was changed to work around it.
- Copied the tracked tree and installed dependencies into `/private/tmp/astra-2a-review/tree`, then ran the same wrapped check there. Unit result: **31 files passed, 4 failed; 1115 tests passed, 65 failed, 23 skipped; 11 unhandled errors**. The failed files were front, upstream, server and Slice 2a e2e; listener creation was denied (`listen EPERM 127.0.0.1`), causing front/server failures and upstream timeouts. A separate minimal Node loopback listener reproduced the environment restriction. These counts are not 65 established product defects.
- Since check stopped before later stages, ran wrapped `npm run build` and wrapped `npm run test:timing` separately in scratch: **build passed; 77/77 timing tests passed**. Typechecking passed in both check attempts.
- Scratch probes imported unchanged compiled sources and substituted only HTTP listener/fetch boundaries where necessary. They established F1–F7's stated functional results and the lifecycle race; the real filesystem/FIFO child established F8. A direct demo-handler probe established F9. F10/F11 are static findings. These probes do not establish socket framing behavior or actual Postgres pool behavior.
- Probe files/results: `/private/tmp/astra-2a-review/probes.mjs`, `probes.log`, `stream-probe.mjs`, `boundary-probe.mjs`, `boundary-probe.log`; check/build/timing logs are in the same scratch directory. Synthetic secrets stay there; this review contains no real credentials or raw private logs.
- Required live HTTP/real-process stability on two reruns could not be established under the current bind restriction. Run those after fixes in an environment that permits loopback. Do not count socket-denied tests as passes.
- The Package B channel enum remains the agreed integration seam. Existing shape tests for `none` pass with mock storage; actual JSONL round-trip/e2e denial assertions visibly skip or expect ledger-unavailable until the enum lands. This review neither reports that seam as a defect nor claims those integration assertions passed.
- The test seam probe catches **any** append failure as “enum not present”; after integration, require the no-channel round-trip and smoke PASS unconditionally so a later ledger regression cannot silently reactivate the temporary skip path. This is integration follow-through, not an extra finding against the known seam.

## Other focused checks

| Concern | Review result |
|---|---|
| Identity and intent before execution | Explicit projection removes credential from ToolCall. Missing/malformed bearer stops at front; unknown key stops in pipeline. A scratch forced intent-append failure returned `isError` with zero upstream calls. No pre-intent tool-forwarding path found. Discovery/listing at startup is not a tool invocation. |
| `none` channel | New branch constructs final no-channel approval, awaits intent append, attempts blocked outcome, then denies. No upstream call. Decide-only mode refuses this channel. B's validator seam is excluded as directed. |
| Credential isolation | Captured synthetic upstream requests used only the upstream secret; adding a client credential property to the call did not put it on the outgoing body. Redirects are refused. Error-channel leakage remains F1. |
| Upstream timeout, oversize, input_required | Additional fetch-boundary probes produced `UpstreamTimeout` (the real 30-second timer triggered promptly by the harness), `UpstreamError` for declared and streamed >4 MiB bodies, and a fixed `isError` result without interactive payload/state. No live timing claim is made from the accelerated timer. |
| Origin | POST /mcp checks exact configured Origin before body execution; invalid present Origin rejects, absent Origin is allowed by contract. Health/method routing follows the pinned ordering. No origin-based execution bypass found. |
| Front body caps and HTTP framing | Static review confirms 1 MiB collection limit, declared/streamed checks, bounded oversize drain (16 MiB / 5 s) and connection close. Node's normal HTTP parser is used without permissive parsing options. Existing front body test exercises a fetch body with known length; raw duplicate Content-Length, CL+TE, chunked oversize, fragmented bodies and pipelined-tail isolation need socket-level coverage. The bind restriction prevented independent raw-wire validation; no request-smuggling exploit is claimed. |
| Secret file checks | Same opened fd is checked/read, leaf symlinks refused, owner/writable bits checked, size bounded, map keys handled as data. Readable group/other bits for upstream secret files are permitted by the binding pin, so not reported as a new deviation. FIFO blocking is F8. |
| Composition environment | Required config/ledger/approvals enforced; NODE_OPTIONS presence refused without printing its value; HMAC length/private modes checked; startup awaits ledger head; userinfo password supplied from file and encoded. Postgres unavailable does not select JSONL. Actual pg parsing/lifecycle remains integration work; no Postgres validation claim here. |
| CLI --ledger | Allowed only on anchor/verify/report, postgres scheme checked, local anchors retained; usage/command failures do not print the supplied URL. Passing tests use injected ledger factories, so they are not proof of real Postgres connectivity/password handling. |
| Evidence/rendering | No report renderer modifications in range. Existing report/CLI suites passed. CC8.1 deviation is correct. Fake-success outcomes (F2) and dropped shutdown outcomes (F3) undermine evidence before rendering. |
| Smoke/e2e claims | Good exact tool-list, response/record and direct-upstream checks. The smoke result alone cannot prove “not executed”; e2e upstream logs provide that additional observation. Shared front/client implementations are not independent MCP interoperability tests. Error-leak fixtures, controlled in-flight shutdown and corrected conformance cases are missing as detailed above. |

## Sources checked during this pass

Primary pages re-read on 2026-10-03: [MCP 2026-07-28 base protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover), [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), and [WHATWG SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation). Specific supporting links accompany the relevant findings. MCP conclusions above are verified against those primary pages; the observed test/probe results are local evidence with their limitations stated.

Fix the three P1s before merge and add their regression tests. Address the P2/P3 items in the same fix pass where practical, then request one scoped independent verification of fixes and new regressions. Resolve remaining P2s under the established residual/todo process after verification. Do not merge or close the gate on this review alone.

GATE: FAIL
