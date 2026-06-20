-- TTL Garbage Collection for local cache tables (48h retention).
-- Strictly LOCAL: never issues outbound requests to the Medblocks FHIR server.
CREATE OR REPLACE FUNCTION public.purge_expired_local_cache()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff timestamptz := now() - interval '48 hours';
  d_fhir int := 0;
  d_pending int := 0;
  d_prov int := 0;
  d_audit int := 0;
  d_watch int := 0;
  d_umls int := 0;
BEGIN
  -- Local mirror of FHIR resources (the Medblocks server is the source of truth)
  WITH d AS (DELETE FROM public.fhir_resources WHERE created_at < cutoff RETURNING 1)
  SELECT count(*) INTO d_fhir FROM d;

  -- Outbox of writes pending sync
  WITH d AS (DELETE FROM public.pending_writes WHERE created_at < cutoff RETURNING 1)
  SELECT count(*) INTO d_pending FROM d;

  -- Provenance audit trail (local copy; long-term audit lives off-box)
  WITH d AS (DELETE FROM public.data_provenance WHERE created_at < cutoff RETURNING 1)
  SELECT count(*) INTO d_prov FROM d;

  -- Auto Doc telemetry logs
  WITH d AS (DELETE FROM public.auto_doc_logs WHERE created_at < cutoff RETURNING 1)
  SELECT count(*) INTO d_audit FROM d;

  -- Watchdog noise
  WITH d AS (DELETE FROM public.automation_watchdog_logs WHERE created_at < cutoff RETURNING 1)
  SELECT count(*) INTO d_watch FROM d;

  -- UMLS lookup cache
  WITH d AS (DELETE FROM public.umls_term_cache WHERE created_at < cutoff RETURNING 1)
  SELECT count(*) INTO d_umls FROM d;

  RETURN jsonb_build_object(
    'cutoff', cutoff,
    'fhir_resources', d_fhir,
    'pending_writes', d_pending,
    'data_provenance', d_prov,
    'auto_doc_logs', d_audit,
    'automation_watchdog_logs', d_watch,
    'umls_term_cache', d_umls
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_local_cache() TO anon, authenticated, service_role;

-- Daily scheduled sweep at 03:15 UTC
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule('purge-expired-local-cache-daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'purge-expired-local-cache-daily',
  '15 3 * * *',
  $$SELECT public.purge_expired_local_cache();$$
);