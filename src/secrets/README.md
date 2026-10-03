# secrets
**Job:** Hand upstream credentials to upstream only
**Depends on:** types
**Does NOT:** log or return secrets to agents
**Spec:** docs/spec.md §4, 9
Status: implemented

## Slice 2a (Fable, 2026-10-03; pin 4)

`createSecretsProvider("file", dir)` is the server-mode provider. `dir` is read **once at construction**; every entry
must be a regular file named `<server>.<key>` (`SECRET_FILE_NAME_RE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)$/`; a
Kubernetes Secret key becomes a file of that name). `get(server)` resolves to a fresh `{ [key]: trimmed contents }`,
`{}` for a server with no entry (the consumer decides what absence means: `upstream` sends no `Authorization` header).
Values are held in a closure and never on the returned object. Refused at construction, with an error that names the
FILE and never a value: a name outside the pattern (dot files such as `..data` included), a symlink (opened with
`O_NOFOLLOW` and checked on the same fd; the error says `is a symlink; refused`), a non-regular file, a file not owned
by the process uid or group/world-writable (the `readConfigFile` rule), a file over `MAX_SECRET_FILE_BYTES` (64 KiB).

**Why symlinks are refused.** A Kubernetes Secret volume mounted directly presents every key as a symlink into a
`..data` directory, root-owned, mode 0644 ([V] `kubernetes.io/docs/concepts/configuration/secret/`, pins §0,
2026-10-03). Such a mount is therefore refused loudly; pin 8's staging initContainer copies the keys into a `Memory`
emptyDir as the app's uid with mode 0600 first, and the copy is what this provider reads. A failing file is named in
the start-up error so HOMELAB step 9 can point at it.

**Not implemented (2b):** `createSecretsProvider("env", …)` throws `not implemented: secrets.createSecretsProvider(env)`;
refresh after construction; `SecretRef` resolution for Slack tokens (arrives with the approvals module).

Tests: `test/secrets.test.ts` (parsing, isolation per server, read-once, closure-held values, symlink and name
refusals, permission/size refusals, prototype-named servers and keys as plain data, `env` stub).
