# agent-ledger (code repo)

Brain: read `~/Desktop/AgentLedger/_state.md` FIRST, then any open handoff addressed to you there.
Spec: `docs/spec.md`. Plan: `docs/superpowers/plans/`.

Rules:
- ADR-002: no business logic before Gate 2. Stubs throw `notImplemented`.
- Shared shapes live only in `src/types/`. Only `src/pipeline/` imports other modules.
- Log your session and handoffs in the vault, not here.
- `npm run typecheck && npm test` must pass before any commit.
