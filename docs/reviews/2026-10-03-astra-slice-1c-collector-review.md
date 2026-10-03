# Astra review: Slice 1c, Package A

2026-10-03 · Reviewer: Astra, security-reviewer · Builder: Fable

**Verdict: GATE: PASS — no P1 found.** Five P2 findings (one explicitly pre-existing) and one P3 follow. PASS uses the role brief's rule, “FAIL iff any P1”; it does not mean the remaining defects or contract deviations are resolved, or that the entire suite completed green in this sandbox. Only Ryan merges/closes the gate.

**Scope and method.** One full defensive quality review of `1243ab6..4eb2200` (four commits), branch `slice-1c-collector`, HEAD `4eb220012c60a0eb3fa184b6f4594bad4d7572b5`. Reviewed all 23 changed files against `docs/slices/slice-1c-pins.md` pins 1–5 and 7, acceptance A, integration steps 1–7, and accepted ADR-010/ADR-011 in the vault; consulted spec §§3/7 for the trust boundary. Reviewed only Fable's changes as the submitted build. The extra report verification pass and the 3→5 assertion in the Slice 1b e2e are coordinator decisions, not findings. Package B rendering/redaction and integration steps 8–10 are outside this gate.

The worktree was clean at entry. Product source and existing tests were not edited; no commit was made. Fault injection and added review probes ran only in `/private/tmp`. No real agent configuration was read or changed. The vault's tracked `_state.md` and `research.md` were left untouched under the user's no-tracked-edits instruction; this report/run note carry the review evidence instead.

**Findings, ordered by practical impact.**

