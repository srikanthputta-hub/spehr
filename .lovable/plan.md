# Auto Doc Backend Architecture — Implementation Plan

A three-phase backend upgrade. No new clinical UI surfaces — only the existing Watch Dog area gets a new monitoring panel.

## Phase 1 — Expanded Patient-Voice Chief Complaints

**Goal:** Replace the small, repetitive complaint pool with a large, patient-voice library, each entry pre-tagged with one of the 22 clinical departments.

- New file `src/lib/chief-complaints.ts` exporting:
  - `Department` union of all 22 departments.
  - `PATIENT_COMPLAINTS: { text: string; department: Department; acuity: "low"|"med"|"high"|"critical" }[]` — ~150+ entries written in lay language ("My chest feels incredibly tight and I'm dizzy", "I can't keep any food down since last night", etc.).
  - `pickComplaint()` — rotates through the pool with low recent-repeat probability (in-memory recency set).
  - `routeDepartment(text)` — keyword-based fallback router used when complaints arrive from other sources.
- Update `simulation_chief_complaints` table seeding via a data-insert: replace contents with the new lay-language pool (keeps existing `get_next_ghost_complaint()` DB rotation working for the SQL `auto_admit_ghost_patient` path).
- Update the in-app admission seed (the front-end Live Automation Loop) to use `pickComplaint()` + assign `department` onto the new patient record (stored in `patients.assigned_department` — added via migration).

## Phase 2 — "Auto Doc" Headless Clinical Reasoning Engine

A pure server-side pipeline. No chat UI, no avatar.

**Trigger:** runs on patient admission. Two trigger paths kept in sync:
1. Frontend Live Automation Loop calls `runAutoDoc({ mrn })` server fn right after inserting a patient.
2. SQL `auto_admit_ghost_patient` path: a DB trigger on `patients` INSERT calls a `notify_auto_doc` function (pg_net → `/api/public/hooks/auto-doc`) so admissions created in pg_cron also get processed.

**New server function:** `src/lib/auto-doc.functions.ts` → `runAutoDoc({ mrn })` (no auth — internal endpoint, idempotent via `auto_doc_runs` row check).

**Pipeline steps (each writes a log row to `auto_doc_logs`):**
1. `analyze` — load patient, read chief_complaint + assigned_department.
2. `order` — pick condition-specific meds/labs from a per-department catalog in `src/lib/auto-doc-catalog.ts` (RxNorm-coded meds, LOINC-coded labs). Insert into `medication_orders` and `lab_orders` with `ordered_by = 'Auto Doc'`.
3. `result` — generate realistic numeric lab results (value, unit, reference range, abnormal flag) and write to `lab_results` + update `lab_orders.status = 'Resulted'`.
4. `document` — author HPI / Assessment / Plan notes into `clinical_notes`.
5. `umls` — call the existing UMLS server fn for each condition/lab/med term; collect **all** returned SNOMED-CT / ICD-10 / LOINC / RxNorm codes and write the full arrays into `patients.standardized_output` (merging, not overwriting). Cached per term in a new `umls_term_cache` table to stay under rate limits.
6. `fhir` — build a FHIR R4 transaction bundle (Patient, Encounter, Condition, Observation, MedicationRequest, DiagnosticReport, Composition) via `buildEncounterBundle` + a new `buildDiagnosticReport` helper added to `src/lib/fhir-bundle.ts`. Persist to `fhir_bundles` table; the existing FHIR push path picks it up.
7. `discharge` — after a configurable dwell (default 6 min sim time), author a discharge summary into `patients.discharge_summary`, flip status to Discharged, free the bed.

**Tables (migration):**
- `auto_doc_runs (mrn pk, started_at, completed_at, status, stage)` — idempotency + current stage.
- `auto_doc_logs (id, mrn, stage, message, level, created_at)` — append-only stream for Watch Dog.
- `umls_term_cache (term pk, codes jsonb, fetched_at)`.
- `patients.assigned_department text` column add.
- All tables get GRANT + RLS + service_role policies per project rules.

**Public hook:** `src/routes/api/public/hooks/auto-doc.ts` — POST `{ mrn }`, calls `runAutoDoc`. Used by the DB trigger and pg_cron sweep that retries any `auto_doc_runs` stuck in non-terminal state > 2 min.

## Phase 3 — Watch Dog "Systematic Health Check Cycle" Panel

Inside the existing Watch Dog section of `src/routes/system-admin.tsx`:

- New collapsible panel **"Auto Doc Pipeline Monitor"** (admin-only, no clinical surface).
- Live tail of last 100 rows from `auto_doc_logs` (realtime channel subscription), grouped by MRN, with stage badges: Analyze ▸ Order ▸ Result ▸ Document ▸ UMLS ▸ FHIR ▸ Discharge.
- Aggregate counters for the current cycle: runs started, completed, failed, avg duration per stage.
- Each "Systematic Health Check Cycle" tick (existing watchdog loop) verifies: no run stuck > 2 min, UMLS cache hit rate, FHIR bundles generated count — adds a ✓/✗ next to "Auto Doc" in the existing automations checklist.

No changes anywhere else in clinical dashboards.

## Technical Details

**Files to add**
- `src/lib/chief-complaints.ts`
- `src/lib/auto-doc-catalog.ts` (per-department med/lab templates with RxNorm/LOINC codes + reference ranges)
- `src/lib/auto-doc.functions.ts` (server fn `runAutoDoc`)
- `src/lib/auto-doc.server.ts` (pipeline helpers, UMLS client, FHIR builder calls)
- `src/routes/api/public/hooks/auto-doc.ts` (POST hook)
- `src/components/admin/AutoDocMonitor.tsx` (Watch Dog panel)

**Files to edit**
- `src/lib/fhir-bundle.ts` — add `buildDiagnosticReport`, expose it from `buildEncounterBundle`.
- `src/routes/system-admin.tsx` — embed `<AutoDocMonitor/>` inside the existing Watch Dog section and append "Auto Doc" to the automations checklist.
- The front-end Live Automation Loop block in `system-admin.tsx` — after inserting a new patient, fire-and-forget call `runAutoDoc({ mrn })`.

**Migration**
- Add `patients.assigned_department`.
- Create `auto_doc_runs`, `auto_doc_logs`, `umls_term_cache`, `fhir_bundles` (if not present).
- Replace `simulation_chief_complaints` rows with the new lay-language pool.
- DB trigger `patients_auto_doc_after_insert` → `net.http_post` to `/api/public/hooks/auto-doc`.
- pg_cron sweeper every minute to retry stuck runs.
- Grants + RLS as required.

**Idempotency / dedup**
- `runAutoDoc` short-circuits if an `auto_doc_runs` row for the MRN exists in a terminal state.
- Continues from `stage` on partial-failure re-entry.
- FHIR push reuses existing "successful = never re-queue" logic already in `system-admin.tsx`.

**Out of scope**
- No new clinical-facing UI, no chatbot, no avatar.
- No changes to existing Auth, role gates, or unrelated dashboards.
