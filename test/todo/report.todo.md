# report: implemented tests (Slice 1b)
- [x] an empty range gives an empty report, not a crash
- [x] every record maps to at least one SOC 2 criterion
- [x] the CSV row count matches the records in range
- [x] `reconcileHandoffs` (spec v2.1, Astra 2026-09-30): a `handoff-to-proxy` record with a proxy intent record for the same callId → not flagged; a handoff with NO proxy record in the range + `HANDOFF_RECONCILE_GRACE_MS` → flagged as `UnreconciledHandoff` with callId, proxyServerName, hookRecordId, handedOffAt; a proxy record that lands 30 s after the range end is still matched (grace); a proxy record with no handoff is not a finding of this step
- [x] the generated report has an "unreconciled handoffs" section that is present and empty in a healthy range, and lists every flagged callId otherwise (a cancelled call and an alias that never reached the proxy are both visible)
- [x] the report states the trust boundary of the mode that produced the records (local = visibility + best-effort gating; server = enforcement) in its cover vocabulary, so an auditor never reads local-mode records as audit-grade enforcement evidence

Coverage: `test/report.test.ts` and `test/cli-process.test.ts`.

The frozen API has no deployment-mode or collector provenance field. Exports conservatively state
local visibility/best-effort gating and explain conditional server enforcement; they never infer it
from tool names. Handoff correlation uses non-handoff MCP intents; provenance attestation is a
future coordinated contract change, not a claim made by this implementation.
