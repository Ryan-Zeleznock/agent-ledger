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
is also present for empty ranges. The report API receives no anchor; CLI `verify` separately checks
`anchor.latest()`. A local file anchor remains editable by the machine owner.

HMAC values render as **HMAC-SHA256 digest (argument withheld)**, never as a clear argument.
The HMAC key/credential are not read by this module. Stored allowlisted arguments remain readable.
HTML escapes all record text and has no scripts or remote assets. CSV uses quoted cells, doubles
quotes, and prefixes formula-leading cells with an apostrophe; that presentation prefix is not part
of the original value. Exported text is evidence presentation, not a byte-for-byte rehashable ledger.

PDF is a dependency-free, paginated PDF 1.4 text document using Courier. Non-ASCII characters are
shown as reversible `\uXXXX` UTF-16 escapes; HTML/CSV retain Unicode. It wraps long text without
truncating records. No PDF/A, embedded fonts or signatures are claimed. Output files use exclusive
creation with mode 0600; use a fresh output directory for each pack. HTML is written last. I/O errors
can leave an incomplete pack; a failed invocation must not be distributed as a completed export.
All history/outputs are held in memory; handoff and finding lookups can be quadratic. Indexed
joins and large-ledger streaming remain future work (review residual #8).

Tests: `test/report.test.ts`, plus the real-ledger/process export in `test/cli-process.test.ts`.
