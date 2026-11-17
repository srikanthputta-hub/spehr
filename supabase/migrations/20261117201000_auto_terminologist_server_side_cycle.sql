-- Auto Terminologist reliability fix (part of the server-side extraction
-- in `supabase/functions/_shared/auto-terminologist-cycle.ts`).
--
-- Background: the Auto Terminologist 10-minute cycle used to run ONLY
-- from `src/hooks/useAutoTerminologist.ts` (a client-side React hook's
-- `setInterval`), so it went silent for ~28.7h (confirmed via
-- `auto_terminologist_log`'s heartbeat gap: 2026-11-16 14:28 ->
-- 2026-11-17 19:11, the exact moment a browser tab was reopened) whenever
-- nobody had the app open. This migration schedules the new
-- `auto-terminologist-cycle` edge function via pg_cron, every 10 minutes,
-- matching the cadence the UI already advertises ("Loop active · 10 min
-- cadence") — the edge function and the hook now race for the SAME
-- DB-backed `auto_terminologist` lease (see
-- 20260918215359_automation_leases.sql, confirmed applied live) so they
-- can never double-run a cycle.
--
-- Also adds `patients.terminology_sweep_checked_at`, used to bound the
-- new proactive sweep (standing conditions/medication_orders/allergies vs
-- the published value-set library) to a rotating subset of admitted
-- patients per cycle instead of re-walking the whole admitted census
-- every 10 minutes.

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS terminology_sweep_checked_at timestamptz;

COMMENT ON COLUMN public.patients.terminology_sweep_checked_at IS
  'Last time Auto Terminologist''s proactive sweep checked this patient''s standing conditions/medication_orders/allergies against the published value-set library. NULL = never checked. Used only to rotate/bound the sweep batch, not a clinical field.';

CREATE INDEX IF NOT EXISTS idx_patients_status_terminology_sweep
  ON public.patients (status, terminology_sweep_checked_at);

-- Re-scheduling convention per this repo (see
-- 20260925153917_fix_outbound_poller_starvation_and_cadence.sql /
-- 20261001062517_reduce_egress_cron_cadence.sql): guard with
-- cron.unschedule(name) if it already exists, then cron.schedule(...).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-terminologist-cycle-10min') THEN
    PERFORM cron.unschedule('auto-terminologist-cycle-10min');
  END IF;
END $$;

SELECT cron.schedule(
  'auto-terminologist-cycle-10min',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://qxyvmvtecnnwqeqaouzh.supabase.co/functions/v1/auto-terminologist-cycle',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4eXZtdnRlY25ud3FlcWFvdXpoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNzAwNzgsImV4cCI6MjEwMzg0NjA3OH0.txuCCFhxmQYa_qdd7rj0NrOAIEy-LbtpWyXUCdPPf04'
    ),
    body := '{}'::jsonb
  );
  $$
);
