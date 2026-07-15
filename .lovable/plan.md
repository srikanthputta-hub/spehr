# Fix VSAC import to preserve value-set type

## Problem

`handleVsacImport` in `src/components/admin/dictionary/ValueSetLibrary.tsx` inserts every VSAC import with a hardcoded `type: "extensional"`. The `umls-proxy` `vsacExpand` action only calls `/ValueSet/{oid}/$expand`, which returns the flattened expansion and never exposes whether the source is a Grouping, Intensional, or Extensional value set. So a Grouping VS like `2.16.840.1.113762.1.4.1300.3` (Comprehensive Ischemic Stroke Diagnoses) lands as Extensional.

## Fix

Determine the type from the ValueSet's `compose` definition (fetched from VSAC without `$expand`) and pass it through:

- `compose.include[]` contains any entry with a `valueSet` reference → **grouping**
- otherwise any entry has a `filter` → **intensional**
- otherwise → **extensional**

## Changes

### 1. `supabase/functions/umls-proxy/index.ts` — `vsacExpand`

- In addition to `GET /ValueSet/{oid}/$expand`, also `GET /ValueSet/{oid}` (definition) using the same Basic auth.
- Inspect `resource.compose.include[]` on the definition response and compute `type: "grouping" | "intensional" | "extensional"`. Default to `"extensional"` if `compose` is missing.
- Add `type` to the returned object. If the definition call fails, still return the expansion with `type: "extensional"` as a safe fallback (don't fail the whole import).

### 2. `src/components/admin/dictionary/ValueSetLibrary.tsx`

- Extend the `vsacResult` state shape to include `type`.
- In `handleVsacFetch`, set `result.type = data.type ?? "extensional"`.
- In `handleVsacImport`, replace the hardcoded `type: "extensional"` with `vsacResult.type`.
- Optional: show the detected type as a small badge next to the fetched preview so the user sees "Type: Grouping" before clicking Save.

## Out of scope

- Expanding grouping value sets into their member OIDs (VSAC's `$expand` already flattens all leaf codes; we preserve them as-is).
- Editing the intensional_rule column — that stays null for VSAC imports; the `type` field alone drives the Library badge.
- No schema/migration changes.

## Verification

- Import OID `2.16.840.1.113762.1.4.1300.3` → row shows Type = `Grouping` in Value Set Library.
- Import a known intensional VS → Type = `Intensional`.
- Import a plain extensional VS → Type = `Extensional` (unchanged).
- Typecheck clean.
