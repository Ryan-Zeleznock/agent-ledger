# server
**Job:** Server-mode composition root (ADR-013, Slice 2a pin 8): env → registry → identity → hmac key → secrets → ledger → upstreams → pipeline (`approvals: none`) → front; plus the demo upstream (pin 6) and the smoke client (pin 8) in the same image
**Depends on:** every module, by injection at this root only (`pipeline` is still the only module that imports other modules at call time; this root wires them)
**Does NOT:** decide anything about a call (the pipeline does), read `~/.claude`, touch the cluster, or log a URL, key, token, password or argument
**Spec:** docs/spec.md §3, 4, 7, 9 · ADR-012 · ADR-013
Status: implemented

## `main.ts`: `node dist/server/main.js`

**Environment (nothing else is read):** `AGENT_LEDGER_CONFIG_DIR` (directory with `registry.yaml`, `agents.yaml`,
`upstreams.yaml`, `hmac.key`, `ledger.password`, `secrets/`), `AGENT_LEDGER_LEDGER_URL` (`postgres://user@host:port/db`
WITHOUT a password: the root reads `ledger.password` and inserts it `encodeURIComponent`-ed, so `@`, `%`, `:`, `/` in a
password are safe and `pg` decodes them; a URL that already carries a password is refused. `file:///abs/records.jsonl`
selects the jsonl backend, which is how `test/e2e-slice-2a.test.ts` runs the real binary without Postgres),
`AGENT_LEDGER_PORT` (default 8787; `0` = ephemeral, logged), `AGENT_LEDGER_BIND_HOST` (default `0.0.0.0`: the one place
that address is chosen, on purpose; tests pass `127.0.0.1`), `AGENT_LEDGER_ALLOWED_ORIGINS` (comma-separated; empty = no
browser origin), `AGENT_LEDGER_APPROVALS` (must be `none` this slice; ADR-012). `NODE_OPTIONS` defined at all → refuse
(spec §7 launch-environment residual; the Kyverno policy forbids it as well).

**Files.** `registry.yaml` through `policy.loadRegistry`; `agents.yaml` through `identity.createIdentity("file")` (holds
the api_key SHA-256 only); `hmac.key` exactly 32 raw bytes; `ledger.password`; both private files are read with
`readPrivateFile` (`files.ts`: `O_NOFOLLOW`, regular, owned by this uid, mode 0600/0400, size cap; errors name the file);
`secrets/` through `secrets.createSecretsProvider("file")`; `upstreams.yaml` (`version: 1`, `upstreams: [{ name,
transport: http, url }]`, unknown fields refused) through the shared `readConfigFile`/`parseConfigDocument`. A Kubernetes
Secret volume mounted directly is root-owned symlinks and is refused loudly: pin 8's `stage-config` initContainer copies
everything into a `Memory` emptyDir as uid 65532 with mode 0600 first; a start-up refusal prints WHICH file failed and why,
never its contents (HOMELAB step 9's verify line).

**Start order and refusals.** Any failure logs ONE JSON line `{ ts, event: "refused", reason }` and the process exits 1
with no stack trace. The reason is redacted against the ledger URL, the password (raw and encoded) and the URL with the
password, longest match first. `ledger.head()` is awaited before anything listens: an unreachable database refuses the
start. Logged on success: `{ event: "ledger", backend, head }`, `{ event: "upstreams", servers, tools }`,
`{ event: "listening", port, bindHost, approvals: "none", allowedOrigins }`.

**Per-call log line** (stderr, pin 8): `{ ts, callId, agentId?, server, tool, verdict?, ruleId?, status, ms }`, nothing
else: no args, no credential, no token, no URL. `agentId`, `verdict` and `ruleId` come from observing the pipeline's
intent record on its way to the ledger (noted BEFORE the append, so a refused append still names the rule); `status` is
the outcome record's status (`ok` | `error` | `blocked`), or `denied` when the pipeline denied without an outcome (unknown
agent, malformed call, a refused intent append), or `exception` when `handle` threw (the front answers `500`). Requests
rejected before a call exists (401, 400, 405) carry no callId and are not logged this slice; `front` logs nothing.

