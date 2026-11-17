-- Reliability fix: Auto Doc's headless pipeline (runAutoDocPipeline in
-- src/lib/auto-doc.server.ts) is genuinely server-side once invoked, but
-- for a long time nothing server-side invoked it per admission anymore.
--
-- The `patients_auto_doc_after_insert` trigger (AFTER INSERT ON
-- public.patients -> net.http_post -> the pipeline's own public hook) was
-- permanently dropped in migration
-- 20260619161440_03dbef44-07f1-426d-8f02-3f87c9a27052.sql for an unrelated
-- reason (it was bulk-inserting duplicate "Administered" med rows at
-- admission time) and never recreated. Confirmed on the live project
-- (qxyvmvtecnnwqeqaouzh) via pg_trigger: public.patients carries no such
-- trigger today, only trg_patients_auto_code_ins/upd,
-- trg_set_target_discharge_at and trg_touch_updated_at. The orphaned
-- notify_auto_doc() function is left as dead code from the drop
-- (DROP FUNCTION IF EXISTS apparently no-opped on something still
-- referencing it at the time); it is unused and this migration does not
-- touch it.
--
-- Since the trigger's removal, the ONLY thing left calling runAutoDoc()
-- per admission has been the in-app client — useAIAutomation's
-- `admission-randomizer` realtime channel (fires on INSERT only while
-- some browser tab has the app open) plus a once-per-tab-mount
-- reconcileActiveAdmissions() sweep. That is the exact same reliability
-- class of bug just found and fixed for the Safety Alerts Engine's
-- realtime watcher: it silently does nothing for any admission that
-- happens while no tab is open. In particular `auto_admit_appointments_job`
-- (this project's pg_cron job, every minute -> public.auto_admit_due_appointments()
-- -> public.admit_patient_from_appointment()) inserts into `patients`
-- directly from plpgsql and never goes anywhere near the in-app client,
-- so most admissions today get NO Auto Doc run at all — no notes, no UMLS
-- coding, no FHIR, and none of the terminology-gap filing the pipeline
-- does for both Auto Doc and (as of the same reliability-fix effort)
-- Auto Admin's HRRP coverage check — until some tab happens to open.
--
-- Fix: a pg_cron-driven backfill target, exactly the same pattern this
-- repo already uses for the equivalent billing problem
-- (backfill-invoices-every-30min -> generate-invoice?all=1 ->
-- backfillMissingInvoices()). `backfillMissingAutoDocRuns()` finds
-- patients with no completed `auto_doc_runs` row and runs the (idempotent)
-- pipeline for them, independent of any browser tab.
--
-- Cadence: 15 minutes, matching the ghost-discharge-worker-15min
-- precedent for a non-time-critical external-HTTP cron target (this is an
-- external POST to www.spehr.live, which double-counts egress per the
-- reasoning in 20261001062517_reduce_egress_cron_cadence.sql, so it is
-- intentionally not more frequent than that).
SELECT cron.schedule(
  'auto-doc-pipeline-backfill-15min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url:='https://www.spehr.live/api/public/hooks/auto-doc?all=1',
    headers:='{"Content-Type": "application/json"}'::jsonb,
    body:='{}'::jsonb
  ) as request_id;
  $$
);
