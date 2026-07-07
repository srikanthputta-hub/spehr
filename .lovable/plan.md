## Problem

In **Medical Dictionary → Authoring Workbench**, the "UMLS Concept Search" input silently returns nothing for many queries (e.g. numeric codes like `723`, or any RxNorm term), while the **Search Terminology** modal on the same page returns results correctly for the identical query.

## Root cause

`src/components/admin/dictionary/AuthoringWorkbench.tsx` (`runSearch`) invokes the `umls-proxy` edge function using **per-vocabulary actions**:

```ts
supabase.functions.invoke("umls-proxy", {
  body: { action: v.action, params: { string: q, sabs: v.value, pageSize: 15 } },
});
```

where `v.action` is one of `snomed | icd10 | loinc | rxnorm | meddra`. Two things break:

1. **`rxnorm` action is not a UMLS search** — it hits RxNav `/rxcui.json?name=…&search=1`, expects the `drugName` param (not `string`), and returns `{ idGroup: { rxnormId: [...] } }` — not `result.results`. So `setResults(data?.result?.results ?? [])` is always `[]` for the RxNorm vocabulary regardless of input.
2. **`snomed | icd10 | loinc | meddra` actions** are hardcoded to `returnIdType: "sourceUi"` and small `pageSize`, and don't accept the caller's `sabs`. Numeric-looking queries and code lookups don't match by `sourceUi` and often return nothing.

Meanwhile, `Search Terminology` (and `SemanticAutocomplete`, `useTerminologySearch`) all use the generic `action: "search"` with `returnIdType: "code"` — which works uniformly for every vocabulary and for both text and code queries. That's why the modal works and the workbench doesn't.

## Fix

Switch `AuthoringWorkbench.runSearch` to the same unified `search` action other components use.

### Changes — `src/components/admin/dictionary/AuthoringWorkbench.tsx`

1. Drop the `action` field from `VOCABS` (no longer needed; sabs alone identifies the vocabulary):

   ```ts
   const VOCABS = [
     { label: "SNOMED CT", value: "SNOMEDCT_US" },
     { label: "ICD-10-CM", value: "ICD10CM" },
     { label: "LOINC",     value: "LNC" },
     { label: "RxNorm",    value: "RXNORM" },
     { label: "MedDRA",    value: "MDR" },
   ];
   ```

2. Update `runSearch` to call the unified `search` action:

   ```ts
   const { data } = await supabase.functions.invoke("umls-proxy", {
     body: {
       action: "search",
       params: {
         string: q,
         sabs: v.value,
         returnIdType: "code",
         pageSize: 15,
       },
     },
   });
   const hits = (data?.result?.results ?? []).filter(
     (r: any) => r?.ui && r.ui !== "NONE"
   );
   setResults(hits);
   ```

3. Surface upstream errors so a failed lookup is visible instead of "no results":
   - Destructure `{ data, error }` from `functions.invoke`; on `error` set a small `err` state and render a one-line "Terminology server unavailable" hint below the input (same UX pattern as `SemanticAutocomplete`).
   - Reset `err` at the start of each search.

### System-wide audit (no other changes needed)

Verified the three other call sites that hit `umls-proxy` for search-style lookups already use the correct pattern:

- `src/hooks/useTerminologySearch.ts` → `action: "search"` with `returnIdType: "code"` ✓
- `src/lib/terminology-search.ts` → same ✓
- `src/components/physician/SemanticAutocomplete.tsx` → `/api/public/umls-search` route, which itself uses `search` + `returnIdType: "code"` ✓
- `SearchTerminology` modal → same ✓

Only the Authoring Workbench was on the broken path.

## Verification

1. Typecheck (`bunx tsc --noEmit`).
2. In preview: open Medical Dictionary → Authoring Workbench, pick RxNorm, type `723` → expect result `amoxicillin` (same as Search Terminology modal). Repeat with SNOMED (`22298006` → myocardial infarction), ICD-10-CM (`E11.9`), LOINC (`718-7` hemoglobin). All should return results.
3. Confirm existing prefill flow (`spehr:authoring-prefill` custom event) still works — no change to that path.

## Out of scope

No backend / edge-function / schema changes. No changes to the Search Terminology modal, autocompletes, or other consumers.
