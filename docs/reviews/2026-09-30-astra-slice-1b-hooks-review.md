**Astra — independent Slice 1b hooks/watchdog/pipeline review — 2026-09-30**

Reviewed branch `slice-1b-hooks`, HEAD `a49d690`, range `6ed6125..a49d690` (one commit), including every file in the request. This is the one full independent review, not a builder approval or merge authorization. No tracked file was modified and nothing was committed.

Read repository AGENTS.md/CLAUDE.md, vault operating rules and state/open Astra handoffs, `.context/slice-1b-interface.md`, spec §§3/5/6/7/8/9, ADR-009, implementations, tests, helpers and todo lists. The role file mentioned by vault rules (`.claude/agents/security-reviewer.md`) does not exist in this worktree; the explicit review brief governed the review. The coordinator's post-hook deadline shim and ledger-down denial of reads are accepted decisions, not findings.

**Result: two P1, five P2, one P3 findings. GATE: FAIL.**

1. **P1 — Proxy execution receives storage hashes instead of original arguments.** `src/pipeline/contract.ts:300` (origin: `:201`, `:226`, `:258`).

   `decideInternal` builds `rawCall` for policy, but every successful return exposes the projected storage `call`. `handle` passes that object to `upstream.execute`. A reviewed `github/list_repos` with `storeArgs: [owner]` and arguments `{owner: "acme", page: 2}` executes with `page: "hmac-sha256:738534870f545c0abe459f1c76e17aab3cd42205688327b347bbf6541d0a2d03"`. Any non-allowlisted execution argument is corrupted; a write's body, path or destination can become a digest. An empty storeArgs list hashes every argument. This contradicts pin 1's storage-only projection and spec §6's execution of the authenticated call.

   Reproduced against compiled product code with the real JSONL ledger and a capturing upstream. The not-yet-built Slack module was replaced with a successful contract stub, as in the existing proxy tests; this does not claim that the current Slack stub permits production execution. Existing `handle` coverage at `test/pipeline.test.ts:334` uses only the allowlisted `owner` argument and checks credentials/order, so it cannot detect this.

   **Fix:** keep separate authenticated execution and stored calls throughout the decision result. Execute the original argument snapshot, while intent/outcome records and safe approval previews use the storage projection. Preserve explicit credential-free field projection. Add read and approved-write tests containing non-allowlisted scalar, object and body arguments; assert exact raw upstream arguments and HMAC-only ledger values, and no execution while the intent append is pending or fails.

2. **P1 — Ambiguous Codex MCP names inherit another tool's clear-field permission before denial.** `src/pipeline/contract.ts:201` (before the ADR-006 branch at `:205`).

   The pipeline calls `clearArgFields(registry, incoming.server, incoming.tool)` before determining that a Codex MCP name is not an identity. For the documented collision `github_/list_repos` → `mcp__github__list_repos`, a registry row for the different raw identity `github/list_repos` with `storeArgs: [owner]` makes the attempted call's `owner` persist in clear. The call is correctly denied as unreviewed/non-proxied, but both its intent and blocked outcome have already received a projection authorized for the wrong tool. No allowlist for the actual raw tool authorized that disclosure.

   Repro: parse the Codex fixture with `tool_name: "mcp__github__list_repos"` and `tool_input: {owner: "synthetic-private-value-48293"}`, convert it through `toIncomingCall`, and decide with the registry above. Decision is `deny`, while the real JSONL file contains the complete synthetic value. The existing denied-Codex-MCP test checks policy/outcome but never checks its stored args.

   **Fix:** perform the Codex MCP routing decision before any argument allowlist lookup. All Codex MCP hook attempts, including non-proxied denials and proxy handoffs, must use an empty clear-field list; only the proxy may use the authenticated raw upstream identity's allowlist. Test both documented name-collision forms, asserting that neither intent nor outcome contains the synthetic clear value and that built-in/Claude Code allowlists still work.

