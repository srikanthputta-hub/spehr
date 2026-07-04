## Scope

Wire live UMLS-backed terminology into 4 admission-form fields. All calls go through `umls-proxy` only. No ancestor filtering (lenient — trust `sabs`). Vitals/Labs dropdowns skipped per your answer.

## Fields wired

| Field | Current shape | New behavior |
|---|---|---|
| Chief Complaint (§2) | textarea | Type-ahead → `umls-proxy` `search`, `sabs: SNOMEDCT_US` |
| PMH Chronic Illnesses (§4) | ChipGroup of static CHRONIC_OPTIONS | Type-ahead → SNOMED, adds selected concept as a chip |
| Current Medications name (§5) | plain input | Type-ahead → `umls-proxy` `search`, `sabs: RXNORM` |
| Drug Allergies name (§5) | plain input | Type-ahead → SNOMED |

Debounce 300 ms, min 2 chars, loading spinner in dropdown. On umls-proxy failure: dropdown closes, inline "Terminology server unavailable" hint, plain text entry still writes to the field, submission not blocked.

## Data storage

`IntakeRecord` fields today store plain strings. To satisfy `{display, code, system}` per selection without breaking existing readers (auto-doc, coding pipeline, admit-patient.ts), we store the coded metadata alongside — not replacing — the string:

- `chiefComplaint` (string) unchanged. New optional `chiefComplaintCode?: { code, display, system }`.
- `chronicIllnesses: string[]` unchanged. New optional `chronicIllnessCodes?: Array<{code, display, system}>`.
- `drugAllergies[i]` gains optional `code?: {code, display, system}`.
- `currentMeds[i]` gains optional `code?: {code, display, system}` (RxNorm rxcui).

Selecting from the dropdown writes both the display string (into the existing field, so nothing downstream breaks) and the coded object. Free-typed text still works; coded object simply stays undefined and existing `resolveRxNorm`/`resolveSnomed` calls in the coding pipeline handle it as today.

## New files

- `src/lib/terminology-search.ts` — thin wrapper `searchTerminology({ query, sabs, pageSize })` calling `supabase.functions.invoke("umls-proxy", { body: { action: "search", params: { string, sabs, returnIdType: "code", pageSize: 10 } } })`. Returns `Array<{code, display, system}>` mapping SNOMEDCT_US→"SNOMED CT", RXNORM→"RxNorm". Throws on network error so caller can show fallback notice.
- `src/hooks/useTerminologySearch.ts` — debounced (300 ms) type-ahead hook: `{query, setQuery, results, loading, error, clear}`, cancels stale requests via a request-id ref (same pattern as existing `useTerminologyResolution`).
- `src/components/admissions/TerminologyCombobox.tsx` — presentational combobox: text input + absolute-positioned dropdown listing `display · code`, keyboard nav (↑/↓/Enter/Esc), click-outside close. Props: `value, onChange(text), onSelect({code,display,system}), sabs, placeholder`. Renders spinner while loading, red inline hint on error, "no matches" when empty.

## Edits

- `src/lib/intake-record.ts` — add the optional coded fields listed above to `IntakeRecord`, `AllergyEntry`, `MedEntry`; extend `blankIntake()` accordingly. Auto-fill / SOAP / all existing readers untouched (fields are optional).
- `src/components/admissions/AdmitPatientModal.tsx` — swap 4 controls:
  1. CC textarea → `TerminologyCombobox` (multiline preserved via textarea variant OR keep textarea plus a small "Code lookup" button that opens the combobox in a popover — I'll use the popover approach so free narrative typing is preserved).
  2. Each `intake.chronicIllnesses` ChipGroup keeps existing static chips; **add** a search combobox above the chip group; selecting appends the display to `chronicIllnesses` and pushes code to `chronicIllnessCodes`.
  3. Drug allergy name `<Input>` → `TerminologyCombobox` (SNOMED, root note only).
  4. Current med name `<Input>` → `TerminologyCombobox` (RXNORM).

No changes to field order, section order, validation, or `onSubmit` payload construction. `handle()` continues to build `AdmitInput` exactly as today; the new coded fields ride along inside `intake`.

## Untouched

NLP pipeline, Safety Alerts, Approval Trail, Value Set Library, `fhir-terminology` (never called), `admit-patient.ts` write path, coding pipeline. Vitals/Labs dropdowns explicitly out of scope this turn.
