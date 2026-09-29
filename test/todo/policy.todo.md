# policy: tests to write after Gate 2
- [ ] `loadRegistry` parses policies/tools.example.yaml and refuses: unknown version, unknown field, class outside read|write|risky, missing reviewedBy/reviewedAt, duplicate tool (YAML), escalation `to` not above the base class (write→write, risky→write)
- [ ] `evaluate`: unknown server → require_approval/unreviewed, ruleId `unreviewed:<server>/<tool>`; unknown tool on a known server → same
- [ ] `evaluate`: reviewed read → allow/read; write → allow/write; risky → require_approval/risky; ruleId `registry:<server>/<tool>`
- [ ] `evaluate`: escalateWhen with every argPattern matching raises write→risky and names `#escalate:<i>`; a partial match does not; a missing arg never matches; arguments never lower a class (`deploy_production({environment:"dev"})` on a risky row stays risky)
- [ ] `evaluate` ignores `trusted` (a trusted server's unreviewed tool is still unreviewed)
- [ ] regression rows (Astra round 2): `get_then_deploy`, `wipe_bucket`, `terminate_instance`, `push_to_main`, `deploy_production({environment:"dev"})` on servers/tools not in the registry → require_approval/unreviewed
- [ ] the registry table in test/registry.test.ts moves onto the real evaluate() and the test-only helper is deleted
- [ ] `suggestClass`: name pattern only for untrusted servers (annotations ignored even when present); annotations join for trusted servers; disagreement → higher class, both sources listed; no match → default (risky)
- [ ] `suggestClass` output is never written to the registry by any code path (reviewedBy is required and comes from a human)
