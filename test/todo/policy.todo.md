# policy: implementation coverage

All local policy scenarios are executable in `test/policy.test.ts`, `test/registry.test.ts`,
and `test/suggestions.test.ts`: strict loaders, reserved/prototype keys, both builtin namespaces,
MCP name/impersonation/case-twin refusal, escalation validation and evaluation, own arguments,
unknown tools, trusted independence, regression names, proxy syntax/collision checks, and advice isolation.

The original TODO claiming `builtin:codex` is refused was superseded by the frozen ADR-005 contract.
The decision table now uses real loadRegistry/evaluate and asserts helper equality on every row.
The helper is retained as requested for parity and for hook/timing tests until Slice 1b implements them.
No policy-only server-mode items remain.
