## Goal
Cap the **ghost/auto-admitter** so the "Currently Active Census" (patients with `status = 'Admitted'`) settles at ~85 across the network. Manual admissions from any UI (Nurse board, Admissions/Reception, Admit Patient modal) are **never blocked** — they can always push the census above 85; the ghost stream simply pauses until the census drops back under the cap.

## Root cause
`public.auto_admit_ghost_patient()` (called every 5 min by pg_cron) unconditionally inserts a batch of 3–4 ghost patients per tick. There's no census-aware guard, so the pool climbs to ~100. Manual admits go through `src/lib/admit-patient.ts` → direct `patients` INSERT and never touch this function, so gating the function is safe.

## Change (single DB migration, no frontend edits)

`CREATE OR REPLACE FUNCTION public.auto_admit_ghost_patient()` — same body as the current version, with one guard block added at the top, right after the `automation_enabled` short-circuit and the orphan-bed reconciliation:

```sql
SELECT COUNT(*) INTO active_census
  FROM public.patients
 WHERE lower(status) = 'admitted';

headroom := 85 - active_census;
IF headroom <= 0 THEN
  RETURN;  -- at/over cap: skip this ghost tick, natural discharges drain
END IF;

batch_n := 3 + (CASE WHEN random() < 0.47 THEN 1 ELSE 0 END);
IF batch_n > headroom THEN batch_n := headroom; END IF;
```

Everything else (patient generation, bed claim, safety-demo counter, chronic/med seeding, `set_target_discharge_at` trigger, `ghost-discharge-worker` cadence) is left untouched.

## Behavior after change
- **Ghost auto-admits**: pause when census ≥ 85; resume automatically the next tick after discharges drain it below 85. Self-balancing at ≈85.
- **Manual admits** (Nurse board "Admit Patient", Admissions/Reception, any UI flow): **fully unaffected** — they call `admit-patient.ts` directly and the census can legitimately exceed 85 when staff admit real patients. The ghost stream just holds off until census drops again.
- **Cold start with 100 admitted**: ghost admits pause; ghost-discharge-worker keeps draining ~3–4 per 5-min tick; census walks down to 85 within ~15–20 min and holds.
- **`automation_enabled = false`**: unchanged (still returns immediately).

## Files touched
- `supabase/migrations/<new-timestamp>_cap_ghost_census_at_85.sql` — the `CREATE OR REPLACE FUNCTION` above.

No frontend, hook, edge-function, or UI code is modified. No admit path is disabled or restricted.

## Verification
- Run migration via DB migration tool.
- `SELECT COUNT(*) FROM patients WHERE lower(status)='admitted'` a few minutes later — trends toward ≤ 85.
- Confirm manual admit from the Admissions board still succeeds when census = 85 (it will; the guard lives only in the ghost function).
