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

PDF is a dependency-free, paginated PDF 1.4 document using standard Helvetica for prose,
Helvetica Bold for headings and Courier only for identifier/hash fields. It starts with a cover
(title, range, generation time, verdicts, scope and trust boundary), then a contents page with
resolved page numbers. Table columns use measured content widths, repeated captions/headers,
hairline rules and zebra rows. Criterion tables retain full source timestamps and identifiers;
the compact record index uses UTC times with dates in captions. Record details retain every
non-empty field, including full identifiers; short interior fields share lines to reduce repetition.

Wrapping happens at whitespace boundaries, never inside timestamps, hashes or Unicode escapes.
Non-ASCII ledger characters remain reversible `\uXXXX` UTF-16 escapes; HTML/CSV retain Unicode.
Criterion table IDs are never abbreviated. The cover abbreviates the head with `...`; the summary
and record details retain the full value. An unbroken token
wider than its available line is fitted by reducing its font size, preserving all evidence bytes;
very long unbroken values can consequently be small and should be read in HTML/CSV. Fitting
record blocks stay on one page; oversized blocks continue. Each footer includes the chain result.
No PDF/A, embedded fonts or signatures are claimed. Output files use exclusive
creation with mode 0600; use a fresh output directory for each pack. HTML is written last. I/O errors
can leave an incomplete pack; a failed invocation must not be distributed as a completed export.
All history/outputs are held in memory. Session and outcome lookups use maps/sets; the unchanged
handoff reconciliation can be quadratic. Large-ledger streaming remains future work (review residual #8).

Tests: `test/report.test.ts`, plus the real-ledger/process export in `test/cli-process.test.ts`.

## Slice 1c evidence pack (pins 6–8)

The six ordered sections are Executive summary, CC6.1 logical access, CC7.2 monitoring,
CC8.1 change management, Record evidence and Vocabulary. Tables are semantic HTML with column
headers and grayscale print styles; PDF has the same titles/order. Expandable record details retain all non-empty fields; the compact index lists every record. CSV retains its original 25 columns, then appends `agent_session_id`,
`evidence_class`, `anchor_status` in that order. Missing session ids display as
"not recorded (server mode or pre-1c)"; missing anchor context displays "not supplied" in CSV.

Pin-7 fixtures are the integration boundary: heartbeat discrimination requires
`policy.ruleId === "heartbeat:session-start"`, `call.tool === "SessionStart"` and a `builtin:`
server (coordinator review fix #7, 2026-10-03). Disagreements stay visible as tool evidence and
are findings in the summary, CC7.2 and CSV. Auto-mode denial is outcome `blocked` with
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


## Review fixes and remaining P3 (2026-10-03)

- #1: the coordinator amended pin 8 with `executed despite deny`. An `ok` outcome after a policy
  deny or denied/timeout/unavailable/no-channel approval uses that class. Every in-range record
  with that class is a summary/CC7.2/CSV anomaly, including outcomes whose intent precedes the
  range. Denial counts retain the recorded cause; the observed execution never converts it to allow.
- #2: handoff intents participate in preceding-intent lookup. A hook outcome with only its
  handoff is not an orphan; the missing proxy is an unreconciled-handoff finding. A later proxy
  intent for the call supersedes the handoff for outcome classification.
- #4: unclassified blocked outcomes still have a blank evidence class because the amended label
  set does not name that cause. Vocabulary now explains the blank cell and directs readers to
  the raw outcome; it never implies allowance or execution. No extra class was invented.
- #5/#6: PDF wrapping keeps UTF-16 escape tokens whole. Tests compare record starts/ends per page,
  match record ids, validate xref offsets, stream lengths, page counts/references and reject a
  corrupted xref. The old presence-only assertion's false positive is reproduced in a test.
- #9 residual: `npm test` deliberately runs two Vitest processes, so globalSetup compiles
  `.test-build` twice (unit, then timing). Removing that duplicate safely needs coordinated
  build invalidation: each phase must also work standalone without stale child-process fixtures.
  Retained for scoped review; keep the phases isolated when addressing this compile cost.

Regression tests: `test/report-slice-1c.test.ts`, `test/report-pdf.test.ts`. Fable's full review
is retained at `docs/reviews/2026-10-03-fable-slice-1c-pack-review.md`; fixes need his scoped verification.

## The Filed Instrument (DESIGN.md, 2026-10-04)

The offline HTML uses DESIGN.md's white 1080px sheet, 64px desktop / 24px mobile padding,
iron-gall ink, ruled tables and square corners. The exhibit cover has a right-hand registration
block, followed by the round bronze chain seal, verbatim chain/anchor lines and full head hash.
The trust boundary is on the cover without a side border. No entity, policy version/reviewer or
mode attestation exists in the frozen report API; registration labels these as unavailable.
The pack identifier is an `AL-` prefix plus the generation timestamp, not a ledger attestation.

Source Serif 4 serves headings/prose, IBM Plex Sans Condensed serves labels/tables, and
JetBrains Mono serves identifiers/hashes with ligatures disabled. All four vendored WOFF2
files are embedded as base64 `@font-face`; no remote resource or runtime font file is needed.
Regenerate the committed TypeScript module with `node scripts/gen-embedded-fonts.mjs`, or
check freshness with `node scripts/gen-embedded-fonts.mjs --check`. `tsc` carries the module
into the build. The original OFL notices stay in `fonts/`; short attributions and all three
full notices travel inside the HTML. Vendored font payload: **101,464 bytes** before base64.

The six numbered sections retain their pin-8 IDs and titles, and tables are numbered per
section. The record index adds the chain margin (pack-local R-0001 sequence, previous-hash
prefix, own-hash prefix). Adjacent selected records need not be adjacent in the whole ledger;
full hashes and all non-empty source fields remain in initially open record details. The
criterion tables retain exact pinned columns, plain escaped cells, full timestamps with
original offsets and full identifiers. Because the integration parser requires literal
`<tr>` / `<td>` tags, scoped positional CSS applies exception tint and approval stamps
without changing those tags. Oxblood marks only approved write/risky/unreviewed calls with a
non-blank named approver. Delegated asks, unnamed approvals and automated decisions stay
monochrome. Exceptions carry their written decision/finding; statuses remain readable in grayscale.

PDF uses standard Times-Roman / Times-Bold for prose/headings, Helvetica / Helvetica-Bold
for table text/labels, and Courier for identifiers/hashes. Its cover mirrors the exhibit,
including registration, round seal and full head. Only the seal and named approvals use
color; exception rows use a gray tint. Tables repeat numbered captions and headers on each
page, and fitting record blocks stay together. The dependency-free PDF writer retains its
reversible Unicode escaping, word/token wrapping, xref/stream checks and numbered footer.

Pin-8 wording, evidence classes, denial caveat, anchor text, hostile-value escaping and the
CSV projection are unchanged. The pre-redesign CSV SHA-256 fixture still passes. Report tests
also mirror the coordinator's `section` / `under` / `tableRows` integration parsers and PDF
extractor; the integration tests themselves are unchanged.

Validation: typecheck, compiled build and 86 report tests pass. A synthetic 12-record HTML
pack is **199,182 bytes** including fonts, licenses and full evidence; an empty pack is
**167,160 bytes**. Size grows with the selected records and field lengths. Local Poppler raster inspection covered the PDF cover, approval table
and chain index. Chromium failed sandbox Mach-port registration, so HTML rendering, responsive
layout and browser printing need coordinator visual verification. Print CSS removes the sheet
shadow, repeats table headers and expands evidence details; evidence details also start open.
The coordinator runs the full suite and e2e outside the sandbox. This build is not independent approval.


Live-lab label correction (2026-10-05): `LedgerRecord`/`ToolCall` have no writer or mode discriminator.
Both pipeline paths project the same fields and use `identity.startSession`; `agentSessionId` is absent in proxy
mode AND old hook records. MCP server names, Slack decisions and handoff correlation do not prove provenance.
Therefore HTML/PDF and the existing CSV `agent_session_id` label use the conservative wording above, with a
Vocabulary explanation, instead of asserting `not applicable (server mode)`. CSV remains 28 columns.
Test: `labels absent agent sessions conservatively in HTML/PDF/CSV without guessing from MCP names`.
Coordinator owns the pin-8 wording amendment; no mode field or enforcement claim was added.

ADR-015 amendment (2026-10-05): CC8.1 renders `approved, Ryan Zeleznock (U0C6UV8NMR7)` when a name is recorded, retaining the stable member id. Missing names keep the member-only rendering. HTML/PDF escape names through the existing renderer; CSV keeps its 28 columns and includes the additive name inside the existing `approval` JSON cell.
