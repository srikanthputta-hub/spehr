## Scope

Condition-triggered CDS order-set suggestions. Listen for the existing `nlp:approved` window event (same signal Safety Alerts already uses), match approved SNOMED codes against value sets, and surface suggestion banners on the patient chart. Display-only order sets — no auto-ordering, no schema changes.

## Order-set catalog

`src/lib/cds-order-sets.ts` — pure data + trigger matcher.

- Static `ORDER_SETS` array (Sepsis Bundle, ACS, Septic Shock, Infection Workup): each entry has `id`, `label` (e.g. "Sepsis Protocol — 3-hour bundle suggested"), `severity: 'red' | 'critical' | 'amber'`, `items: string[]` from the spec.
- Static `TRIGGERS` array — one entry per spec:
  1. Sepsis Bundle → value set `Sepsis Indicators`, any member match, streams A/B.
  2. ACS → value set `High-Acuity ED Presentations`, code ∈ {57054005, 413444003, 194828000}.
  3. Septic Shock → exact code 76571007.
  4. Infection Workup → codes ∈ {5758002, 91302008}, streams A/B.
- `matchTriggers(approvedSnomedCodes, vsCodeIndex)` → returns matched order-set ids in priority order (critical > red > amber). If Septic Shock fires it supersedes the base Sepsis Bundle (dedupe: drop `sepsis-bundle` when `septic-shock` present).

Value-set code lookup piggybacks on the already-loaded cache from `src/lib/safety-alerts-engine.ts` via its existing `ensureValueSetsLoaded()` export — both `Sepsis Indicators` and `High-Acuity ED Presentations` are already in that set. Adds no extra Supabase fetch.

## CDS watcher hook

`src/hooks/useCdsSuggestionsWatcher.ts` — mounted once from `src/routes/__root.tsx` alongside `useSafetyAlertsWatcher`.

- Listens for `window` `nlp:approved` events.
- On fire: reuses the same fetch pattern as the safety watcher — pulls the 5 most recent approved `nlp_audit_logs` rows for the MRN, flattens the SNOMED code array from `standardized_output["SNOMED CT"]`.
- Calls `matchTriggers(codes, vsIndex)` then writes results to `localStorage["spehr.cds.suggestions.${mrn}"]` as `{ suggestions: [{id, label, severity, items, firedAt}], version: 1 }`. One suggestion per trigger per admission — dedupe by trigger id already present in stored payload; new admission is detected by a stored `admissionKey` field (composed of MRN + latest `admission_time` from `patients`; if it changes, clear old entries).
- Dispatches a `spehr:cds` window event with `{ mrn }` so open chart views update immediately.

## Chart integration

`src/components/patient/CdsSuggestionsBanners.tsx` — new component.

- Props: `mrn`.
- Reads `localStorage["spehr.cds.suggestions.${mrn}"]` on mount and on `spehr:cds` events (and `storage` events for cross-tab).
- Renders one stacked banner per suggestion above the chart content. Severity styling:
  - `critical` — deep red border + darker fill, "🔴" prefix.
  - `red` — red border/fill, "🔴" prefix.
  - `amber` — amber border/fill, "⚠" prefix.
- Each banner has a "View Order Set" button and a dismiss (×) button. Dismiss flips a `dismissed:true` flag in the same localStorage record — banner hides but suggestion stays (spec: one per trigger per admission).
- "View Order Set" opens a slide-over panel (right-side sheet, fixed inset-y-0 right-0 w-96) listing the order-set items as a bulleted read-only list, header shows the label + severity, footer "Close" button. No ordering actions.

Mount point in `src/routes/patient.$mrn.tsx`: insert `<CdsSuggestionsBanners mrn={patient.mrn} />` right next to the existing `<DischargeConformanceBanner />` insertion (single line, same location).

## Wiring in root

`src/routes/__root.tsx` — add `useCdsSuggestionsWatcher()` alongside the existing `useSafetyAlertsWatcher()` call. Nothing else changes.

## Untouched

- Safety Alerts engine, NLP pipeline, admission form, discharge validation, Value Set Library, cohort strip, chart layout.
- `custom_value_sets`, `nlp_audit_logs`, and every other table — no schema changes, no migrations.
- No new secrets, no new edge functions or server routes.

## Files touched

- Add: `src/lib/cds-order-sets.ts`
- Add: `src/hooks/useCdsSuggestionsWatcher.ts`
- Add: `src/components/patient/CdsSuggestionsBanners.tsx`
- Edit: `src/routes/__root.tsx` (one hook call)
- Edit: `src/routes/patient.$mrn.tsx` (import + one tag)