3. **P2 — A final output-write failure does not kill the handler's process group.** `src/hooks/watchdog.ts:362` (the cleanup closure is stranded at `:228`; successful resolution at `:342`).

   A handler spawns a normal, non-detached child with ignored stdio, writes a valid allow and exits. `runWatchdog` resolves success once its pipes close. If `emitAndExit` then encounters EPIPE or a mode-switch/write failure, it exits 2 without any access to `killGroupOnce`. The still-running descendant remains in the original handler group and survives the deny. This is not the documented setsid escape.

   Real-process probe with the existing `epipe-stdout` harness returned `{exit:2, stderr:"watchdog:write:EPIPE", descendantAlive:true, groupKillAttempts:0}`. The probe killed its own child afterward. The agent-facing decision remains blocked, hence P2, but the explicit §7/contract promise to group-kill on every post-spawn failure is false. The checked todo includes write failures, whereas the process-group test table includes only loop, exit1 and junk.

   **Fix:** retain one-shot group cleanup until emission has succeeded, and invoke it for emitter failures without reusing a previously killed PGID. Add a real descendant plus EPIPE/mode-switch/full-pipe failure regression that asserts exit 2, exactly one group kill, and no surviving descendant. Do not change the frozen public contract without coordinating an amendment if the chosen design requires it.

4. **P2 — Successful short writes bypass the write deadline.** `src/hooks/watchdog.ts:165`.

   The positive-progress branch executes `continue` before checking elapsed time. A sequence of short successful writes can run beyond `budgetMs` and still return success; the clock is checked only after zero progress/EAGAIN. Deterministic probe: three one-byte writes each advance an injected clock by 600 ms, with `budgetMs = 1000`; `writeAllSync` writes all three bytes, reads the clock only once, and succeeds at 1800 ms. Thus the implementation does not enforce its advertised total write budget.

   Existing short-write tests use fast writes and do not test expiration while progress continues. The full-pipe test exercises the different, correctly bounded EAGAIN path. An agent timeout caused by excessive write time would discard a command-hook decision, but no actual external-agent timeout was reproduced here; the confirmed defect is the budget violation.

   **Fix:** check an absolute elapsed deadline around every write iteration, including positive progress, and use a monotonic clock for elapsed budgets. Keep one shared emission budget across both fds and fallback reporting. Add a slow-progress injected-clock test and a real-process emission test confirming bounded exit 2 on expiration.

5. **P2 — A fresh Codex post handler attaches its outcome to the proxy's intent instead of the hook handoff.** `src/pipeline/contract.ts:270` (append at `:287`).

   The normal combined-ledger sequence is hook handoff intent for callId C, proxy intent for C, proxy outcome for C, then the independently launched hook post handler. `findIntent` chooses the last intent with C without considering `handoff` or hook mode. Consequently the hook outcome copies the proxy's server, args and policy, losing its association with the hook handoff and duplicating proxy-attributed execution evidence. It also differs from same-process behavior, where the cache retains the handoff.

   Reproduced with the real ledger: after that sequence a fresh `hookAgent: "codex"` pipeline's final outcome had `policy.ruleId: "registry:github/list_repos"`, `call.server: "github"`, rather than the `handoff-to-proxy:<name>` policy. The existing handoff outcome test contains only the handoff, so its name promises a stronger case than it exercises. Real orphan outcomes were separately retained and the resulting ledger verified successfully.

   **Fix:** when resolving a Codex hook outcome, prefer that callId's hook handoff intent; ordinary built-in intents still use their matching intent. Proxy execution outcomes must retain their own intent attribution. Test the complete interleaving using fresh pipelines and a shared real ledger, plus a genuine orphan.

