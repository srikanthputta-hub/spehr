## Scope

Add a pre-push conformance check that validates every coded element in the discharge FHIR bundle against its binding value set. Runs from the existing background sync in `src/hooks/useBackgroundFhirSync.ts` — the single choke-point before `fhir-proxy` receives the bundle. Fail-open in all failure modes.

## New helper

`src/lib/discharge-conformance.ts` — exports `validateDischargeConformance(bundle, mrn)` returning `{ ok: boolean, invalid: InvalidCode[] }`.

Steps inside the helper:

1. **Extract coded elements from the assembled bundle** (bundle already exists, we don't re-derive from tables):
   - `Condition.code.coding[]` — split by `Condition.category`: `encounter-diagnosis` → "ED Chief Complaints", `problem-list-item` (PMH) → "Chronic Conditions". SNOMED codings only (`system` contains `snomed.info/sct`).
   - `MedicationRequest.medicationCodeableConcept.coding[]` and `MedicationAdministration.medicationCodeableConcept.coding[]` → "Medicinal Products". RxNorm + SNOMED.
   - `AllergyIntolerance.code.coding[]` → "Allergy Substances". SNOMED only.
   - `Observation.code.coding[]` — vital-signs category → "Vital Signs Observations"; laboratory category → "ED Lab Panels". LOINC only.
2. **Resolve value set OIDs** by NAME from `custom_value_sets` at runtime (`status = 'published'`), 5-minute in-module cache. Missing value set → skip that binding, treat as valid.
3. **Fan out `Promise.allSettled`** POSTs to `/api/public/umls-validate-code`, one per `{ system, code, valueSetOid }`. In-module memo keyed on `system|code|oid` so repeated codes across an encounter cost one call.
4. Any rejected promise or `{ valid: false }` response → push to `invalid[]` with `{ code, display, system, element, valueSetName }`. Rejections (network errors) are logged as errors but do NOT count as invalid — fail open per spec.
5. Return `{ ok: invalid.length === 0, invalid }`.

## Logging

For every entry in `invalid[]`, insert into `auto_doc_logs` (client via existing `supabase` client — table already writable):

```
level:   'error'
stage:   'discharge-conformance'
message: `Non-conformant code ${code} in ${element} for MRN ${mrn} — not in value set ${name}`
mrn:     mrn
```

For endpoint-failure branch: single `auto_doc_logs` row `level:'error'`, `stage:'discharge-conformance'`, message `"umls-validate-code unavailable — discharge push proceeded without validation for MRN ${mrn}"`.

## Warning banner surface

Persist result to `localStorage` key `spehr.discharge.conformance.${mrn}` as `{ count, at, dismissed:false }` so the chart view can pick it up without a schema change. Write happens in the sync hook after validation.

`src/routes/patient.$mrn.tsx` — inside the existing patient chart view, above the toolbar or at the top of the main card (near the existing status/quality strip), add a dismissable `DischargeConformanceBanner` component:

- Reads the localStorage key for this MRN on mount + on a `spehr:conformance` window event.
- Renders only when `count > 0 && !dismissed`.
- Amber banner: `⚠ ${count} non-conformant codes detected — review before sharing externally` + `Dismiss` button that flips `dismissed:true` in localStorage.
- Zero layout change to the rest of the chart.

New tiny component file: `src/components/patient/DischargeConformanceBanner.tsx`.

## Sync-hook integration

Edit `src/hooks/useBackgroundFhirSync.ts` inside the `pushNext` handler (around line 350, after `assessBundleQuality`, before the `isDischarged` branch pushes):

```
if (isDischarged) {
  const result = await validateDischargeConformance(bundle, target.mrn);
  // result already logged + persisted inside helper; never throws.
  // Push proceeds unconditionally.
}
```

Wrapped in `try/catch` — any thrown error is swallowed, logged, and the push continues. Conformance validation runs only on the discharge branch, not on in-progress admissions.

## Untouched

- `fhir-proxy` edge function, bundle assembly in `fhir-bundle.ts` and `fhir-admission-discharge.ts` — bundle structure unchanged.
- NLP pipeline, Safety Alerts, Approval Trail, admission form, Value Set Library.
- No new migrations, no schema changes, no new secrets. `auto_doc_logs` and `custom_value_sets` used as-is.
- `/api/public/umls-validate-code` endpoint used exactly as built in Integration 1 — no changes.

## Files touched

- Add: `src/lib/discharge-conformance.ts`
- Add: `src/components/patient/DischargeConformanceBanner.tsx`
- Edit: `src/hooks/useBackgroundFhirSync.ts` (single insertion in `pushNext`)
- Edit: `src/routes/patient.$mrn.tsx` (mount the banner in the existing chart layout)
