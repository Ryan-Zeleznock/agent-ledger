# policy: tests to write after Gate 2
- [ ] a table test with ≥20 calls and their expected verdicts
- [ ] the first matching rule wins (read-only beats risky-iam-change for `list_roles`; nonprod-deploy beats risky-prod-deploy)
- [ ] `deploy_production({})` (no environment) → require_approval via risky-prod-deploy
- [ ] defaultDecision applies, with all four fields, when nothing matches
- [ ] an unknown field, a missing defaultDecision, or a duplicate rule id refuses to load
