# secrets: tests to write after Gate 2

Converted on 2026-10-03 (Fable, Slice 2a pin 4) in `test/secrets.test.ts`. The original three items were written for an
`env` provider; server mode ships the `file` provider (Kubernetes Secret keys staged as `<server>.<key>` files), so they
are ticked against it and the `env` form is a 2b item.
- [x] ~~env provider~~ file provider returns only the named server's secrets (`get("demo")` never carries `github`'s keys; `{}` for an unknown server)
- [x] a missing secret is a clear, value-free outcome: `get` resolves `{}` (the consumer decides; `upstream` sends no bearer); a malformed secrets DIRECTORY (bad file name, symlink, unsafe mode/owner, oversized, subdirectory, not a directory) throws at construction naming the file
- [x] secrets never appear in thrown error messages (every refusal path checked against canary values), nor on the provider object (`JSON.stringify(provider) === "{}"`)
- [x] symlinks refused with `O_NOFOLLOW` (a directly mounted K8s Secret volume is all symlinks; pin 8 stages it first)
- [x] read once at construction; prototype-named servers/keys are plain data
- [ ] 2b: `createSecretsProvider("env", …)` (currently `not implemented`); refresh after construction; `SecretRef` resolution for the Slack tokens