**Shutdown.** `SIGTERM`/`SIGINT` → `front.stop()` → `upstream.close()` → the ledger's `close()` when the backend has one
(B's Postgres pool; duck-typed because `LedgerStore` has no `close`) → `{ event: "stopped" }` → exit 0; a hard timer exits
0 at `SHUTDOWN_GRACE_MS` (10 s) with `{ event: "shutdown-timeout" }`. A call in flight finishes its outcome record or
its `error` outcome inside the grace (e2e step 11).

## `demo-upstream.ts`: `node dist/server/demo-upstream.js` (pin 6)

The harmless upstream, built on the same `front` with `naming: "tool"` (raw names, so the proxy sees `echo`, not
`demo__echo`; see `src/front/README.md`). Server name `demo`, tools `echo { message }`, `now {}`, `add { a, b }`, `wipe {
target }` → `"nothing was wiped: demo tool"` (REVIEWED AS RISKY in the registry so the no-channel deny is demonstrable),
`whoami {}` → `"demo upstream"` (deliberately NOT in the registry → `unreviewed`). The handler accepts only
`credential.value === <token>` (constant-time compare over equal-length buffers; wrong → `isError` `"unauthorized"`; a
missing bearer is already the front's `401`). The token comes from `AGENT_LEDGER_DEMO_TOKEN_FILE` (`readPrivateFile`,
never argv); `AGENT_LEDGER_DEMO_PORT` (3001) and `AGENT_LEDGER_DEMO_BIND_HOST` (`0.0.0.0`; tests `127.0.0.1`, an additive
variable, flagged). It is the credential boundary of the demo: Claude Code holds the proxy key, only the proxy holds this
token, and the NetworkPolicy (pin 10) makes it unreachable from anything but the proxy. One JSON line per call on stderr
(`{ event: "call", tool, status }`: no args, no token), so "the upstream's own log shows NO call" is checkable.

## `smoke.ts`: `node dist/server/smoke.js --url <proxy mcp url> --key-file <path> [--expect-upstream-401 <upstream url>]`

Runs the pin 8 sequence against a live proxy and prints one line per check, then `SMOKE PASS` (exit 0) or `SMOKE FAIL
<check>` (exit 1): discover lists `2026-07-28` → `tools/list` is exactly the five `demo__*` names, sorted → `demo__echo`
`{ message: "hello" }` ok → `demo__now` ok → `demo__add { a: 2, b: 3 }` = `5` → `demo__wipe` is `isError` with
`PROXY_NO_CHANNEL_REASON` → `demo__whoami` is `isError` naming `unreviewed` → a request with no bearer → `401` → a
well-formed WRONG key → `isError` "unknown agent" (the front does not authenticate; identity does, in the pipeline; pin 8
says "wrong key → 401", which only a missing or malformed bearer produces; flagged) → missing `Mcp-Name` → `400`
`-32020` → `GET /mcp` → `405` → optional: the upstream URL with no token → `401`, and with the PROXY key → `isError`
`"unauthorized"` (the agent's key is not the upstream's credential, spec §9). The key file is read plainly (the
integration Job mounts it read-only from the Secret; it is a client, not the credential boundary) and never printed.
Used by B's integration Job (pin 12) and by Ryan from the Mac.

## `client.ts`

The raw 2026-07-28 client over `fetch` the smoke client and the tests share (`test/helpers/mcp-client.ts` re-exports it;
the pins placed it under `test/helpers/`, but `dist/server/smoke.js` cannot import `test/`). Every knob exists so a test
can send a deliberately wrong request (missing header, old version, no `_meta`, raw body, GET).

Sources re-read 2026-10-03: MCP 2026-07-28 transport/versioning/discover/tools pages (see `src/front/README.md`,
`src/upstream/README.md`); node-postgres connection strings decode percent-encoded userinfo ([H] until B cites the
"connecting" page in `src/ledger/README.md`; the Postgres e2e run is the check).

Tests: `test/server.test.ts` (in-process root + demo upstream over a jsonl `file://` ledger: order of start-up log
lines, five names, allowed calls recorded with clear/hashed args, wipe/whoami never reach the upstream, wrong key denied
with no record, direct upstream call with the agent's key refused, pinned per-call log keys, refusal matrix with
leak checks, Postgres URL password encoding and redaction, demo handler and `demoMain`); `test/e2e-slice-2a.test.ts`
(real processes from a private build root, steps 1-12 of the pins' integration seams; `smoke.js` PASS/FAIL).
