## Problem

Manual orders trigger the Drug-Allergy Safety Alert correctly, but automation-created orders (Auto Doc cascade) march straight to **Administered** without ever being held for review.

## Root cause

In `src/hooks/useAIAutomation.ts` the automation seed does three things in fire-and-forget sequence:

1. `INSERT` into `medication_orders` with `status: "Ordered"` — no `rxnorm_code` yet.
2. `autoCodeMedication(...)` — resolves RxNorm asynchronously (UMLS round-trip) and, only after the code lands, calls `runMedicationOrderRules(...)`.
3. `cascadeMed(...)` — waits `TRANSITION_GAP_MS` (3s) and unconditionally writes `Pending Verification → Dispensed → Administered`.

Two failure modes result:

- The realtime `INSERT` handler in `useSafetyAlertsWatcher` fires immediately with `rxnorm_code = null`, so Rule 1 sees no code and does nothing.
- Even when `autoCodeMedication` later re-runs `runMedicationOrderRules` and the engine sets `status = "HELD_SAFETY_REVIEW"`, `cascadeMed` has already queued blind updates that overwrite the hold — the order flips to `Administered` a few seconds later.

Manual orders don't hit this because the physician CPOE form writes `rxnorm_code` at insert time and does not run a status cascade.

## Fix (behavior-only, no schema changes)

### 1. `src/hooks/useAIAutomation.ts`

- Change `autoCodeMedication` invocation in `seedAdmission` to **await** completion before starting `cascadeMed`, so the RxNorm code is populated and Rule 1 has already fired (or not) by the time the cascade begins. Convert `autoCodeMedication` to return its inner promise (currently `void`-wrapped).
- In `cascadeMed`, before every transition update, re-read the order's current `status`. If it is `HELD_SAFETY_REVIEW` (or anything other than the expected prior state), **abort the cascade** — no further updates, no `Administered`.
- Guard `sweepOrphans` the same way: its `.in("status", [...])` list already excludes `HELD_SAFETY_REVIEW`, so held rows won't be auto-finalized — leave as-is, just add a comment noting the invariant.

### 2. `src/lib/auto-code.ts`

- Have `autoCodeMedication` return `Promise<void>` (still callable fire-and-forget for existing callers) so the automation cascade can await it. No signature change for other callers.

### 3. Verification

- Admit MRN-989807 (srik Smith, penicillin allergy) via automation. When Auto Doc tries to order amoxicillin/penicillin, the safety alert must appear on the physician board AND the order must remain in `HELD_SAFETY_REVIEW` (never reach `Administered`) until a clinician resolves it — mirroring the manual-order behavior in your first screenshot.
- Regression: order a non-penicillin med via automation → cascade completes to `Administered` as before.
- Typecheck with `tsgo`.

## Non-goals

- No changes to the pair registry, value sets, or Rules 2/3/4.
- No new tables, no schema/RLS changes.
- No UI changes.