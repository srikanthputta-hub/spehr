## System Admin / Medical Dictionary Redesign

Comprehensive overhaul of the Medical Dictionary tab in `src/routes/system-admin.tsx` covering all 4 sub-tabs to enforce FHIR R4 compliance, hierarchical taxonomy, and automated NLP pipeline.

---

### 1. Catalog → Taxonomy Tree View

Replace the flat category-card + table layout with a collapsible SNOMED-browser-style tree.

- **Root nodes** (5): `ICD-10`, `SNOMED CT`, `LOINC`, `RxNorm`, `VSAC` — each with code-system colored badge and count.
- **Child grouping** — auto-derive subfolders from each row's `category` field (e.g. ICD-10 → "Diagnosis", "Chief Complaint"; LOINC → "Laboratory", "Chemistry"). Uncategorized rows fall under `Uncategorized`.
- **Leaf nodes** — `code · display` with status pill + delete action.
- **48-hour filter** — derive "active" code set from rows referenced by `patients`, `lab_orders`, `medication_orders`, `nlp_audit_logs` updated within last 48h. Show toggle "Last 48h only / All" (default 48h) with active counts.
- **Expand/collapse** with chevron, persist expansion in component state.
- Keep `Search Terminology` + `Export FHIR` actions in the header.

### 2. NLP Audit Logs → Automated FHIR Pipeline

- **Auto-pull on admission** — subscribe via supabase realtime to `patients` INSERT; when a new admission arrives, auto-generate an audit entry (raw chief complaint → extraction → FHIR output) and prepend to the trail. Show a small "Live · listening" indicator.
- **Three-stage pipeline visual** — keep current 3-column layout but restyle as a connected pipeline (arrows between cards, stage badges 1/2/3, color-coded).
- **FHIR R4 mapping** in stage 3 — render structured resources:
  - Symptoms / dx → `Condition` (code = CodeableConcept{ICD-10 | SNOMED})
  - Labs → `Observation` (code = LOINC CodeableConcept)
  - Meds → `MedicationRequest` (medicationCodeableConcept = RxNorm)
  - Each rendered as a card with the JSON snippet inspectable.
- **Approve / Edit / Reject** controls per resource (existing AI auto-resolve preserved); state stored in localStorage keyed by audit id + resource index.
- **NEW: Standard Report column** — per-patient "Generate FHIR Bundle" button that compiles all approved resources into a full FHIR R4 `Bundle` (type = `document`, with `Composition` first entry, then Patient + all approved Conditions/Observations/MedicationRequests). Displayed in a Dialog with copy-to-clipboard + download `.json`, formatted exactly as the payload pushed to the external FHIR server (`push_to_fhir` shape).

### 3. Live Terminology Matrix → FHIR CodeableConcept

- Keep patient-row layout. Each pill now backed by a CodeableConcept tuple `{system, code, display}` and the click popover shows all three fields plus category.
- Map system URIs:
  - SNOMED CT → `http://snomed.info/sct`
  - ICD-10 → `http://hl7.org/fhir/sid/icd-10-cm`
  - LOINC → `http://loinc.org`
  - RxNorm → `http://www.nlm.nih.gov/research/umls/rxnorm`
- Add "Export Patient Crosswalk" button per row → downloads a `Bundle` (type = `collection`) of CodeableConcept-wrapped resources for that MRN.
- Add summary chip: total unique systems / total codes used during admission.

### 4. Safety Alerts → FHIR-Aware Context

- Each alert card extended to show the offending RxNorm + Allergen as CodeableConcept tuples (system / code / display).
- "Why flagged" expandable section that cross-references the 48h Catalog: shows the matching ICD-10 (allergy condition), RxNorm (drug), and the SNOMED cross-reactivity finding, each linked back to its position in the taxonomy tree.
- AllergyIntolerance + MedicationRequest mini-cards (FHIR R4) rendered inline so the rationale is auditable.

---

### Technical notes

- All work confined to `src/routes/system-admin.tsx` (Medical Dictionary section) + a new helper module `src/lib/fhir-bundle.ts` for CodeableConcept + Bundle builders.
- New helper `src/lib/terminology-taxonomy.ts` builds the tree from `medical_terminology` + recent-usage joins.
- No DB schema changes — read from existing `medical_terminology`, `patients`, `lab_orders`, `medication_orders`, `nlp_audit_logs`, `clinical_safety_alerts`, `allergies`.
- Reuse existing shadcn `Collapsible`, `Dialog`, `Popover`, `Badge`, `Card`, `ScrollArea`.

### Out of scope

- No edge function changes (push_to_fhir untouched).
- No new tables / migrations.
- Other System Admin tabs (UI Controls, Users, Audit Log, Network Analytics) unchanged.
