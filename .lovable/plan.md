## Fix Remaining 6-Stream Pipeline Issues

Scope: `src/lib/coding-pipeline.ts`, `src/lib/lab-loinc-map.ts`, `src/lib/vitals-loinc-map.ts`, plus a new `src/lib/drug-rxnorm-map.ts`. No DB schema changes. Stream B, F re-run delay, and `nlp_audit_logs` upsert stay as-is.

### 1. Stream A — CHV → resolveAndValidate → crosswalk fallback chain

Rewrite the Stream A block in `runSixStreamPipeline` with an explicit ladder and `console.error` on every miss so failures surface in edge-function logs:

1. `resolveChv(cc)` → if it returns a hit, use `hit.display` as the search term; else use raw `cc`.
2. `resolveAndValidateSnomed(term)` (already sends `sab: "SNOMEDCT_US"`).
3. If `confidence < 0.50`, retry once with the first 3 words of the original `cc`.
4. If a SNOMED code lands, call `crosswalkSnomedToIcd10(snomed)` for the ICD-10 pair.
5. Upsert into `conditions` with `source_section='chief_complaint'`, `coding_source='nlp-stream-a'`, `term_status='pending'` (unchanged shape via existing `upsertCondition`).
6. `console.error("[stream-a] …", { step, cc, term, result })` at each fallback path.

### 2. Stream C — hardcoded RxNorm map first, exact-name matching

Create `src/lib/drug-rxnorm-map.ts` with the 15 entries from the prompt (Omeprazole → 7646, Metformin → 6809, Aspirin → 1191, Atorvastatin → 83367, Lisinopril → 29046, Metoprolol → 41493, Pantoprazole → 40790, Amoxicillin → 723, Azithromycin → 18631, Acetaminophen → 161, Ibuprofen → 5640, Amlodipine → 17767, Warfarin → 11289, Furosemide → 4603, Insulin → 253182) keyed by lower-cased drug name, plus a small brand/alias table (`asa → aspirin`, `apap/tylenol → acetaminophen`, `advil/motrin → ibuprofen`, `lasix → furosemide`, `norvasc → amlodipine`, `coumadin → warfarin`, `zithromax → azithromycin`, `zestril/prinivil → lisinopril`, `lipitor → atorvastatin`, `glucophage → metformin`, `prilosec → omeprazole`, `protonix → pantoprazole`, `lopressor/toprol → metoprolol`).

`lookupDrugRxnorm(name)`:
- Strip dose/route/frequency tokens ("500 mg", "PO BID", numbers, units) → keep the ingredient word(s).
- Return `{ code, display }` if the normalized ingredient (or alias) is in the map.

Change Stream C in `coding-pipeline.ts` for both form-time and DB-fallback branches:

1. Call `lookupDrugRxnorm(drugName)` first — if hit, use it directly and skip UMLS.
2. Otherwise call `resolveRxNorm(drugName)` and apply an **exact leading-token check** before accepting:
   - Extract the leading ingredient token from the *input* (lowercased, first alphabetic word after stripping numbers/units/routes).
   - Extract the leading ingredient token from the resolved `display` the same way.
   - Accept only when `inputToken === resolvedToken`.
   - Examples:
     - `"Omeprazole"` → UMLS returns `"esomeprazole"` → `"omeprazole" !== "esomeprazole"` → reject.
     - `"Metformin"` → UMLS returns `"metformin hydrochloride"` → `"metformin" === "metformin"` → accept.
   - On rejection, `console.warn("[stream-c] rejected fuzzy match", { input, resolved })` and skip writing the med row rather than persist a wrong code.

### 3. Stream E — vitals/observations fallback for automated admissions

Currently Stream E only fires when `admissionData.vitals` is present. Add a fallback chain inside the sweep path:

1. `admissionData.vitals` present → existing form-time behavior.
2. Else read latest row from `vitals` (`.eq("mrn", mrn).order("recorded_at", desc).limit(1)`).
3. Else pull up to 5 latest rows from `observations` (`.eq("patient_mrn", mrn).order("recorded_at", desc).limit(5)`) and reduce to a single `{hr, bp_systolic, bp_diastolic, spo2, rr, temp_c}` object by matching each row's `code` / `display` / `loinc_code` against the six LOINC codes in the static map (or aliases: `heart_rate`, `systolic`, `diastolic`, `temperature`, `resp_rate`).

Extend `VITALS_LOINC` in-place to accept alias keys (`heart_rate`, `systolic`, `diastolic`, `temperature`, `resp_rate`) mapping to the same six LOINC codes, so whichever source column we read from resolves consistently.

Use the merged row as the source for the existing LOINC assembly and `vitals` upsert already in Stream E.

### 4. Stream F — extend pre-map only

Append the missing entries to `LAB_LOINC` in `src/lib/lab-loinc-map.ts` so the full table from the prompt is covered:

- `d-?dimer` → `48066-5`
- `lactate|lactic acid` → `2519-9`
- `lipase` → `3040-3`

(All others in the requested table already exist.) No other changes to Stream F — the delayed re-run and existing pre-map lookup stay.

### 5. Untouched

- Stream B, `upsertCondition`, and the `nlp_audit_logs` upsert-on-pending logic remain exactly as they are.
- No edge-function edits (`umls-proxy` unchanged; we call existing `chv`, `resolveAndValidate`, `crosswalk`, `rxnorm` actions).
- No DB migration.

### Files touched

- `src/lib/coding-pipeline.ts` — rewrite Streams A, C, E branches; add logging.
- `src/lib/lab-loinc-map.ts` — add 3 patterns.
- `src/lib/vitals-loinc-map.ts` — add alias keys pointing at the same 6 LOINC codes.
- `src/lib/drug-rxnorm-map.ts` — new file (hardcoded 15 drugs + aliases + `lookupDrugRxnorm`).
