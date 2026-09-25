-- Phase E (part 2): schedule purge_simulation_data() every 15 minutes.
-- Kept separate from 20260925191500_retention_purge.sql so the cron job was
-- only enabled after a dry run and one manual real run had been verified
-- (Admitted-patient rows, live appointments, recall patients, invoices
-- still backing a discharge, and fhir_sync_state all untouched).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-simulation-data-15min') THEN
    PERFORM cron.unschedule('purge-simulation-data-15min');
  END IF;
END $$;

SELECT cron.schedule('purge-simulation-data-15min', '7,22,37,52 * * * *',
  $$SELECT public.purge_simulation_data();$$);
