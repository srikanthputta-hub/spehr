## Problem

The Pharmacy → Pending Verification queue keeps growing because the ghost-admission RPC (`auto_admit_ghost_patient`, runs every 5 min via pg_cron) inserts meds directly at `PENDING_VERIFICATION` on the server, then nothing advances them. The client-side cascade in `useAIAutomation.cascadeMed` only runs for orders the current tab seeds itself (`seedAdmission` skips patients that already have orders), so server-inserted orders never move.

The only thing that eventually clears them is the minute-tick `sweep_stalled_clinical_orders()` job, which force-jumps anything older than **10 minutes** straight to `Administered`. Effect: every batch of ghost admits parks 5–15 rows in Pending Verification for up to 10 minutes each cycle, and the queue looks perpetually backed up.

## Fix

Update the existing `sweep_stalled_clinical_orders()` Postgres function (already scheduled every minute) to walk orders through the normal state machine on short time thresholds, instead of only doing the 10-minute force-finalize. The client cascade for tab-seeded orders keeps working exactly as today; this only picks up rows that no client is driving.

### Cascade rules added to the sweep

Medications (skip rows with `status IN ('HELD_SAFETY_REVIEW','REJECTED','CANCELLED','REJECTED_SAFETY_ALERT')` or any linked `clinical_safety_alerts` with `status = 'Pending Review'`):

```text
Ordered / ORDERED              older than  30s  → Pending Verification (approved_at = now)
PENDING_VERIFICATION /         older than  45s  → Dispensed            (dispensed_at = now)
  Pending Verification /
  PENDING_PHARMACY
Dispensed / DISPENSED          older than  90s  → Administered         (administered_at = now)
```

Labs:

```text
Ordered / ORDERED              older than  30s  → Processing (collected_at = now)
Processing / PROCESSING        older than  90s  → Reported   (resulted_at = now, default result_value if null)
```

Keep the existing 10-minute catch-all `UPDATE`s at the bottom of the function as a final safety net, and keep the safety-alert SLA loop and HELD_SAFETY_REVIEW recovery untouched.

### Why this works

- Runs server-side every 60s → all ghost-admit meds drain in ≤ ~3 minutes end-to-end.
- Rows with active safety alerts are excluded, so allergy-triggered holds still surface correctly and can be Rejected/Overridden by the alert engine before this cascade touches them.
- No changes to `auto_admit_ghost_patient`, client automation, physician CPOE, pharmacy UI, or the safety engine. Existing tab-driven cascades still finish first (3s gaps) — this only catches orphaned server-inserted rows.

## Files changed

- `supabase/migrations/<new>.sql` — `CREATE OR REPLACE FUNCTION public.sweep_stalled_clinical_orders()` with the cascade blocks above prepended to the current body.

## Verification

- Run the migration, wait ~2 minutes, then `SELECT status, count(*) FROM medication_orders WHERE status ILIKE '%pending%' OR status ILIKE '%dispensed%' GROUP BY 1` — Pending Verification count should drop to only rows < ~45s old.
- Trigger a safety-demo ghost admit (Amoxicillin + Penicillin allergy) and confirm that order stays `HELD_SAFETY_REVIEW` until the alert is resolved instead of being cascaded to Administered.
- Watch `/pharmacy-queue` for ~2 minutes: rows should visibly transition Pending Verification → Dispensed → drop off, matching how tab-seeded orders already behave.
