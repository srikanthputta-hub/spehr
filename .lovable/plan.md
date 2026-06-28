# Rebalance Patient Flow → 1,000 admits / 24 h

## The math

- Target: **1,000 admissions / 24 h** network-wide
- Rate: 1000 / 1440 min = **0.694 admits per minute** ≈ one every **86 seconds**
- Per facility (5 sites): **200 / day** ≈ 8.3 / hr
- Bed capacity: 20 beds × 5 facilities = **100 beds**
- Required average length of stay to hold steady: `100 beds × 24 h ÷ 1000 = 2.4 h` per patient
- Discharge rate **must equal admit rate** = 1,000 / 24 h, otherwise beds saturate or empty

Cron granularity is 1 minute, so we drive the loop every 5 min and admit a small batch:
- 288 ticks/day × **~3.47 admits/tick** = 1,000/day
- Implement as `3 + (random() < 0.47 ? 1 : 0)` → averages 3.47

## Current state (measured)

| Thing | Now | Result |
|---|---|---|
| `auto_admit_ghost_patient` loop | 4 patients/call | up to 1,152/day |
| `ghost_triage_job` cron | every 5 min | 288 ticks/day |
| `auto_discharge_ghost_patients` loop | up to 8 (only beyond top-5 recent/facility) | starves discharges |
| `ghost_discharge_job` cron | every 10 min | 144 ticks/day |
| Client watchdog `GHOST_ADMIT_INTERVAL_MS` | 90 s | extra +960/day fighting cron |
| `set_target_discharge_at` interval | 5–21 min | LOS way too short |

Net: admits and discharges are out of sync, and the client tick double-drives admissions.

## Changes

### 1. SQL migration — three routines

- **`auto_admit_ghost_patient()`** — replace `FOR i IN 1..4` with `FOR i IN 1..(3 + (random() < 0.47)::int)` so each 5-min tick averages 3.47 admits → 1,000/day.
- **`auto_discharge_ghost_patients()`** — same batch size logic (`3 + (random() < 0.47)::int`); drop the `recency_rank > 5` gate; pick rows where `target_discharge_at <= now()` first, then fall back to oldest admissions. Keeps discharges paced with admits.
- **`set_target_discharge_at()`** — change interval to `(120 + floor(random() * 61))` minutes (range 120–180, mean ≈ 150 min ≈ 2.5 h) so natural LOS matches the bed math.

### 2. Cron rebalance

- Keep `ghost_triage_job` at `*/5 * * * *`.
- Move `ghost_discharge_job` from `*/10` to **`*/5 * * * *`** so admit and discharge ticks are 1:1.

### 3. Client watchdog (`src/hooks/useAutomationWatchdog.ts`)

- Raise `GHOST_ADMIT_INTERVAL_MS` from `90_000` to `600_000` (10 min). Cron becomes the primary driver; the client tick remains only as a recovery beat.
- Leave `ADMISSION_IDLE_MS` (6 min) recovery trigger and `forceSeedGhostPatients` (5-patient empty-census seed) alone.

### 4. No UI changes required

Dashboards already render live counts; once the cadence shifts the per-day total will settle at ~1,000.

## Expected steady state

- ~1,000 admits + ~1,000 discharges per 24 h
- ~100 beds occupied at any time, evenly spread across the 5 facilities
- Mean LOS ≈ 2.5 h
- Net duplicate-admission risk unchanged (same `ON CONFLICT (mrn) DO NOTHING` guard)
