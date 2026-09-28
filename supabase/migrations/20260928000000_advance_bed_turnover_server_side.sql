-- Server-side bed-turnover state machine.
--
-- Previously the Cleaning -> Disinfecting -> Making Bed -> Available
-- progression was driven ENTIRELY client-side by sweepBedCleaningCycles()
-- inside src/hooks/useAIAutomation.ts, on a 30s setInterval, only while a
-- browser tab with that hook mounted was open. With no tab open, beds got
-- stuck in whatever phase they were last in (confirmed: 100/100 beds stuck
-- in 'Disinfecting' for ~34.5h, status_updated_at frozen at
-- 2026-09-27 08:51:28.351+00), blocking all admissions since handleAdmit
-- refuses to admit when 0 beds are Available.
--
-- The Cleaning -> Disinfecting -> Making Bed -> Available phase duration
-- was BED_PHASE_MS = 45_000 (45 seconds) client-side; this migration keeps
-- that exact duration, moving only the TIMED PROGRESSION server-side via
-- pg_cron. The initial discharge -> 'Cleaning' trigger point is left
-- alone: it's already partly server-side (auto_discharge_ghost_patients
-- sets bed_management.status = 'Cleaning' directly for ghost discharges)
-- and partly client-side (startBedCleaningCycle(), fired off realtime
-- postgres_changes on the patients table for manual/UI discharges) --
-- neither of those needed to change.

CREATE OR REPLACE FUNCTION public.advance_bed_turnover()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  phase_duration CONSTANT interval := interval '45 seconds';
BEGIN
  -- Cleaning (and its discharge-flow synonyms) -> Disinfecting
  UPDATE public.bed_management
     SET status = 'Disinfecting',
         status_updated_at = now()
   WHERE status IN ('Cleaning', 'Discharged - Deep Cleaning In Progress', 'Discharged')
     AND status_updated_at < now() - phase_duration;

  -- Disinfecting -> Making Bed
  UPDATE public.bed_management
     SET status = 'Making Bed',
         status_updated_at = now()
   WHERE status = 'Disinfecting'
     AND status_updated_at < now() - phase_duration;

  -- Making Bed -> Available (final phase; also clears any leftover MRN)
  UPDATE public.bed_management
     SET status = 'Available',
         current_patient_mrn = NULL,
         status_updated_at = now()
   WHERE status = 'Making Bed'
     AND status_updated_at < now() - phase_duration;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.advance_bed_turnover() FROM PUBLIC, anon, authenticated;

-- Idempotent (re-runnable) cron scheduling, matching this repo's
-- re-scheduling convention (see 20260925171344_billing_discharge_link_autopay.sql
-- / 20260925153917_fix_outbound_poller_starvation_and_cadence.sql): unschedule
-- only if a same-named job already exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'advance-bed-turnover-30s') THEN
    PERFORM cron.unschedule('advance-bed-turnover-30s');
  END IF;
END $$;

-- 30s tick against a 45s phase duration keeps beds moving promptly without
-- ticking meaningfully faster than the phase itself requires.
SELECT cron.schedule('advance-bed-turnover-30s', '30 seconds',
  $$SELECT public.advance_bed_turnover();$$);

-- One-time backlog catch-up: the 100 beds currently stuck have been sitting
-- in 'Disinfecting' for ~34.5h, far past any real phase duration. Rather
-- than let the cron slowly walk each one through 45s-per-phase increments,
-- fast-forward them straight to Available now.
UPDATE public.bed_management
   SET status = 'Available',
       current_patient_mrn = NULL,
       status_updated_at = now()
 WHERE status IN ('Cleaning', 'Discharged - Deep Cleaning In Progress', 'Discharged', 'Disinfecting', 'Making Bed');
