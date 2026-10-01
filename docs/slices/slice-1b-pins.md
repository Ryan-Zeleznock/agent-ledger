# Slice 1b step B: interface pins between the two builders (coordinator, 2026-09-30)

Both builders code against these. Neither edits the other's folders. If a pin is wrong, STOP and say so in your
final report; do not silently diverge.

## Ownership (disjoint)
- Fable (branch `slice-1b-hooks`, worktree ~/agent-ledger-fable): `src/hooks/**`, `src/pipeline/**`,
  `test/hooks*.test.ts`, `test/pipeline*.test.ts`, test helpers/fixtures it adds under `test/helpers/hooks-*`,
  `test/todo/hooks.todo.md`, `test/todo/pipeline.todo.md`. Also the ONE contract amendment in pin 1.
- Astra (branch `slice-1b-cli`, worktree ~/agent-ledger-astra): `src/cli/**` (new), `src/report/**`,
  `test/cli*.test.ts`, `test/report*.test.ts`, `test/todo/report.todo.md`, `docs/DEMO.md`, `package.json`
  (scripts/bin only), `tsconfig.build.json` (new).
- Nobody touches: `src/types/**` (except pin 1 is NOT in types), `docs/spec.md`, other modules' implementations.

## Pin 1: HMAC key reaches the pipeline (ADR-009 amended; authorized contract change)
`src/pipeline/contract.ts` `PipelineDeps` gains ONE required field:
    argsHmacKey: Uint8Array;   // the per-ledger key, >= 32 bytes; createPipeline throws if shorter
The pipeline projects `ToolCall.args` into the stored record args: fields listed by
`policy.clearArgFields(registry, server, tool)` are kept in the clear (redaction still runs on them, defense in
depth); every other top-level field is replaced by `"hmac-sha256:" + hex(HMAC-SHA256(key, JCS(value)))`.
Unreviewed tools: no clear fields. Fable writes this amendment + tests; Astra only passes the key in.

## Pin 2: key file and local layout (Astra's `init` creates; Astra's `hook` reads)
`agent-ledger init [--dir <d>]` (default `./.agent-ledger`) creates: `registry.yaml` (reviewed registry, starts
from `policies/` examples), `agents.yaml` (identity file backend), `ledger/` dir, `hmac.key` (32 random bytes,
mode 0600, refuses to overwrite), local credential file (0600). Exact names are Astra's call; document in
`src/cli/README.md`.

## Pin 3: the watchdog entry point (Fable ships it)
Fable ships `src/hooks/watchdog-main.ts`, importing only node built-ins (and nothing from this package except
what the static-import test allows; if runWatchdog lives in contract.ts with package imports, split it so the
entry stays built-ins-only). CLI:
    node <dist>/hooks/watchdog-main.js --agent <claude-code|codex> --deadline-ms <n> --timeout-s <n>
        [--max-output-bytes <n>] -- <handler argv...>
It reads the hook event from its stdin, spawns the handler (no shell), and writes/exits per `WatchdogResult`.
It is used for PreToolUse only.

## Pin 4: the handler (Astra's `agent-ledger hook`)
    node <dist>/cli/main.js hook --agent <claude-code|codex> --event <pre|post> [--dir <d>]
- pre: stdin → `hooks.parseHookInput` → `hooks.toIncomingCall(ev, cred, agent)` → `pipeline.decide` →
  `hooks.formatPreToolUseOutput` on stdout, exit 0. Any throw → non-zero exit (the watchdog turns it into deny).
  `createPipeline({ identity, registry, ledger, upstream: <decide-only stub that throws if executed>,
  approvals: { kind: "hook-ask" }, hookAgent: agent, argsHmacKey })`.
- post: stdin → parse → `hooks.toOutcome` → `pipeline.recordOutcome(tool_use_id, outcome)`; prints nothing,
  exit 0 even on failure (post hooks never block; errors to stderr). Registered WITHOUT the watchdog.
- `install-hooks --print` prints the Claude Code `settings.json` `hooks` snippet (PreToolUse via watchdog with
  `timeout` = HOOK_TIMEOUT_S and deadline DEFAULT_DEADLINE_MS; PostToolUse + PostToolUseFailure direct) using
  absolute paths. It NEVER writes any settings file.

## Pin 5: build
Astra adds `tsconfig.build.json` (extends tsconfig, emits `src` → `dist/`, noEmit false) and `npm run build`.
`dist/` is gitignored. `bin: { "agent-ledger": "dist/cli/main.js" }`. No new runtime dependencies without
flagging it in the final report (prefer a small dependency-free PDF writer for text/tables).

## Gates for both
`npm run typecheck && npm test` green before every commit; test-first; flip your module README to
`Status: implemented` when done; commit on your branch only; never merge; never touch ~/.claude or any real
agent config.

## Resolved during the slice
- Pin 4 vs pipeline contract (Fable, 2026-09-30): post runs without the watchdog, so the frozen contract's
  WATCHDOG_DEADLINE_AT_ENV check would refuse construction. Coordinator chose option (a): the CLI post handler sets
  the variable itself. Open for Ryan: an ADR for a recordOutcome-only construction path, which would remove the shim.
