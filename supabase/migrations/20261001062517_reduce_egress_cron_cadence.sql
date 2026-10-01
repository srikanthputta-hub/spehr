-- Supabase Free-plan egress-bandwidth mitigation (grace period until
-- 2026-10-31; Fair Use restrictions may apply after that if usage isn't
-- brought down). This migration only touches the pg_cron jobs that incur
-- egress by calling out over HTTP via net.http_post (either to this
-- project's own Edge Functions, which still counts as egress, or to the
-- external www.spehr.live host, which double-counts egress on both legs
-- of the round trip). Pure DB-to-DB jobs (sweep_stalled_clinical_orders,
-- auto_admit_due_appointments, auto_report_pending_radiology_orders,
-- simulate_vitals_tick, office_room_tick_loop, advance_bed_turnover,
-- auto_pay_overdue_invoices, ghost_triage_job, ghost_physician_job,
-- purge_simulation_data) are left untouched -- they're internal plpgsql
-- calls with no network leg, so they don't cost egress, and some of them
-- (e.g. simulate_vitals_tick, advance_bed_turnover) back the realtime/
-- clinical-safety timing other screens depend on.
--
-- Changes (lengthen cadence, same jobs, same commands):
--   fhir-inbound-poll-45s   : every 1 min  -> every 3 min
--   fhir-outbound-poll-30s  : every 30 sec -> every 2 min
--   ghost-discharge-worker  : every 5 min  -> every 15 min
--   backfill-invoices-every-10min (external POST to www.spehr.live)
--                           : every 10 min -> every 30 min
--
-- The external invoice-backfill job is NOT time-critical: it only creates
-- missing FHIR Invoice/ChargeItem resources for patients who were
-- discharged without one yet (so the Finance board doesn't need to wait
-- for someone to open it), and it is independent of the 3-hour auto-pay
-- timeout. The auto-pay timeout is enforced by the separate, DB-only
-- `auto-pay-overdue-invoices-5min` job (public.auto_pay_overdue_invoices,
-- see 20260925171344_billing_discharge_link_autopay.sql) which stays on
-- its existing 5-minute schedule and is untouched here -- lengthening the
-- invoice-backfill cadence cannot delay or break that deadline.
--
-- Re-scheduling convention per this repo (see
-- 20260925153917_fix_outbound_poller_starvation_and_cadence.sql):
-- cron.unschedule(old name) + cron.schedule(new name, ...). Job bodies are
-- copied verbatim from the live cron.job rows (checked via
-- mcp__Supabase__execute_sql on qxyvmvtecnnwqeqaouzh before writing this)
-- -- only the schedule and job name change.

SELECT cron.unschedule('fhir-inbound-poll-45s');

SELECT cron.schedule(
  'fhir-inbound-poll-3min',
  '*/3 * * * *',
  $$
  SELECT net.http_post(url:='https://qxyvmvtecnnwqeqaouzh.supabase.co/functions/v1/fhir-inbound-poll', headers:='{"Content-Type":"application/json"}'::jsonb);
  $$
);

SELECT cron.unschedule('fhir-outbound-poll-30s');

SELECT cron.schedule(
  'fhir-outbound-poll-2min',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://qxyvmvtecnnwqeqaouzh.supabase.co/functions/v1/fhir-outbound-poll',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4eXZtdnRlY25ud3FlcWFvdXpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNzAwNzgsImV4cCI6MjEwMzg0NjA3OH0.txuCCFhxmQYa_qdd7rj0NrOAIEy-LbtpWyXUCdPPf04'
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.unschedule('ghost-discharge-worker');

SELECT cron.schedule(
  'ghost-discharge-worker-15min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url:='https://qxyvmvtecnnwqeqaouzh.supabase.co/functions/v1/ghost-discharge-worker',
    headers:=jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4eXZtdnRlY25ud3FlcWFvdXpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNzAwNzgsImV4cCI6MjEwMzg0NjA3OH0.txuCCFhxmQYa_qdd7rj0NrOAIEy-LbtpWyXUCdPPf04'
    ),
    body:='{}'::jsonb
  );
  $$
);

SELECT cron.unschedule('backfill-invoices-every-10min');

SELECT cron.schedule(
  'backfill-invoices-every-30min',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url:='https://www.spehr.live/api/public/hooks/generate-invoice?all=1',
    headers:='{"Content-Type": "application/json"}'::jsonb,
    body:='{}'::jsonb
  ) as request_id;
  $$
);
