# agent-ledger (code repo)

Brain: read `~/Desktop/AgentLedger/_state.md` FIRST, then any open handoff addressed to you there.
Spec: `docs/spec.md`. Plan: `docs/superpowers/plans/`.

Rules:
- ADR-008 (supersedes ADR-002): building is ON. Implement modules test-first against the frozen spec (tag `spec-v2.1`). Contracts and signatures are frozen: changing one needs an ADR. When a module is done, add the line `Status: implemented` to its README.
- Two builders, Fable (Claude Code) and Astra (Codex), each on their own branch/worktree and owning disjoint modules. The one who didn't build a piece reviews and secures it. Only Ryan merges.
- Shared shapes live only in `src/types/`. Only `src/pipeline/` imports other modules.
- Log your session and handoffs in the vault, not here.
- `npm run typecheck && npm test` must pass before any commit.