6. **P2 — Sensitive argument names lose their HMAC evidence at the ledger boundary.** `src/pipeline/contract.ts:174` (projection at `:201`; regression currently endorses the loss at `test/pipeline.test.ts:426`; description at `src/pipeline/README.md:13`).

   Projection creates the required digest, but the existing JSONL key redactor replaces it with `[REDACTED:key:password]` for an argument named `password` (and similarly for other sensitive names). Two calls with different password values persist exactly the same placeholder, so an auditor with the key cannot verify either value. Confidentiality is preserved, but pin 1 and ADR-009 require every non-allowlisted field to retain its `hmac-sha256:<hex>` evidence; they do not exempt sensitive field names. The README documents the loss, but it is not one of the two coordinator exceptions authorized in this review.

   Reproduced with a real JSONL ledger, an unreviewed tool and two synthetic password values. Both stored args were `{password: "[REDACTED:key:password]"}`. The existing test explicitly expects that placeholder despite its title claiming HMAC survival.

   **Fix:** coordinate the pipeline/ledger boundary so validated projected digest values survive the backup redaction layer, while clear fields continue to be redacted. Avoid a broad exemption that would pass arbitrary raw sensitive strings. Replace the placeholder assertion with exact independently computed digest assertions for several sensitive names, distinct values and keys. If discarding this evidence is intentional, resolve the pin/ADR deviation explicitly instead of asserting conformance.

7. **P2 — Conflicting duplicate decision members are silently accepted as allow.** `src/hooks/watchdog.ts:101`.

   `JSON.parse` discards earlier duplicate members before the exact-key checks run. The handler payload below exits the real watchdog with code 0 and is re-emitted as a plain allow:

   ```json
   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecision":"allow","permissionDecisionReason":"r"}}
   ```

   This is ambiguous decision data from a malfunctioning handler, not two separate JSON values; the current multiple-output tests do not cover it. The boundary accepts a contradictory deny/allow instead of failing closed. This is P2 because a compromised handler can already emit an ordinary allow; the defect is missing defensive validation, not a newly demonstrated authorization bypass by an untrusted caller.

   **Fix:** reject duplicate object members before information is lost, including duplicate top-level `hookSpecificOutput` and escaped-equivalent key names. A small bounded tokenizer for this narrow schema can preserve legal whitespace and key ordering; do not require byte-canonical handler output, which the contract intentionally accepts in arbitrary order. Add real-process and unit tests for both duplicate orders, duplicate top-level blocks and escaped keys; all must exit 2.

8. **P3 — The allow-path process test never runs its descendant cleanup.** `test/hooks-watchdog.test.ts:263` (helper children at `test/helpers/hooks-handler.ts:83`).

   The helper writes its child PIDs to handler stderr, but successful watchdog results deliberately return `stderr: ""` (`src/hooks/watchdog.ts:342`). Therefore `pids(r.stderr).slice(1)` is empty and the cleanup loop does nothing. Each suite run leaves two ordinary 60-second Node sleepers; repeated flakiness runs accumulate them temporarily. The test correctly checks that the watchdog did not signal the group, but its comment claiming the sleepers were cleaned up is false.

   **Fix:** record owned descendant PIDs through an independent temporary PID file or harness trace, assert the expected count, and clean them in `finally`, including assertion-failure paths. Verify they are gone. Keep the intentional assertion that a successful allow does not signal the group.

**Validation and review evidence**

