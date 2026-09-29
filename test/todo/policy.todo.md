# policy: tests to write after Gate 2
- [ ] a table test with ≥20 calls and their expected verdicts
- [ ] the first matching rule wins (risky-delete beats read-only for `get_and_delete_record`; risky-delete beats risky-prod-deploy's unless for `delete_deployment` in staging)
- [ ] `unless` semantics: the rule is skipped only when EVERY unless pattern matches; a missing arg never matches (`deploy_production({})` still requires approval)
- [ ] read tools never match a risky rule: `list_roles`, `get_policy`, `describe_iam_policy`, `get_deploy_status`, `list_payments`
- [ ] the verdict table in test/policy-file.test.ts moves onto the real evaluate() and the test-only helper is deleted
- [ ] `deploy_production({})` (no environment) → require_approval via risky-prod-deploy
- [ ] defaultDecision applies, with all four fields, when nothing matches
- [ ] an unknown field, a missing defaultDecision, or a duplicate rule id refuses to load
