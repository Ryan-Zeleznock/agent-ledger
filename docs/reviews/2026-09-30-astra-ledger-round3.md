GATE: FAIL

All four defects reproduced with memory-backed I/O.

1. **Duplicate JSON members bypass verification.** [jsonl.ts:145](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/jsonl.ts:145)  
   **Failing test:** Append a valid record, insert `"reason":"UNHASHED-SECRET"` before the existing `policy.reason`, retaining hashes. Expect verification failure; actual: `{ok:true,checked:1}`, unchanged head, and another append succeeds.  
   **Fix:** Reject duplicate member names at every nesting level before projection. Since storage promises canonical JSON, also require each raw line to equal its canonical serialization.

2. **Common configuration formats retain credentials.** [redact.ts:143](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/redact.ts:143)  
   **Failing parameterized test:** Assert these credentials disappear; currently these shapes leak:
   - **HTTP headers:** `Authorization: ApiKey opaqueCredential` and `Authorization: Token opaqueCredential` retain the credential; `Cookie: session=first; csrf=second` retains `second`.
   - **Environment lines:** `PASSWORD=alpha,beta` retains `beta`; `DATABASE_URL=postgres://user:opaqueCredential@localhost/db` retains userinfo; `PASS=opaqueCredential` remains unchanged.
   - **JSON config:** `{"db_password_value":"opaqueCredential"}` and `{"api_key_value":"opaqueCredential"}` remain unchanged.
   - **URLs:** `https://user:alpha,beta@localhost/path` remains unchanged; `https://host/?api_key=alpha,beta` retains `beta`; `?pwd=opaqueCredential` retains its value.
   - **CLI flags:** `--password alpha,beta` retains `beta`; `--password -opaqueCredential` and `--auth opaqueCredential` remain unchanged.
   
   **Fix:** Use format-aware value boundaries, redact complete sensitive headers/cookies, scan URLs inside assignments before punctuation splitting, and align structured-key and text/flag secret-name recognition.

3. **An outcome accessor breaks append/verify consistency.** [validate.ts:193](/Users/ryanzeleznock/agent-ledger-fable/src/ledger/validate.ts:193)  
   **Failing test:** Give `outcome.durationMs` a getter returning `1` for four reads, then `-1`. Expect rejection without writing; actual: append succeeds with `-1`, then verification rejects that record.  
   **Fix:** Reject accessors/proxies throughout contract objects using descriptors; validate and store the same captured values. Validate the complete sealed record before writing.

4. **Anchor timestamps contradict the documented rule.** [file.ts:23](/Users/ryanzeleznock/agent-ledger-fable/src/anchor/file.ts:23)  
   **Failing test:** Require `anchor.write()` to reject `2026-09-30T12:34:60Z`, `.0001Z`, and `.000000001Z` variants without writing. All succeed; ledger validation rejects them.  
   **Fix:** Apply the documented seconds ≤59 and fractional digits ≤3 restrictions in anchor validation; add matching write/read regressions.

Round-2 verdicts:

| Item | Status |
|---|---|
| Redaction coverage | **NOT FIXED** — original examples fixed; gaps above remain |
| Quadratic key renaming / PEM scanning | **FIXED** |
| Stored modifications bypass hashing | **NOT FIXED** — unknown fields reject; duplicate members bypass |
| Redaction expansion makes storage unreadable | **FIXED** |
| Array getters / `toJSON` | **FIXED** — outcome accessor is a separate gap |
| Short decoding / decode-depth / nesting bounds | **FIXED** |
| Timestamp semantics | **NOT FIXED** — ledger fixed; anchor unchanged |
| Duplicate IDs on append | **FIXED** |
| Multiprocess contention proof | **FIXED** — reviewed ledger/anchor hold-block-release tests |

Typecheck passed. Full suite not run because it writes files. No files changed; prohibited directories were not accessed.
