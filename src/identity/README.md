# identity
Status: implemented

**Job:** Authenticate the agent and create sessions
**Depends on:** types, Node built-ins, yaml, shared configuration I/O (`src/config-file.ts`)
**Does NOT:** decide permissions or build ToolCall objects
**Spec:** docs/spec.md §4, §5, §9

`createIdentity("file", path)` synchronously validates and snapshots a static YAML or JSON
registry. Initialization throws on unreadable files, malformed schemas, unknown fields,
duplicate YAML keys, NFKC/case-twin agent ids, or duplicate `(kind, sha256)` credentials.
The version must be the literal integer `1`, not a string, alias, hex, float or exponent spelling.
On POSIX, the file must belong to `process.getuid()` and have no group/world-write bits
(`mode & 0o022`); use `0600` or `0644`. The shared reader checks the open descriptor it reads,
closing it on success or failure. POSIX owner/mode checks are skipped on Windows.
Recreate the service to reload configuration. Empty registries are valid and authorize nobody.
`createIdentity("postgres", target)` still throws `not implemented` (Slice 2).

The version-1 file has exactly these fields; each agent has one credential:

```yaml
version: 1
agents:
  - id: astra
    credential:
      kind: local          # local | api_key
      sha256: "<64 lowercase hex characters: SHA-256 of the credential value's UTF-8 bytes>"
```

JSON uses the identical shape. Compute `sha256` with Node's
`createHash("sha256").update(value, "utf8").digest("hex")`; the placeholder above must be
replaced with that digest. Raw credential values are neither stored in this file nor retained
by the service. No trimming or case folding occurs during authentication. Credential kind is
part of the lookup, so the same value under `api_key` cannot authenticate a `local` entry.
Unknown/malformed credentials reject with a generic error that never echoes their value.
YAML errors are also generic to avoid exposing accidentally pasted credentials.

`startSession(agentId, onBehalfOf?)` accepts only registered agents, creates an opaque UUIDv4,
and retains no per-session state: the frozen contract has no session lookup/end API.
Memory therefore stays bounded independently of session count; the regression creates 100,000
sessions in a supervised child and checks post-GC retained growth below 5 MB.
UUIDv4 uniqueness relies on Node's cryptographic randomness rather than an ever-growing set.
The optional attribution must be nonblank and at most 256 UTF-16 code units. It is caller-supplied
context, not authentication or authorization, and is not retained by this service.
The Slice 1b pipeline must copy `onBehalfOf` into ToolCall and explicitly project allowed fields
so credentials cannot enter ToolCall or ledger records; those integration tests remain deferred.

Due diligence, checked 2026-09-30:
- [V] [Node crypto docs](https://nodejs.org/api/crypto.html#cryptorandomuuidoptions) specify
  cryptographically generated UUIDv4; [createHash](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options)
  documents SHA-256 hashing. Tests cover exact digest resolution and 1,000 concurrent sessions
  across two instances. No id or metadata map is retained.
- [V] [YAML docs](https://eemeli.org/yaml/#tojs-options) document map conversion; this loader
  uses Maps, strict field projection, duplicate-key checks and disabled merge processing.
- [H] Provisioned API keys have high entropy. A SHA-256 digest is not password hardening;
  `local` credentials may simply identify a configured local principal. This file is trusted
  configuration for local visibility/best-effort gating, not proof against the machine's owner.
