# report

Status: implemented

Exports a local evidence pack without writing to the ledger: `report.html` for the live demo,
`report.pdf` for sharing, and `records.csv` with one row per selected record. The frozen
`ReportFiles` return value remains `{ pdfPath, csvPath }`; HTML is always `outDir/report.html`.
Depends on types, the ledger's read contract, and Node built-ins. No new dependencies.

## Evidence and criteria

Read by **Astra on 2026-09-30** against AICPA's **2017 Trust Services Criteria (with Revised Points of Focus — 2022)**:
[AICPA publication page](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022).
The publisher's download requires an account. The primary document itself was read via this
[mirror of the AICPA PDF](https://gccertification.com/wp-content/uploads/2024/06/AICPA-TSP-Section-100-Trust-Services-Criteria-2022.pdf),
printed pages 33, 39 and 44 (PDF pages 34, 40 and 45). Fable could not retrieve the mirror during
independent review (403), so page-level confirmation remains Astra-only pending Ryan's spot-check
(review residual #10). These are paraphrases, not quotations:

| Criterion | Verified scope [V] | Our candidate evidence mapping [H] |
| --- | --- | --- |
| CC6.1 | Logical access protections for information assets. | Agent/session identity, policy rule, risk and verdict; allowlist decisions. |
| CC7.2 | Monitor component operations for anomalies and analyze potential security events. | Every record's chain links; whole-ledger verification; missing handoffs, orphan outcomes, unobserved outcomes. |
| CC8.1 | Controlled changes, including authorization, development, documentation, testing, approval and implementation. | Writes, risky/unreviewed attempts, asks, approvals and denials with the recorded approver, reason and time. |

[V] The document's notice (printed page 2) says the 2022 points-of-focus revisions did not change
the criteria. [H] Auditor acceptance of this pack and applicability of individual tool actions to a
customer's controls remain unverified. We do not claim certification, a SOC 2 opinion, complete
control coverage, or proof of production changes from a Bash call. Handoff records map only to
CC7.2: their placeholder allow/unreviewed policy is not a second access/approval decision.

## Range, verification and anomalies

- Range endpoints are explicit-offset RFC 3339 instants, inclusive, compared against `writtenAt`.
  Invalid dates, reversed ranges, negative/noninteger grace and overflow are rejected.
- `ledger.verify()` covers the **whole ledger**, not just the selected range. Its result, checked
  count, broken record (if supplied), and observed head appear in HTML/PDF and the CSV rows.
  A readable hash-broken ledger produces a prominently failed pack; structurally unreadable data
  fails export. CLI stdout includes the verification result used in this pack; a failed chain
  returns exit 1 even when the diagnostic pack was written. No records are silently skipped.
  Empty CSV has only its header.
- Reads are bracketed by head checks; a changed head fails export before writing. Pause writers
  for a consistent export. The frozen API provides no transactional snapshot and cannot exclude
  malicious edits that preserve the observed head or happen after verification.
- `reconcileHandoffs` scans the range through **60 seconds after its end** (or caller-supplied
  grace). Each in-range handoff needs a same-callId non-handoff MCP **intent**, excluding builtin,
  proxy-self and denied-unproxied placeholders. Outcomes and other handoffs cannot satisfy it.
  Proxy-only records are not findings. All four `UnreconciledHandoff` fields are exported.
- The schema has no collector provenance; matching is correlation, not proof of proxy identity.
  A reused callId can be ambiguous. Missing handoffs can mean cancellation, an alias or lost data;
  they are findings to investigate, not automatic proof of bypass.
- Orphan detection reads prior available history (supported timestamps from year 0100) and requires
  a preceding intent for the outcome's callId. A standalone blocked outcome can be a valid denial.
  Intent/outcome joins use callId, **not** `parentRecordId`, which links neighboring chain records.
- An intent with no observed outcome through the grace boundary is listed separately. `delegated`
  means a terminal ask, **not** a recorded approval; no outcome cannot distinguish denial,
  cancellation and lost telemetry. Codex `ok` means ran-and-returned, not necessarily success.

## Trust boundary and safe rendering

The cover states **local = visibility + tamper-evident logging + best-effort gating, not enforcement**.
Only governed paths are observed. Server enforcement needs isolated upstream credentials; the frozen
record/API has no deployment mode field, so no report infers server enforcement from MCP names or
absence of builtin calls. Mode attestation is future contract work; the conservative local statement
is also present for empty ranges. ADR-010 adds the optional fourth argument `ReportContext`, with the CLI verify vocabulary
`head | ancestor | missing | mismatch | untrusted` and latest anchor hash/time. The caller computes
that status; the report never reads the anchor store. Omitted context says "not supplied to this report".
Every status carries the local-file editability warning. An ancestor protects only through its saved head.

HMAC values render as **HMAC-SHA256 digest (argument withheld)**, never as a clear argument.
The HMAC key/credential are not read by this module. Stored allowlisted arguments remain readable.
HTML escapes all record text and has no scripts or remote assets. CSV uses quoted cells, doubles
quotes, and prefixes formula-leading cells with an apostrophe; that presentation prefix is not part
of the original value. Exported text is evidence presentation, not a byte-for-byte rehashable ledger.

PDF is a dependency-free, paginated PDF 1.4 text document using Courier. Non-ASCII characters are
shown as reversible `\uXXXX` UTF-16 escapes; HTML/CSV retain Unicode. It wraps long text without
truncating records, uses larger section headings and landscape aligned tables with repeated headers,
and keeps each record block together when it fits on a page. Each page footer includes the chain result. No PDF/A, embedded fonts or signatures are claimed. Output files use exclusive
creation with mode 0600; use a fresh output directory for each pack. HTML is written last. I/O errors
can leave an incomplete pack; a failed invocation must not be distributed as a completed export.
All history/outputs are held in memory. Session and outcome lookups use maps/sets; the unchanged
handoff reconciliation can be quadratic. Large-ledger streaming remains future work (review residual #8).

Tests: `test/report.test.ts`, plus the real-ledger/process export in `test/cli-process.test.ts`.

## Slice 1c evidence pack (pins 6–8)

The six ordered sections are Executive summary, CC6.1 logical access, CC7.2 monitoring,
CC8.1 change management, Record evidence and Vocabulary. Tables are semantic HTML with column
headers and grayscale print styles; PDF has the same titles/order. Existing record blocks retain
all their fields. CSV retains its original 25 columns, then appends `agent_session_id`,
`evidence_class`, `anchor_status` in that order. Missing session ids display as
"pre-1c, no agent session id"; missing anchor context displays "not supplied" in CSV.

Pin-7 fixtures are the integration boundary: heartbeat discrimination is exactly
`policy.ruleId === "heartbeat:session-start"`; auto-mode denial is outcome `blocked` with
`errorClass === "permission-denied:auto-mode"`. The additive session id is read structurally
until Package A's type amendment is integrated; no other module is imported at runtime.
Heartbeats map only to CC7.2, never to access/change decisions or missing-outcome counts.
Session findings count tool intents in range, name the first in-range tool record, and look
for a heartbeat with that id **anywhere in available ledger history**, including outside the
grace window. Pre-1c records are never counted as sessions without heartbeat.

Outcome joins still stop at range end plus 60 seconds; future outcomes beyond grace do not
turn an unobserved action into observed execution. Orphans require a preceding tool intent;
an orphan in a heartbeated session is labelled "intent gap". No collector provenance or
transactional snapshot is implied. The report uses the latest observed outcome for an intent;
a reused callId remains ambiguous. Handoff placeholders are excluded from tool decision counts.

`delegated` and `require_approval` indicate an ask, not a named terminal approval. Recorded
approvals count only `approved`; denial counts group policy, no-channel, Slack decisions and
auto-mode evidence, counting each tool intent once plus explicit orphan auto-mode denials.
A Slack approval followed by a blocked outcome remains `denied: Slack approved`, preserving
both facts. A generic orphan or unexplained blocked outcome has an empty evidence class rather
than an invented denial cause; the raw outcome remains visible. Launch warnings are informational.

[V] Claude Code's hooks reference (read 2026-10-01; binding slice due diligence):
https://code.claude.com/docs/en/hooks — manual prompt denial is unobservable; PermissionDenied
fires for auto mode only. The exact caveat appears under CC8.1 and in Vocabulary. Heartbeats
show that SessionStart reached the ledger, not that later calls were all hooked. [H] AICPA
mapping and auditor acceptance remain hypotheses; Ryan's page-citation spot-check stays open.

Tests: `test/report-slice-1c.test.ts` exercises the pin-7 fixtures, all anchor statuses,
section order, evidence classes, history boundaries, escaping and PDF pagination. Package A's
CLI and merged e2e seams require coordinator integration and independent review.
