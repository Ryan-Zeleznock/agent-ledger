GATE: FAIL

- **[P1] Credentials still survive redaction.** [redact.ts:241](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:241), [redact.ts:301](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:301).  
  **Failing cases:** `authorization:bearer opaqueCredential` retains `opaqueCredential`; `'x'.repeat(1024)+'/ghp_'+'A'.repeat(36)` survives unchanged, including as an object key. Long URLs also retain userinfo.  
  **Fix:** Recognize schemes inside assignment values; scan long words linearly or replace them entirely.

- **[P1] Redaction remains quadratic below 4 MiB.** [redact.ts:400](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:400), [redact.ts:60](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:60).  
  **Failing case:** Redact an object containing `u${i}@example.com: 0` for 10k/20k/40k/80k keys: **85/347/1,234/4,331 ms**; largest input **1.83 MB**. Each rename scans `keys.includes`. Repeated `-----BEGIN ` also triggers repeated suffix searches.  
  **Fix:** Reserve names in a `Set`; make PEM scanning advance without rescanning suffixes. Add both supervised regressions.

- **[P1] Stored modifications bypass hashing and anchors.** [validate.ts:174](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/validate.ts:174).  
  **Failing case:** Append a valid record, inject `policy.credential="UNHASHED-SECRET"` into its stored JSON without changing hashes. `verify()` returns `{ok:true,checked:1}`, `head()` remains unchanged, and another append succeeds. Projection discards the injected evidence before hashing.  
  **Fix:** Reject unknown stored fields at every contract level; hash the complete validated stored preimage.

- **[P1] Successful append can disable subsequent appends.** [jsonl.ts:157](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:157), [validate.ts:71](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/validate.ts:71).  
  **Failing case:** Append `{text:"a@b.co ".repeat(35000)}`. Its 245,000 characters expand to 595,000. Append succeeds; verification fails; subsequent `head()`/append reject the stored record.  
  **Fix:** Validate the final redacted record against storage limits before writing; reject or replace oversized output without changing existing bytes.

- **[P2] Array accessors restore the `toJSON` leak.** [validate.ts:81](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/validate.ts:81).  
  **Failing case:** An array index getter returns `"safe"` on its first two reads, then `{toJSON(){return {password:"RAW"}}}`. Append stores `"RAW"` and verification passes.  
  **Fix:** Inspect array property descriptors without invoking getters, reject proxies, and construct a validated data snapshot.

- **[P2] Decoding and nested JSON bounds are inconsistent.** [redact.ts:278](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:278), [redact.ts:342](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:342), [redact.ts:413](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:413).  
  **Failing cases:** Base64 `dG9rZW49eA==` and hex `746f6b656e3d78` retain `token=x`. Triple-percent encoding is decoded despite the documented one-level rule. A string containing 10,000 nested JSON arrays causes `RangeError`, bypassing depth validation.  
  **Fix:** Support short encoded assignments; propagate explicit decode/depth budgets through parsed JSON instead of resetting them.

- **[P2] Timestamp parsing changes instants.** [validate.ts:38](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/validate.ts:38), [file.ts:35](/Users/ryanzeleznock/agent-ledger-fable/src/anchor/file.ts:35).  
  **Failing cases:** Invalid `2026-09-30T12:34:60Z` is accepted; ledger maps it to `12:34:59Z`. A range beginning `.000000001Z` incorrectly includes a record at `.000Z`. Valid leap seconds also collapse onto the preceding second.  
  **Fix:** Implement leap-second semantics or explicitly reject unsupported leap seconds; preserve fractional ordering or reject unsupported precision. [RFC 3339 §5.7](https://www.rfc-editor.org/rfc/rfc3339.html#section-5.7).

- **[P2] Append permits duplicate IDs.** [jsonl.ts:200](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:200).  
  **Failing case:** Append `unsealed(1)` twice: both succeed, then verification reports the second record broken.  
  **Fix:** Enforce ID uniqueness under the append lock before writing.

- **[P2] Four-process test does not prove lock contention.** [ledger-multiprocess.test.ts:42](/Users/ryanzeleznock/agent-ledger-fable/test/ledger-multiprocess.test.ts:42).  
  **Missing regression:** A fully serialized process schedule satisfies every assertion; no assertion requires an `EEXIST` retry.  
  **Fix:** Hold writer A after lock acquisition, require B–D to report blocked acquisition, then release A. Apply the same test to anchor writers.

Original findings:

| # | Verdict | Evidence |
|---|---|---|
| 1 | FIXED | Nested projection: [validate.ts:120](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/validate.ts:120). |
| 2 | NOT FIXED | Header credential survives: [redact.ts:241](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:241). |
| 3 | NOT FIXED | Long secret-bearing keys survive: [redact.ts:301](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:301). Collision preservation itself passed. |
| 4 | NOT FIXED | Short encoded assignments survive: [redact.ts:278](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:278). |
| 5 | NOT FIXED | Array getters bypass validation: [validate.ts:81](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/validate.ts:81). |
| 6 | NOT FIXED | Quadratic renaming: [redact.ts:400](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:400). |
| 7 | FIXED | Automatic reclamation removed: [jsonl.ts:71](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:71). Requires quiescent manual recovery. |
| 8 | FIXED | Bounded descriptor inspection and retry deadline: [jsonl.ts:54](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:54). |
| 9 | NOT FIXED | Stored projection hides modifications; duplicate appends remain: [validate.ts:174](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/validate.ts:174). |
| 10 | FIXED | Existing incomplete tails and invalid timestamps reject: [jsonl.ts:256](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:256). |
| 11 | FIXED | Locked tail check and zero-progress rejection: [file.ts:139](/Users/ryanzeleznock/agent-ledger-fable/src/anchor/file.ts:139), [file.ts:100](/Users/ryanzeleznock/agent-ledger-fable/src/anchor/file.ts:100). |
| 12 | NOT FIXED | Leap-second and fractional-order failures: [validate.ts:38](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/validate.ts:38). |
| 13 | FIXED | Forgery limits corrected: [README.md:41](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/README.md:41). |

`+14:00` conversion passed. Lock inspection uses the appropriate flags, descriptor type check and bounded read; the flag semantics match [Node documentation](https://nodejs.org/api/fs.html#file-open-constants). Anchor writers share `<anchor-path>.lock`; this is the same locking protocol, not the ledger file’s lock. In-memory two-instance short-write and zero-progress probes passed.

Typecheck passed. Behavioral probes used memory-backed files; benchmarks used supervised children. Full tests were not run because globalSetup writes `.test-build`. No files changed; prohibited directories were not read.
