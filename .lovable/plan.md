## Goal

Every clinical safety alert should visibly name the published Value Set(s) from the Value Set Library that caused it to fire (e.g. "Anticoagulants", "Sepsis Indicators", "Penicillin Allergens × Penicillin Class Drugs").

## Approach

Compute the matching value set name(s) at fire time inside `src/lib/safety-alerts-engine.ts`, thread them through `fireAlert`, and render them in the two consumer UIs. No DB schema change — the names are appended to the existing `family` text (already stored and already rendered) and also mirrored into `auto_doc_logs.meta.valueSetNames` for the CDS Decisions feed.

### 1. Engine — `src/lib/safety-alerts-engine.ts`

- Extend `FireInput` with `valueSetNames: string[]`.
- Change `family` composition to:
  `"<message> · Value Sets: <A>, <B> [ruleKey:triggerCode] (triggerDisplay)"`
  (marker preserved so `alreadyFired` dedupe keeps working.)
- Include `valueSetNames` in the `auto_doc_logs.meta` payload.
- Determine names per rule:
  - **Rule 1 (Drug-Allergy):** the specific `VsRow.name` from `pair.drugSets` whose `codes` contain the ordered RxNorm, plus the `VsRow.name` from `pair.allergenSets` whose codes contain the matched allergy SNOMED. Add a small helper `firstContaining(sets, code)` that returns the matching `VsRow` (replaces `anyContains` at the two call sites that need the name).
  - **Rule 2 (Anticoagulant Bleeding):** always `["Anticoagulants"]`; if the conflicting med is an NSAID, add `"NSAIDs"`.
  - **Rule 3 (High-Acuity):** `["High-Acuity ED Presentations"]`.
  - **Rule 4 (Sepsis):** `["Sepsis Indicators"]`.

### 2. Patient banner — `src/components/patient/SafetyAlertBanner.tsx`

Parse the new `· Value Sets: …` segment out of `alert.family` and render it as a subtle chip row under the existing family line, e.g.
`Value Sets: [Anticoagulants] [NSAIDs]`.
Falls back gracefully for older rows without the segment.

### 3. Physician queue — `src/components/physician/PatientSafetyAlertQueue.tsx`

Same parse+render treatment on each pending alert card (adds a "Triggered by" chip row below the existing family text). No behavioral changes to Override/Reject.

### 4. CDS Decisions feed

Already reads `family` from `clinical_safety_alerts`, so the appended segment shows up automatically. The `auto_doc_logs.meta.valueSetNames` addition is purely for downstream analytics/debugging.

## Out of scope

- No changes to sweep function, cron, or the auto-decide/override pipeline.
- No new DB column and no migration — reusing `family` keeps the change contained and backfill-free.
- No changes to CDS Hook static rules (`CdsHookAlert.tsx`) — those aren't value-set driven in the same way; can be a follow-up if desired.

## Verification

- Trigger a fresh order in the physician board that fires each rule and confirm the value set name appears on the banner, in the pending queue card, and in the CDS Decisions row.
- `alreadyFired` dedupe still works because the `[ruleKey:triggerCode]` marker is unchanged.
- Typecheck.
