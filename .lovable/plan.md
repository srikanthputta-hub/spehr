# NLP Pipeline + Live Terminology Matrix Redesign

Full end-to-end rebuild of the coding pipeline so every admission fans out into six terminology streams, persists to `nlp_audit_logs`, and drives an approve-then-publish flow into the Live Terminology Matrix and Auto Terminologist queue.

## 1. Database migrations

Single migration adds the missing coded columns and a source tag:

- `vitals`: `loinc_code text`, `loinc_display text`, `loinc_map jsonb`
- `lab_results`: `loinc_code text`, `loinc_display text`
- `conditions`: `source_section text` (values: `chief_complaint | pmh | family_history | hpi`)
- Confirm `medication_orders.rxnorm_code / rxnorm_display / coding_source / coded_at / term_status`, `allergies.substance_rxcui / substance_snomed / reaction_snomed / coding_source / coded_at`, and `conditions.term_status` exist; add any that are missing.
- No new tables, no RLS changes, no GRANT changes needed.

## 2. Six-stream coding pipeline

New module `src/lib/coding-pipeline.ts` exporting `runSixStreamPipeline(mrn)`:

- Loads patient, PMH checkboxes, HPI, medications, allergies, latest vitals row, latest lab_results rows.
- All UMLS traffic goes through the existing `umls-proxy` edge function via `src/lib/umls-client.ts` (extend it with `chv`, `crosswalk`, `rxnorm`, `rxnormDetail`, `loinc` actions as needed).
- Streams:
  - **A — CC + HPI**: `chv` → `resolveAndValidate(SNOMEDCT_US)` → `crosswalk(→ICD10CM)` → upsert `conditions` row (`source_section='chief_complaint'`, `coding_source='nlp-stream-a'`, `term_status='pending'`).
  - **B — PMH**: static PMH→SNOMED/ICD-10 map (15 rows from spec) in `src/lib/pmh-map.ts`; one `conditions` row per checked item with `category='medical-history'`, `source_section='pmh'`, `coding_source='nlp-stream-b'`.
  - **C — Meds**: `rxnorm` + `rxnormDetail`; UPDATE matching `medication_orders` rows by mrn + normalized name.
  - **D — Allergies**: drug substances via `rxnorm`; reactions via `resolveAndValidate`; environmental/food allergens via static SNOMED map (10 rows). UPDATE `allergies` rows.
  - **E — Vitals**: static column→LOINC map; write `loinc_code`, `loinc_display`, and `loinc_map` JSON on the latest `vitals` row.
  - **F — Labs**: pre-mapped common labs first, fall back to `umls-proxy` `loinc` action; UPDATE each `lab_results` row.
- Idempotent: each stream uses upsert / conditional update so `Re-code` doesn't duplicate.
- Trigger points:
  - Call `runSixStreamPipeline(mrn)` from `admitPatient` in `src/lib/admit-patient.ts` after the intake save (fire-and-forget; errors logged, not blocking).
  - Add a leader-elected sweep (`useCodingPipelineSweep`) that codes any newly admitted patients the app didn't originate (ghost admissions). **Capped at 5 patients per tick** to stay under UMLS rate limits; gated on automation-enabled.
  - Manual re-run wired to the "Re-code" button in NLP Audit Logs UI.

## 3. umls-proxy edge function

Edit `supabase/functions/umls-proxy/index.ts` **additively only**:

- **Preserve every existing action**, including the `resolveAndValidate` and `subsumes` handlers from the previous update — do not remove, rename, or refactor them.
- Add any missing actions on top: `chv`, `crosswalk`, `rxnorm`, `rxnormDetail`, `loinc` (only whichever ones aren't already present).
- Keep existing caching / CUI-atoms fallback logic intact.

## 4. nlp_audit_logs persistence

After all six streams settle for one admission, write exactly one row:

- `patient_mrn`, combined `raw_text` (CC + PMH list + med names), `extraction_mapping`, `standardized_output` shaped per spec (`stream_a…stream_f`), `confidence_score` = avg of stream A confidence + 1.0 for each successful direct-map stream, `status='pending'`, `resolution_method='auto-6-stream'`.
- Also emit a row on `Re-code` so history is preserved.

## 5. NLP Audit Logs UI redesign

Rebuild the panel (new `src/components/admin/dictionary/NlpAuditLogsPanel.tsx`):

- Card per admission: patient header (name, MRN, admitted time, overall confidence).
- Six stream sub-cards (A–F) with per-stream status badge (coded / partial / failed) and code pills (`SNOMED 29857009 · Chest pain`, etc.).
- Actions: **Approve**, **Edit**, **Re-code**.
  - Approve: sets `term_status='approved'` (+ `verification_status='confirmed'` on `conditions`) across `conditions`, `medication_orders`, `allergies`, `vitals`, `lab_results` for that MRN; flips `nlp_audit_logs.status='approved'`.
  - Edit: inline per-stream editors to overwrite any code + display before approval.
  - Re-code: re-invokes `runSixStreamPipeline(mrn)`.

## 6. Live Terminology Matrix redesign

Rewrite the matrix (`src/components/admin/dictionary/LiveTerminologyMatrix.tsx`) to pull per patient from all six tables:

- Columns: SNOMED CT (conditions), ICD-10 (conditions), RxNorm (medication_orders), LOINC Labs (lab_results), LOINC Vitals (vitals), Allergy RxCUI (allergies).
- Filter to MRNs whose latest `nlp_audit_logs.status='approved'`.
- Each pill shows code · display · source-section tag (`from CC`, `from PMH`, `from Labs`, `from Vitals`, `from Meds`, `from Allergy`).
- Click pill → popover with canonical display, UMLS CUI, value-set membership from `custom_value_sets`, or "No value set — gap detected" in red.

## 7. Auto Terminologist wiring

On Approve:
- Diff Stream A + B SNOMED codes against `custom_value_sets`.
- Any uncovered code → insert a gap entry into `auto_terminologist_log` (action `gap_from_approval`) so the existing `useAutoTerminologist` loop drafts a value set for review.
- Disable the current raw-text scanning path in `useAutoTerminologist` so this becomes the sole feeder.

## Technical details

- Files touched:
  - New: `src/lib/coding-pipeline.ts`, `src/lib/pmh-map.ts`, `src/lib/allergen-map.ts`, `src/lib/vitals-loinc-map.ts`, `src/lib/lab-loinc-map.ts`, `src/hooks/useCodingPipelineSweep.ts`, `src/components/admin/dictionary/NlpAuditLogsPanel.tsx`, `src/components/admin/dictionary/LiveTerminologyMatrix.tsx`.
  - Edited: `src/lib/admit-patient.ts`, `src/lib/umls-client.ts`, `supabase/functions/umls-proxy/index.ts` (additive only), `src/hooks/useAutoTerminologist.ts`, `src/routes/__root.tsx` (mount sweep hook), `src/routes/system-admin.tsx` (mount new panels).
  - Migration file under `supabase/migrations/` for Part 1.
- Concurrency: per-MRN in-memory lock to prevent overlapping Re-code + sweep runs.
- Sweep throttle: max 5 MRNs per tick, 60s tick interval, leader election via existing pattern to avoid multi-tab thrash.
- Caching: reuse `umls_cache` via `umls-proxy` to keep repeat lookups cheap.
