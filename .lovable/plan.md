## Scope

Replace hardcoded SNOMED lists with live cohort counts driven by the published value sets in `custom_value_sets`. Five cohorts (Diabetic, Respiratory, Cardiac, Sepsis, High-Acuity) render on both boards and inside the admin Network Analytics tab. Read-only, additive UI.

## New hook

`src/hooks/useCohortCounts.ts` — single shared source of truth.

- Loads the five value sets from `custom_value_sets` by NAME
  (`status = 'published'`): `Diabetes Mellitus`, `Respiratory Conditions`,
  `Cardiac Conditions`, `Sepsis Indicators`, `High-Acuity ED Presentations`.
- Extracts the code list from each row: for extensional sets, read
  `codes[].code`; for intensional sets, read `codes[].code` if present AND
  append the root code parsed from `intensional_rule` (or the hardcoded root
  fallback: 73211009, 50043002, 56265001 — spec's "include the root concept
  code in the match list"). Full ECL descendant expansion is not done
  client-side, per spec.
- Queries `conditions` table in one round trip per cohort:
  `select mrn from conditions where snomed_code = ANY($1) and clinical_status = 'active'`
  (falls back to no status filter if the code list is empty) — count of
  DISTINCT `mrn` is the cohort size.
- Also unions matches from `nlp_audit_logs` where a row's `standardized_output`
  contains any of the SNOMED codes and its `approval_status = 'approved'`
  (or `status = 'approved'`, whichever the table uses — schema check at build
  time). MRN de-dup across both sources.
- Returns `{ counts: Record<CohortKey, number>, loading, error, lastRefreshed }`.
- Refresh: on mount + every 60 seconds via `setInterval`. Value-set fetch is
  cached in-module for 5 minutes; count queries re-run on every tick.

Failure modes: any query error → that cohort shows `—`; hook never throws.

## New tile component

`src/components/analytics/CohortCountsStrip.tsx` — presentational only.

- Props: `counts`, `loading`.
- Renders a compact horizontal strip of 5 tiles (label + count + tiny
  icon). Neutral card styling matching existing surfaces; no color-coded
  severity. Skeleton `—` while loading.
- Zero interaction. No drill-down in this task.

## Mount points (additive, no layout rework)

1. `src/routes/nursing-board.tsx` — insert `<CohortCountsStrip />` at the
   top of the main content area, above the existing patient grid. One
   `useCohortCounts()` call at the top of the component.
2. `src/routes/physician-board.tsx` — same insertion at the top of its
   main content area.
3. `src/routes/analytics.tsx` — insert the strip at the top of
   `AnalyticsPage`, above the existing summary cards. (This surface is what
   `system-admin` embeds under the Network Analytics tab, so admin
   automatically picks it up — no `system-admin.tsx` edit needed.)

Each mount is a single added line + one hook call. No changes to existing
markup, card design, filters, or refresh cycles.

## Untouched

- ED board layout, patient card design, patient grid.
- Any other analytics widget, PopulationHealth, existing summary cards.
- NLP pipeline, Safety Alerts, admission form, discharge validation,
  Value Set Library, custom_value_sets contents.
- No new tables, no migrations, no secrets.

## Files touched

- Add: `src/hooks/useCohortCounts.ts`
- Add: `src/components/analytics/CohortCountsStrip.tsx`
- Edit: `src/routes/nursing-board.tsx` (import + one tag)
- Edit: `src/routes/physician-board.tsx` (import + one tag)
- Edit: `src/routes/analytics.tsx` (import + one tag)