- `npm run typecheck` passed.
- The exact requested `npm run typecheck && npm test` was attempted. Vitest's default config bundler could not write `node_modules/.vite-temp` because the worktree's node_modules resolves into a directory outside the writable sandbox. This was infrastructure, not a product test failure.
- `npm test -- --configLoader native`: 924 passed, 6 skipped, one failed (`ps` execution blocked with EPERM in the actual-PGID assertion).
- Required two additional real-process watchdog runs, both with the native loader: each 70 passed / one identical sandbox-only `ps` failure; durations 19.61 s and 20.12 s. No additional failure or observed flakiness in the other cases.
- Final full validation: `PATH="/private/tmp/astra-slice1b-review/bin:$PATH" npm run typecheck`, then the same PATH with `npm test -- --configLoader native`: **25 files passed, 925 tests passed, 6 skipped**, 21.80 s. The temporary `ps` adapter accepts only `-o pgid= -p <pid>` and calls the real OS `os.getpgid(pid)`; it does not mock the PGID, change the test, or weaken its equality assertion. The unadapted command's limitation is retained above rather than reported as a native green run.
- Scratch probes and artifacts live only in `/private/tmp/astra-slice1b-review/`: `pipeline-probe.mjs`, `watchdog-probe.mjs`, `child-handler.mjs`, `extra-probe.mjs`, adapter, synthetic JSONL ledgers and trace. The first pipeline probe initially could not load parameter-property TypeScript through Node's strip-only loader; the successful probes use the suite's compiled product output. No product source was replaced; only the explicitly unimplemented approval dependency was stubbed for the proxy contract probe.
- Logs: `/private/tmp/astra-hooks-review-tests.log`, `/private/tmp/astra-hooks-review-tests-native.log`, `/private/tmp/astra-hooks-watchdog-rerun-1.log`, `/private/tmp/astra-hooks-watchdog-rerun-2.log`, `/private/tmp/astra-hooks-review-tests-adapted.log`.

**Boundaries that held in reviewed code/tests**

The actual watchdog runtime graph is `watchdog-main` → `watchdog` → Node built-ins only; its HookAgent import is type-only. Handler stdout is captured and reserialized, never forwarded byte-for-byte. Exit/nonzero/signal/spawn/config/init/empty/junk/extra-key/overflow failures deny, Codex ask is denied both by formatting and watchdog validation, the watchdog waits for close after exit, and stdin/pipes-open deadlines work. Group-kill tests cover the ordinary runtime failures; finding 3 identifies the missing emission phase.

Identity credentials are projected out of ToolCall and stored records. For ordinary identity-resolved calls, policy sees raw args, HMAC keys shorter than 32 bytes are refused, the key is copied, own `__proto__` fields remain data, and non-allowlisted values use keyed canonical JSON digests before the caveats in findings 2 and 6. Intent append is awaited before allow/ask/upstream execution, including approved calls and proxy handoffs; append rejection denies. Genuine orphan outcomes are retained. Codex non-proxy attempts deny and proxy handoff intent append failure denies. External Slack transport, heartbeat and replay buffering remain explicitly unimplemented; they were not treated as newly introduced defects.

The parser validates supported event/core shapes, refuses the specified cross-agent markers and non-object call arguments, and tolerates unrelated future fields. Optional post duration values are filtered before outcomes. No parser forward-compatibility defect against the specified supported events was established.

**Primary-source verification (read 2026-09-30)**

Claude Code documents that PreToolUse exit 2 blocks regardless of stdout; valid deny JSON supplies its blocking reason. Other exit codes can still apply valid JSON, so exit 1 does not always mean continue. A timed-out command hook discards output and does not block. Allow/deny/ask use `hookSpecificOutput.permissionDecision`; post events cannot undo execution. The implementation's conservative exit-2 policy agrees with these rules. Source: [Claude Code hooks reference — exit codes](https://code.claude.com/docs/en/hooks#exit-code-output), [timeouts](https://code.claude.com/docs/en/hooks#timeouts), [PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).

Minor documentation corrections to include while fixing: `src/hooks/README.md:14` still says the proxy hook writes no record and `:20` omits the valid-JSON exception for exit 1. `test/todo/pipeline.todo.md:14` checks off the obsolete “ledger.append is NOT called” statement while `:21` checks off the required handoff append. The new implementation follows the latter; reconcile the contradictory text. These were not counted as additional gate findings.

The vault's tracked `_state.md` and `research.md` were intentionally not edited because the explicit no-tracked-file instruction takes precedence over the usual vault session-update protocol. This report, the requested open review handoff and the run note are untracked. Only Ryan merges or closes the project gate.

GATE: FAIL
