#!/usr/bin/env bash
# Dispatch Astra (Codex) with the team's fixed flags.
# Usage: codex-run.sh <worktree> <prompt-file> <out-file> [role]
#   role (optional): name of a brief in .claude/agents/ that Codex adopts, e.g. security-reviewer.
# Resume a session instead: CODEX_RESUME=<session-id> codex-run.sh ...
set -euo pipefail
# stdin is closed on every call: with an open non-TTY stdin, codex exec blocks on
# "Reading additional input from stdin..." forever (lost a 2 h review run, 2026-09-30).
wt="$1"; prompt_file="$2"; out="$3"; role="${4:-}"
vault="$HOME/Desktop/AgentLedger"
common_git="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)"
prompt="$(cat "$prompt_file")"
if [[ -n "$role" ]]; then
  prompt="Your role brief: read .claude/agents/${role}.md in this repo and follow it.

${prompt}"
fi
if [[ -n "${CODEX_RESUME:-}" ]]; then
  cd "$wt"
  exec codex exec resume "$CODEX_RESUME" -c model_reasoning_effort="${EFFORT:-high}" \
    -c sandbox_mode=workspace-write \
    -c "sandbox_workspace_write.writable_roots=[\"$common_git\",\"$vault\"]" \
    -o "$out" "$prompt" </dev/null
fi
exec codex exec -C "$wt" -s workspace-write --add-dir "$common_git" --add-dir "$vault" \
  -c model_reasoning_effort="${EFFORT:-high}" -o "$out" "$prompt" </dev/null
