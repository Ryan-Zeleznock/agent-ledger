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


Slice 1c Package B (pin-7 fixtures, `test/report-slice-1c.test.ts`):
- [x] ADR-010 optional report context and all five anchor statuses plus omitted context
- [x] Six ordered sections in HTML/PDF; CC6.1 and CC8.1 tool tables; CC7.2 heartbeat table
- [x] Session-without-heartbeat findings use all history; pre-1c records excluded; launch warnings and orphan intent gaps
- [x] Heartbeats excluded from tool/no-outcome counts and map only to CC7.2
- [x] Every pinned evidence class, exact manual-denial caveat, appended CSV columns
- [x] New-table HTML/CSV/PDF escaping, withheld-digest labels, repeated PDF table headers and fitting record blocks kept together
- [ ] Ryan independently spot-checks the AICPA page citations ([V] scope, [H] mapping remain distinct)
- [ ] Coordinator runs merged Slice 1c e2e steps 8–10 on a real CLI-generated sandbox pack after cross-review

Test-first evidence: pre-implementation focused run had 27 failing / 53 passing tests across the
new report and redaction cases; after implementation the report + redaction suite passed 101/101.


Fable review fixes (2026-10-03):
- [x] #1 denied policy/approval + ok outcome: amended class and summary/monitoring/CSV anomalies, including prior-range intent
- [x] #2 handoff + outcome without proxy is not an orphan; later proxy supersedes handoff
- [x] #4 unknown blocked cause keeps a blank class with an explicit Vocabulary explanation
- [x] #5 Unicode escapes never split on wrapped PDF text/heading/table boundaries
- [x] #6 reproduce the old split-block false positive; per-page record boundaries, xref/stream/page-reference checks
- [x] #7 heartbeat tool/server/rule consistency and visible mismatch findings
- [x] #8 DEMO lets report create its private output directory and moves saved anchor JSON afterward
- [ ] #9 duplicate phase compilation retained intentionally; safety rationale in report README

Reproduction: pre-fix `perl -e 'alarm shift; exec @ARGV' 900 npm run check` failed unit phase
with 16 failures / 979 passed / 7 skipped; #6 gap demonstrated by a split-block fixture that
passes the old assertion. #8 original mkdir reproduced as 0755 under umask 022. No finding disputed.
