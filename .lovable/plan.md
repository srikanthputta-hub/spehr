# Expand Crosswalk Results table

Make the single-translate "Crosswalk Results — SNOMED CT → ICD-10-CM" table render the same 8 columns as the Pre-populated Crosswalk Library:

`Source Code · Source Name · Vocab · CUI · Target Code · Target Name · Vocab · Map Type`

## Scope

- File: `src/components/admin/dictionary/CrossMapStudio.tsx`
- Component: results table inside `translate()`'s `result` render block only.
- No schema, no edge function, no other UI changes.

## Data changes in `translate()`

Currently we only capture `matches[].code/display` and a source display name. Extend the shape so each row has everything the table needs.

1. **Source Name** — already resolved via the `umls-proxy` `validate` call (`sourceDisplayName`). Keep it and pass into result state.
2. **Source Vocab** — `src.label` (already in scope).
3. **CUI** — capture from the crosswalk response. `umls-proxy` `crosswalk` returns matches that include the bridging CUI (commonly `m.cui` or `m.ui`); read whichever is present per match and fall back to the source `validate` response's CUI (`vd.result.ui` / `vd.result.cui`) when a match omits it. Store on each match.
4. **Target Code / Target Name / Target Vocab** — already have `code`, `display`, and `tgt.label`.
5. **Map Type** — `umls-proxy` crosswalk matches carry a relation/mapType field (e.g. `m.relation`, `m.mapType`, or `m.rela`); use it when present, otherwise default to `Equivalent` (matches the current hardcoded `equivalence: "equivalent"` behavior). Display capitalized.

Extend the `MapMatch` type to:
```
{ code, display, targetSystem, cui, mapType }
```
and add `sourceCode`, `sourceName`, `sourceVocab`, `targetVocab` to the outer `result` object so the render doesn't have to recompute per row.

## Render changes

Replace the current 3-column `<table>` (Target Code / Display / Equivalence) with an 8-column table using the same styling as the Pre-populated Crosswalk Library table (`text-[11px]`, `border-slate-200`, `bg-slate-50` header, hover rows). Every row repeats the resolved source columns (Source Code, Source Name, Source Vocab, CUI) alongside its per-match target columns.

Keep the existing "Source: {code}" line above the table and the "No crosswalk found" empty state.

The FHIR ConceptMap JSON block below the table stays unchanged (it already carries display + equivalence).

## Non-goals

- Batch Crosswalk table (already fine, out of scope).
- Reference library table (unchanged).
- Activity log, FHIR op card (unchanged).
