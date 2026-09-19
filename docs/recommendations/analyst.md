# Product Health Metrics — Recommendations

Author: business/data analyst pass, 2026-09-18. Read-only — no writes made against either
Supabase project; SQL below is SELECT-only, run against the migration target (`qxyvmvtecnnwqeqaouzh`)
to ground the recommendations in real numbers, not hypotheticals.

## Context / what prompted this

Sanity-checked the migration target directly:

| metric | value |
|---|---|
| `patients` | 12 (all `status='Admitted'`, 0 `Discharged`) |
| `automation_watchdog_logs` | 0 rows |
| `auto_terminologist_log` | 0 rows |
| `terminology_requests` | 0 rows |
| `fhir_sync_state` | 9 rows |
| distinct `facility_name` | 5 (6/3/1/1/1 split — heavily skewed to one facility) |

This confirms the premise: the simulation has never actually run on this project. Zero automation
logs and zero discharges isn't "healthy and quiet" — it's indistinguishable from "broken and
nobody would know," which is exactly the gap this recommendation addresses. There is currently no
dashboard, no alerting, and no single place to answer "is S.P.E.H.R. actually alive right now."

## Recommendations (prioritized)

1. **Build a one-screen "is it alive" liveness dashboard before anything else — this is the
   single highest-leverage metric.** The most important number this system can expose is not a
   rate, it's a heartbeat: time since the last `automation_watchdog_logs` row, last
   `auto_terminologist_log` row, and last patient admission/discharge event. Today, discovering
   the new project has been frozen for weeks required manually querying four tables by hand — a
   30-second dashboard check should have caught it instantly. Concretely: a Supabase view or Edge
   Function that returns `{last_watchdog_tick, last_terminologist_run, last_admission,
   last_discharge, minutes_since_each}`, rendered as a simple traffic-light row (green under N
   minutes, red over). This is cheap (one query, no new infra) and directly prevents the exact
   failure mode already discovered on this project.

2. **Track automation cycle success rate and terminology quality-gate pass rate as engineering
   health metrics, not just presence/absence of logs.** `automation_watchdog_logs` and
   `auto_terminologist_log` already record enough to compute, per rolling 24h window: cycles run,
   cycles that errored vs. completed, and — per `CLAUDE.md`'s own definition of the terminologist
   flow — the ratio of `gated` to `drafted`/`extended`/`umls-suggested-import` outcomes in
   `auto_terminologist_log.action`. A quality-gate pass rate that's near 0% for a sustained period
   means either the simulation is feeding malformed `seed_codes` (real upstream bug) or the gate
   itself is misconfigured — both are silent today and only visible by manually reading
   `quality_gate_notes` row by row, per the CLAUDE.md's own troubleshooting note. Same logic
   applies to `fhir_sync_state`/`fhir-proxy`: sync success rate and staleness (max age of any
   pending cursor) should be a tracked rate, not something inferred from an RLS anomaly during
   an ad hoc investigation, as happened here.

3. **Add population-realism metrics for the synthetic patient set, not just row counts.**
   "12 patients" alone doesn't tell you if the simulation is healthy when it starts running again
   — a population of 12 that's all one diagnosis and one age bracket is a different problem than
   12 that are varied but small. Recommend tracking, refreshed daily: distribution of
   admitting diagnosis/chief-complaint codes (flag if top-1 code exceeds some share, e.g. >40%,
   of active admissions — the current 12-patient set is already skewed 6/3/1/1/1 across
   facilities, which is a preview of the kind of concentration to watch for at scale), age/sex
   distribution vs. an expected reference shape, and length-of-stay distribution (median +
   outliers) once discharges start occurring. Without this, "the simulation is running" and "the
   simulation is producing a realistic hospital population" get conflated, and the second is the
   one that actually matters for S.P.E.H.R.'s stated purpose.

4. **Track admission/discharge throughput and the admitted:discharged ratio over time, with an
   explicit alert on monotonic growth.** Right now the ratio is 12:0 — every patient ever admitted
   is still admitted, which is expected for a system that has never ticked, but would be a serious
   bug signal once automation is live (it would mean `auto_discharge_ghost_patients` isn't firing
   while `auto_admit_ghost_patient` is, so the hospital only ever fills up). Recommend: a
   rolling 7-day admissions count, discharges count, and average active census, with an alert if
   census grows for N consecutive days without a corresponding rise in discharges. This is the
   simulation-specific equivalent of a queue-depth alert and is the most likely way a real
   regression in the discharge automation path would first become visible.

5. **Separate "is the engineering system healthy" from "is the simulation realistic" into two
   dashboard sections (or two dashboards), not one blended view.** These answer different
   questions for different audiences — an engineer debugging a stuck Edge Function needs cycle
   success/error rates and latency; someone validating S.P.E.H.R. as a demo/dataset needs
   population plausibility and throughput. Blending them (e.g. one combined "health score")
   would have hidden exactly the situation found here: the *engineering* surface (Edge Functions
   deployed, secrets set, schema present) looked fully healthy, while the *simulation* surface
   (zero activity, frozen population) was completely dead. Keeping them visually and structurally
   distinct makes that kind of split failure mode legible at a glance instead of averaged away.

6. **Instrument the two-Supabase-project split itself as a first-class dashboard fact, not
   tribal knowledge.** Given the active migration (`fjncfbqwyrenoavhkvdr` → `qxyvmvtecnnwqeqaouzh`)
   and the explicit CLAUDE.md warning against an accidental cutover, the dashboard should show
   *which* project each metric above is being read from, side by side, whenever both are
   queryable. This turns "which project am I looking at" from a fact someone has to remember into
   something the dashboard states outright — cheap to add now, and it directly targets the
   project's own documented risk (an unintentional or under-verified production cutover).