1. **P2 — The heartbeat probe's cap settles its promise but does not bound the hook process lifetime.**

   Location: `src/cli/main.ts:74`–`83`, especially `:77`; missing regression coverage at `test/cli-process.test.ts:187`.

   Scenario: a watchdog-side preload or broken entry point spawns a descendant inheriting its stdout/stderr. At three seconds the cap kills only the immediate watchdog PID and resolves `failed`. It neither closes/destroys the parent pipe handles nor deals with the descendant. Those handles keep the SessionStart CLI event loop alive after `main()` returns. `process.exitCode = 0` does not force termination. SessionStart can therefore wait until the descendant exits or the agent's larger hook timeout expires, despite the documented three-second cap.

   Reproduced both with a scratch replacement watchdog and with the **real compiled watchdog unchanged**. For the latter, a scratch `NODE_OPTIONS=--require=<sidecar.cjs>` preload launched a 15-second sidecar only when `process.argv[1]` ended in `/hooks/watchdog-main.js`; the sidecar inherited stdout/stderr and was unreferenced by its parent. A heartbeat with `nodeOptionsSet: true, watchdogCheck: "failed"` was persisted, but the CLI still had not exited at 6,005 ms. The review harness killed the CLI and sidecar; stdout/stderr were empty. This is a lifecycle/availability defect, not a claim of enforcement against an owner-controlled preload.

   Fix: make every probe terminal path release its stdin/stdout/stderr handles and process references; arrange bounded cleanup of probe-owned processes where possible, accounting for the watchdog's separately detached handler. Do not wait indefinitely for `close` after the cap. Add a real-process test with an inherited-pipe sidecar, asserting actual CLI exit 0 within cap plus a reasonable scheduling margin, empty stdout, and `watchdogCheck: "failed"`; clean up the test sidecar in `finally`. A loop-only watchdog test would not cover this failure.

   Node documents that `close` requires stdio closure and that multiple processes may share those streams. The reproduction confirms this on local Node 25.8.2. [Node child-process documentation](https://nodejs.org/api/child_process.html#event-close), checked 2026-10-03.

2. **P2 — Malformed watchdog output can produce a healthy heartbeat.**

   Location: `src/cli/main.ts:83`–`89`, especially `:86`–`87`.

   Scenario: an exit-0 watchdog emits this object:

   ```json
   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"},"unexpected":"unvalidated"}
   ```

   The self-test checks only two nested values. It accepts the missing `permissionDecisionReason` and the extra top-level field, despite pin 5 requiring a validated allow. In the private artifact copy this yielded a silent exit 0 and `watchdogCheck: "ok"` in 123 ms. The existing `validateHandlerOutput` correctly rejects exactly these bytes. A broken watchdog can thus be reported healthy when its protocol output is invalid. The health result does not itself authorize a tool, so this is P2 rather than a tool-decision fail-open.

   Fix: reuse `hooks.validateHandlerOutput(out, agent)` and require its validated decision to be `allow` in addition to exit 0. Track output overflow as an explicit failure rather than potentially validating a retained prefix. Add exit-0/malformed-output cases for missing reason, extra fields, multiple values and oversized output; assert `failed` and silent exit 0. The existing “broken one → failed” test only uses exit 1, which cannot detect this bug.

3. **P2 — Construction still reads watchdog duration, contrary to ADR-011's record-only contract.**

   Location: `src/pipeline/contract.ts:202`–`209`; the retained behavior is explicitly asserted in `test/pipeline.test.ts:133`–`140`.

   Scenario: construct a pipeline with `hookAgent: "claude-code"` or `"codex"`, Slack `timeoutMs: 300000`, no absolute deadline, and inherited `AGENT_LEDGER_WATCHDOG_DEADLINE_MS=25000`, solely to record an outcome/heartbeat. Construction throws `approval-not-below-deadline`, so the caller cannot record. Removing just the duration variable makes construction succeed. This was reproduced in the scratch review test. The CLI currently hardcodes hook-ask, so its new handlers do not hit this Slack-only branch.

   ADR-011 says construction no longer reads the deadline environment and that the timing checks run in `decide()`; record-only operations never consult it. The added explanation that a “static” duration check remains is not an accepted exception. The test currently pins the deviation rather than the ADR.

   Fix: remove the environment-dependent constructor check and leave the existing `deadlineGate()` validation for decisions. Test construction plus both recording methods with missing, past and incompatible inherited watchdog settings, under Slack as well as hook-ask. Decisions must still deny before identity/registry/append when their clock configuration is invalid. Update the retained init-time assertions/helper expectations at integration with the owner of the moved watchdog tests.

4. **P2 — `recordHeartbeat` differs from the accepted public signature.**

   Location: `src/pipeline/contract.ts:92`, implementation `:371`–`376`, caller `src/cli/main.ts:293`.

   Scenario: a caller following pin 3 and ADR-010 invokes `pipeline.recordHeartbeat(hb)`. TypeScript rejects it because this implementation requires a second `AgentCredential`. In untyped code the real identity implementation receives `undefined` and rejects, so no heartbeat is recorded. All added callers/tests supply the extra argument, hiding the contract mismatch. A compile-only scratch assertion confirms the one-argument call is a type error.

   Keeping credentials outside the stored heartbeat is correct. The binding one-argument pin also leaves their source underspecified; that is a specification issue to resolve explicitly, not permission to add a required argument silently. No accepted amendment or coordinator exception supplied for this review authorizes the two-argument method.

   Fix: reconcile the credential source and signature with the coordinator/ADR owner, then implement and test the accepted interface. Either obtain an explicit amendment for `(hb, credential)` or provide the agreed construction-bound credential route for `(hb)`; do not put credentials in `SessionHeartbeat` or skip identity resolution. Add a compile-time consumer test matching the approved signature. This is an integration/contract finding, not a credential leak in the current CLI.

5. **P2 — Public `decide()` still has a proxy-construction deadline bypass (pre-existing, not introduced by these commits).**

   Location: new gate `src/pipeline/contract.ts:237`, public method `:355`–`356`.

   Scenario: construct with a Slack channel and no `hookAgent`, then mistakenly call public `decide()` rather than `handle()`. `deadlineGate()` immediately succeeds with no deadline because the instance is classified as proxy mode. With successful Slack validation, a reviewed read produces `allow` even if the absolute deadline is absent or past. The public method does not reject proxy-mode use, unlike `handle()`'s guard against hook mode.

   Reproduced with the Slack validator mocked successful, consistent with the existing pipeline unit-test seam. **Limitation:** Slack validation is currently an unimplemented stub in production and denies calls, and the CLI always passes its validated `hookAgent`. Thus this is a latent public-API misuse path, not a demonstrated fail-open in the shipped pre handler. Inspection of `1243ab6` confirms the same mode distinction already existed; report it because the review explicitly requested no construction path to an allow without a deadline, not as a new regression.

   Fix: reject public `decide()` on a proxy-mode instance, or enforce its deadline independently of the shared internal routine; preserve deadline-free `handle()`. Add absent/past-deadline tests with omitted `hookAgent` and a successful mocked Slack validator, and retain a control proving `handle()` still works without watchdog clocks. This closes the gap without pretending proxy execution needs hook supervision.

6. **P3 — Several new test names claim more than their assertions establish.**

   Locations: `test/hooks-fixtures.test.ts:222`, `test/cli-process.test.ts:221`, `test/cli.test.ts:170`.

   The fixture test claiming to pin heartbeat constants and the denial error class checks event lists only. The process test claiming that “session-start + pre wrote first” directly appends a synthetic intent instead. The in-process test claiming that denied “chains a blocked outcome” deliberately denies pre without writing an intent, then correctly asserts an **orphan** outcome. These tests pass even if their named claims regress.

   Fix: rename the tests to describe their actual assertion boundaries, or exercise/assert their named behavior. Constants are genuinely checked in `test/types.test.ts`; a real heartbeat→pre→denied chain is genuinely checked in e2e step 3, so this is an accuracy/maintenance nit rather than an uncovered whole feature.

**Focus-area results and limits.**

| Area | Evidence and conclusion |
| --- | --- |
| SessionStart/denied stdout and exits | On valid invocation, success, malformed input, mismatched event, corrupt registry, missing/exposed key, probe exception and recording exception paths use no handler stdout and return 0. Fixed error messages omit parser/registry exceptions. Missing watchdog is recorded as `missing`. Codex+denied correctly remains usage exit 2. Actual process termination has finding 1's gap. |
| Pre deadline handling | The new gate runs before identity, registry projection and append for either configured hook agent. Scratch matrix confirmed absent/past deadlines deny under both hook-ask and Slack for both agents. Existing unit tests cover malformed deadline values and rereading the same instance. Real watchdog e2e preserves configuration-error exit 2. The proxy-shaped public-API exception is explicitly finding 5. |
| Anchor | Checks failed chain, genesis and changed head before writing; damaged tail becomes chain-failed. Real ledger bytes remain identical, canonical anchor output matches file bytes, re-anchoring appends, and head/ancestor/truncation behavior is asserted. Torn anchor refusal is unit-covered and delegated to the unchanged anchor module. Changed-head refusal is injected/unit-covered. This is a before/after-head check, not an atomic snapshot against an owner rewriting/restoring bytes; no stronger local trust claim is made. |
| Heartbeat and secrets | Explicit field projections exclude event display text, transcript path, cwd, model, title and NODE_OPTIONS value. Real CLI/e2e sweep covers raw hashed argument canaries, denial reason, credential, key hex and NODE_OPTIONS title canary across ledger/process output/pack. No secret leak found on reviewed application paths. Preload code or Node startup diagnostics before this program executes remain the documented owner-controlled launch-environment boundary. Findings 1–2 concern the probe. |
| `agentSessionId` | `toIncomingCall` adds it outside args; pipeline explicitly projects it; validator adds only the named optional bounded string. The real append→read→verify test covers heartbeat, two tool sessions and a copied outcome. Old records without the field remain accepted. |
| PermissionDenied | Maps to exactly blocked + `permission-denied:auto-mode`; raw reason is not retained. Real e2e asserts the outcome copies its intent's call/policy/session and is not an orphan. Unknown callId is intentionally an orphan. |
| Report seam | Shared anchor-state helper and optional fourth argument match pin 5/6. Unit tests assert all statuses and context; e2e asserts stdout ancestor and verified report output. Package A's three-argument report implementation still ignores the fourth argument by the staged pin; Package B/integration must render it. This is not a finding against A. |
| Snippet/trust boundary | Five events, only pre supervised, direct session-start/denied, absolute existing paths, empty matchers and shell quoting are asserted. Anchor note accurately requires an off-machine copy and disclaims enforcement. |

**Validation record.** All npm test invocations used `perl -e 'alarm shift; exec @ARGV' 900 npm test` (with selectors appended where shown). No tracked files were changed to obtain results.

- `npm run typecheck` in the requested worktree: PASS.
- Initial full-suite attempt in the worktree: could not start, because `node_modules` resolves into the other checkout and Vite's `.vite-temp` write was denied (`EPERM`). Log: `/private/tmp/astra-1c-review-test-1.log`. This is an environment limitation, not a failing unit assertion.
- Exported exactly `4eb2200` using `git archive` to `/private/tmp/astra-1c-review`, copied installed dependencies into that scratch directory, then ran the wrapped full suite. **1,090 passed, 7 skipped, 1 failed** across 30 files, 22.89 s. The sole failure was existing `test/hooks-watchdog.test.ts:299`, `spawnSync ps EPERM`. Log: `/private/tmp/astra-1c-review-test-2.log`. No product assertion failed; no all-green full-suite claim is made.
- Two reruns selecting `test/cli-process.test.ts test/e2e-slice-1b.test.ts test/e2e-slice-1c.test.ts`: **36/36 passed each**, 5.17 s and 5.19 s. Logs: `/private/tmp/astra-1c-review-process-repeat-{1,2}.log`. SessionStart e2e times: 243 ms on the full run, 199/202 ms on reruns.
- Two watchdog reruns selecting `test/hooks-watchdog.test.ts -t '^(?!.*the handler is its own process group leader)'`: **73 passed, 1 intentionally skipped each**. Only the known sandbox-blocked `ps` test was excluded; its assertion was not replaced or faked. Logs: `/private/tmp/astra-1c-watchdog-repeat-{1,2}.log`.
- Four added scratch characterization probes passed: retained Slack-construction behavior, proxy-mode `decide()` bypass with a successful mocked validator, both-agent/both-channel deadline denial matrix, and strict rejection of the malformed self-test payload. Log: `/private/tmp/astra-1c-review-probes.log`. A subsequent scratch `npm run typecheck` also passed, including the compile-only check that the pinned one-argument heartbeat call is rejected. The first scratch-probe compile attempt had a reviewer-fixture error (missing `ToolResult.isError`); corrected only that scratch fixture before rerunning. These characterization passes demonstrate the observations; they are not fixes.
- Real-process fault probes: `/private/tmp/astra-1c-review/probe-selftest.mjs` and `probe-preload.mjs`. The former recorded malformed output as healthy and reproduced inherited-pipe retention; the latter reproduced retention with the real watchdog unchanged. Disposable configs are under `/private/tmp/astra-1c-probes` and `/private/tmp/astra-1c-preload-probe`. Each hanging reproduction was terminated at six seconds and its sidecar explicitly killed. No product source was altered for these probes.

**Primary-source rechecks (2026-10-03).** [V] Claude Code's SessionStart stdout becomes context, and PermissionDenied has tool fields/reason and is specific to auto-mode denial rather than manual prompt denial. [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#sessionstart), [PermissionDenied](https://code.claude.com/docs/en/hooks#permissiondenied). [V] Codex SessionStart adds stdout to developer context and lists startup/resume/clear/compact sources. [Codex hooks reference](https://learn.chatgpt.com/docs/hooks). [V] Node's process/pipe lifecycle semantics support finding 1, as independently reproduced above. [Node child-process documentation](https://nodejs.org/api/child_process.html#event-close). The current Claude Code example shows `permission_mode: "auto"`; the checked-in fixture pins `"default"` from the earlier capture. The parser accepts either and the binding encoding follows the event name, so this documentation-example drift is not treated as a runtime finding.

**Handoff.** Fable should fix the probe defects, reconcile both ADR deviations, and address or explicitly track the pre-existing API guard gap; correct the three test titles/assertions. Follow with the single scoped verification pass on claimed fixes and new regressions. Re-run the unfiltered suite where `ps` is allowed before merge. Package B rendering and merged e2e steps 8–10 remain coordinator integration work.

GATE: PASS
