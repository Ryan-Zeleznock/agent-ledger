# identity: remaining integration / server work

Implemented in `test/identity.test.ts`: unknown credential rejection; exact, kind-scoped
resolution from a validated YAML/JSON file; unique concurrent session ids; known-agent checks;
credential-free persistence/error messages; static snapshot behavior; malformed registry refusal.

- [ ] Slice 1b pipeline integration: onBehalfOf is carried to the ToolCall. Identity accepts and tracks attribution; the frozen IdentityService has no ToolCall projection or session-read API.
- [ ] Slice 1b pipeline integration: the credential never appears in the ToolCall the pipeline builds (explicit projection; also listed in pipeline.todo.md).
- [ ] Slice 2: implement and test the Postgres backend. Its explicit notImplemented behavior is tested today.
