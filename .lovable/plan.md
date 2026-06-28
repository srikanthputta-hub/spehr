
## Goal
Replace the Medical Dictionary's current 6 tabs with a 7-tab Clinical Terminologist Workbench backed by live UMLS + a new FHIR terminology Edge Function. Other Command Center tabs (UI & Feature Controls, Users, Audit Log, Network Analytics) and the Medical Dictionary's NLP Audit Logs / Live Terminology Matrix / Safety Alerts tabs are untouched.

## New tab structure
```
Value Set Library | Authoring Workbench | Cross-Map Studio |
NLP Audit Logs | Live Terminology Matrix | Safety Alerts | FHIR Terminology Server
```

## Build steps

### 1. Database migration
Extend `custom_value_sets` with: `oid`, `type` (extensional|intensional), `intensional_rule jsonb`, `clinical_application`, `fhir_url`, `steward`, `peer_reviewer`, `version`, `change_history jsonb`. Keep existing `codes jsonb`, `status`, `vocabulary`.

### 2. UMLS-resolved seed script
One-shot Node script `scripts/seed-value-sets.ts` (run via `bun`) that:
- For each of the 12 spec'd value sets, calls the existing `umls-proxy` edge function for every code to fetch CUI + canonical display.
- Upserts the resolved rows into `custom_value_sets` with full FHIR OID, type, intensional rule (for the 5 intensional sets), and metadata.
- Run once at build time; codes get stored permanently in `codes JSONB`.

### 3. New `fhir-terminology` Edge Function
`supabase/functions/fhir-terminology/index.ts` exposes 3 actions returning real FHIR R4 `Parameters` resources:
- `$lookup` (CodeSystem) — proxies to UMLS for code details.
- `$expand` (ValueSet) — reads `custom_value_sets`, for intensional rules calls UMLS descendants; returns expansion contains[].
- `$translate` (ConceptMap) — calls `umls-proxy` crosswalk action, returns match[] with equivalence.
Wired up via `verify_jwt = false` in config.toml.

### 4. Header status strip
Replace the dashed Terminology Intelligence cards with a thin strip:
`UMLS API ● Live <ms> | Value Sets: X published · Y in review · Z draft | Cache hit rate | Last resolved <s>s ago`. Stats pulled from `terminology_audit` + `custom_value_sets`.

### 5. Tab 1 — Value Set Library (`src/components/admin/dictionary/ValueSetLibrary.tsx`)
Registry table + right-side `Sheet` drawer with 4 sub-tabs (Concept Members, Intensional Rule Editor, Metadata & Governance, FHIR Preview). Drawer's `$expand` button calls the new edge fn.

### 6. Tab 2 — Authoring Workbench (`AuthoringWorkbench.tsx`)
Split panel: left side debounced UMLS concept search + hierarchy browser (calls `umls-proxy` for parents/descendants); right side active value-set editor with included/excluded lists, editorial notes, validation summary. Save → upsert to `custom_value_sets` as Draft.

### 7. Tab 3 — Cross-Map Studio (`CrossMapStudio.tsx`)
Single-code translator + batch crosswalk (textarea/CSV) + pre-populated 10-row reference table + `ConceptMap` JSON preview. All translations go through the new `$translate` action.

### 8. Tab 7 — FHIR Terminology Server (renamed from FHIR Interoperability)
Section A: 3 interactive operation cards ($lookup, $expand, $translate) hitting the new edge function with real responses displayed.
Section B: existing FHIR encounter bundle table + sync status preserved underneath.

### 9. Wire tabs into `system-admin.tsx`
Update Tabs list and remove "Catalog" + "AUTO API" tabs (AUTO API stats fold into the header strip).

## Files
- New: `supabase/functions/fhir-terminology/index.ts`, `scripts/seed-value-sets.ts`, `src/components/admin/dictionary/{ValueSetLibrary,AuthoringWorkbench,CrossMapStudio,FhirTerminologyServer,TerminologyStatusStrip}.tsx`, drawer sub-components.
- Edit: `src/routes/system-admin.tsx` (tabs only), `supabase/config.toml` (function decl).
- Migration: extend `custom_value_sets`.

## Out of scope
NLP Audit Logs, Live Terminology Matrix, Safety Alerts, all other Command Center tabs, the existing FHIR encounter bundle table (preserved as-is under Tab 7 Section B).
