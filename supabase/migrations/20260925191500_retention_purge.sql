-- Phase E: 36h data-retention purge for all fabricated per-patient data.
--
-- The simulation admits ~1000 patients / 24h continuously, so every
-- per-patient table grows without bound. This migration adds a
-- registry-driven, batched purge (dynamic SQL over data_retention_policies)
-- that runs every 15 minutes and deletes anything older than
-- system_settings.data_retention_hours (default 36).
--
-- Live-schema notes (checked on qxyvmvtecnnwqeqaouzh via information_schema /
-- pg_constraint / cron.job before writing this):
--  * Many tables in the original candidate list do NOT exist live
--    (patient_notes, immunizations, care_plan_goals, nursing_assessments,
--    intake_output_entries, patient_assignments, allied_health_consults,
--    code_status_changes, preventive_screenings, patient_allergies,
--    clinical_alerts, safety_alerts, critical_value_acknowledgments,
--    fhir_patients, fhir_medication_requests, api_health_pings). The registry
--    is populated from a candidate VALUES list filtered through
--    information_schema, so only (table, ts_column, mrn_column) triples that
--    exist live are inserted. purge_simulation_data() re-checks at run time
--    and reports 'skipped:missing' for anything that later disappears.
--  * Only FK children of public.patients live are observations.patient_id and
--    medication_requests.patient_id, both ON DELETE CASCADE. allergies /
--    allergy_reactions are MRN-keyed (no FK) and allergy_reactions cascades
--    from allergies. fhir_charge_items / fhir_payment_notices cascade from
--    fhir_invoices (invoice_id NOT NULL), so they need no registry rows.
--  * No ON DELETE triggers exist on any public table, so batched deletes do
--    not fan out into provenance/audit inserts.
--  * vitals had no index at all besides its PK (~490k rows, ~425k > 36h);
--    an index on recorded_at is added below.
--
-- Deviations from the original plan (see comments at each site):
--  * data_retention_policies gains an `extra_predicate` column so two tables
--    can protect in-flight state machine rows:
--      - fhir_appointments: never purge a proposed/pending/booked row
--        (Phase C's auto_accept_upcoming_appointments() expires those to
--        'noshow' within start+2h/6h, so storage stays bounded). Purging a
--        still-booked row would drop an admission in flight AND remove the
--        recall-protection the patient-row purge relies on.
--      - fhir_invoices: keep an invoice while its patient row still exists
--        with the matching discharge. Otherwise Phase A's
--        discharges_missing_invoice() would see that discharge as
--        un-invoiced and the backfill cron would regenerate the invoice
--        (and auto-pay it) in a loop.
--  * auto_admit_ghost_patient()'s MRN generator is patched (single-line,
--    verified in-place replacement) to skip MRNs in patients, retired_mrns
--    and fhir_appointments.
--  * fhir_sync_state is intentionally absent from the registry and is never
--    referenced by the purge function.

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS data_retention_hours int NOT NULL DEFAULT 36;

CREATE TABLE IF NOT EXISTS public.retired_mrns (
  mrn        text PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS public.data_retention_policies (
  table_name  text PRIMARY KEY,
  ts_column   text NOT NULL,
  mrn_column  text,
  mode        text NOT NULL DEFAULT 'row' CHECK (mode IN ('row','with_patient')),
  guard_active_patient boolean NOT NULL DEFAULT true,
  purge_order int  NOT NULL DEFAULT 100,
  enabled     boolean NOT NULL DEFAULT true,
  extra_predicate text);   -- optional SQL predicate over alias `t`; service-role only
ALTER TABLE public.data_retention_policies ADD COLUMN IF NOT EXISTS extra_predicate text;

ALTER TABLE public.data_retention_policies ENABLE ROW LEVEL SECURITY;  -- no policies: service-role only
ALTER TABLE public.retired_mrns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_retention_policies FROM anon, authenticated;
REVOKE ALL ON public.retired_mrns FROM anon, authenticated;

-- Populate the registry from candidates, keeping only rows whose table,
-- ts_column and (if given) mrn_column exist live.
INSERT INTO public.data_retention_policies
  (table_name, ts_column, mrn_column, mode, guard_active_patient, purge_order, extra_predicate)
SELECT c.table_name, c.ts_column, c.mrn_column, c.mode, c.guard, c.ord, c.extra
  FROM (VALUES
    -- high-volume time-series / clinical (guarded: never purge while patient Admitted)
    ('vitals','recorded_at','mrn','row',true,10,NULL),
    ('rapid_response_alerts','created_at','mrn','row',true,10,NULL),
    ('clinical_notes','created_at','mrn','row',true,20,NULL),
    ('provider_notes','created_at','patient_mrn','row',true,20,NULL),
    ('shift_notes','created_at','patient_mrn','row',true,20,NULL),
    ('patient_notes','created_at','patient_mrn','row',true,20,NULL),
    ('mar_logs','created_at','patient_mrn','row',true,20,NULL),
    ('medication_orders','created_at','patient_mrn','row',true,30,NULL),
    ('lab_results','created_at','mrn','row',true,30,NULL),
    ('lab_orders','created_at','patient_mrn','row',true,30,NULL),
    ('radiology_orders','created_at','patient_mrn','row',true,30,NULL),
    ('conditions','created_at','mrn','row',true,30,NULL),
    ('procedures','created_at','mrn','row',true,30,NULL),
    ('immunizations','created_at','mrn','row',true,30,NULL),
    ('care_plan_goals','created_at','mrn','row',true,30,NULL),
    ('nursing_assessments','created_at','mrn','row',true,30,NULL),
    ('intake_output_entries','created_at','mrn','row',true,30,NULL),
    ('patient_transfers','created_at','patient_mrn','row',true,30,NULL),
    ('patient_assignments','assigned_at','mrn','row',true,30,NULL),
    ('allied_health_consults','requested_at','mrn','row',true,30,NULL),
    ('code_status_changes','changed_at','mrn','row',true,30,NULL),
    ('preventive_screenings','created_at','mrn','row',true,30,NULL),
    ('patient_allergies','created_at','mrn','row',true,30,NULL),
    ('clinical_alerts','created_at','mrn','row',true,30,NULL),
    ('safety_alerts','created_at','mrn','row',true,30,NULL),
    ('clinical_safety_alerts','created_at','mrn','row',true,30,NULL),
    ('cds_suggestions','created_at','mrn','row',true,30,NULL),
    ('cds_overrides','created_at','mrn','row',true,30,NULL),
    ('critical_value_acknowledgments','created_at','mrn','row',true,30,NULL),
    ('nlp_audit_logs','created_at','patient_mrn','row',true,40,NULL),
    ('nlp_qa_queue','created_at','mrn','row',true,40,NULL),
    ('terminology_audit','created_at','mrn','row',true,40,NULL),
    ('auto_doc_runs','created_at','mrn','row',true,40,NULL),
    ('auto_api_events','created_at','mrn','row',true,40,NULL),
    ('fhir_communications','created_at','mrn','row',true,50,NULL),
    -- invoice kept while its discharge is still visible on a patient row
    -- (mirrors discharges_missing_invoice() so the backfill never re-creates it)
    ('fhir_invoices','created_at','mrn','row',true,50,
      'NOT EXISTS (SELECT 1 FROM public.patients p2 WHERE p2.mrn = t.mrn AND p2.discharge_time IS NOT NULL AND (t.discharged_at = p2.discharge_time OR (t.discharged_at IS NULL AND t.issued_at >= p2.discharge_time)))'),
    -- strict 36h regardless of admitted patient, but never an in-flight appointment
    ('fhir_appointments','created_at','patient_mrn','row',false,50,
      't.status IS NULL OR t.status NOT IN (''proposed'',''pending'',''booked'')'),
    ('fhir_observations','created_at','patient_mrn','row',true,60,NULL),
    ('fhir_medication_requests','created_at','patient_mrn','row',true,60,NULL),
    ('fhir_patients','created_at','mrn','row',true,70,NULL),
    ('fhir_resources','created_at','mrn','row',false,70,NULL),
    -- MRN-keyed children of patients: deleted together with the patient row
    ('allergy_reactions','created_at','mrn','with_patient',true,5,NULL),
    ('allergies','created_at','mrn','with_patient',true,6,NULL),
    ('observations','created_at','patient_mrn','with_patient',true,7,NULL),
    ('medication_requests','created_at','patient_mrn','with_patient',true,7,NULL),
    -- telemetry/logs, not patient-scoped
    ('auto_doc_logs','created_at',NULL,'row',false,90,NULL),
    ('automation_watchdog_logs','created_at',NULL,'row',false,90,NULL),
    ('data_provenance','created_at',NULL,'row',false,90,NULL),
    ('pending_writes','created_at',NULL,'row',false,90,NULL),
    ('api_health_pings','created_at',NULL,'row',false,90,NULL),
    ('umls_term_cache','created_at',NULL,'row',false,95,NULL)
  ) AS c(table_name, ts_column, mrn_column, mode, guard, ord, extra)
 WHERE EXISTS (SELECT 1 FROM information_schema.columns ic
                WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name
                  AND ic.column_name = c.ts_column)
   AND (c.mrn_column IS NULL OR EXISTS (
          SELECT 1 FROM information_schema.columns ic
           WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name
             AND ic.column_name = c.mrn_column))
ON CONFLICT (table_name) DO UPDATE
   SET ts_column = EXCLUDED.ts_column, mrn_column = EXCLUDED.mrn_column,
       mode = EXCLUDED.mode, guard_active_patient = EXCLUDED.guard_active_patient,
       purge_order = EXCLUDED.purge_order, extra_predicate = EXCLUDED.extra_predicate;

-- Index each registered cutoff column unless an index already leads with it.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT * FROM public.data_retention_policies LOOP
    CONTINUE WHEN to_regclass('public.' || pol.table_name) IS NULL;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
       WHERE i.indrelid = ('public.' || pol.table_name)::regclass
         AND a.attname = pol.ts_column);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (%I)',
                   left('idx_' || pol.table_name || '_' || pol.ts_column || '_ret', 63),
                   pol.table_name, pol.ts_column);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.purge_simulation_data(p_dry_run boolean DEFAULT false,
                                                        p_batch int DEFAULT 5000,
                                                        p_max_batches int DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cutoff timestamptz := now() - make_interval(hours => COALESCE(
            (SELECT data_retention_hours FROM system_settings WHERE id = 1), 36));
  pol record; guard text; n bigint; total bigint; i int;
  doomed text[]; res jsonb := jsonb_build_object('cutoff', cutoff, 'dry_run', p_dry_run);
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);

  FOR pol IN SELECT * FROM data_retention_policies WHERE enabled AND mode = 'row' ORDER BY purge_order, table_name LOOP
    IF to_regclass('public.' || pol.table_name) IS NULL OR NOT EXISTS (
         SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
            AND table_name = pol.table_name AND column_name = pol.ts_column) THEN
      res := res || jsonb_build_object(pol.table_name, 'skipped:missing'); CONTINUE;
    END IF;
    guard := '';
    IF pol.mrn_column IS NOT NULL AND pol.guard_active_patient THEN
      guard := format(' AND NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.mrn = t.%I AND lower(p.status) = ''admitted'')', pol.mrn_column);
    END IF;
    IF pol.extra_predicate IS NOT NULL THEN
      guard := guard || ' AND (' || pol.extra_predicate || ')';
    END IF;
    total := 0;
    BEGIN
      IF p_dry_run THEN
        EXECUTE format('SELECT count(*) FROM public.%I t WHERE t.%I < $1', pol.table_name, pol.ts_column) || guard
          INTO total USING cutoff;
      ELSE
        FOR i IN 1..p_max_batches LOOP
          EXECUTE format('DELETE FROM public.%I WHERE ctid = ANY (ARRAY(SELECT t.ctid FROM public.%I t WHERE t.%I < $1',
                         pol.table_name, pol.table_name, pol.ts_column) || guard || ' LIMIT $2))'
            USING cutoff, p_batch;
          GET DIAGNOSTICS n = ROW_COUNT; total := total + n;
          EXIT WHEN n < p_batch;
        END LOOP;
      END IF;
      res := res || jsonb_build_object(pol.table_name, total);
    EXCEPTION WHEN OTHERS THEN
      res := res || jsonb_build_object(pol.table_name, 'error:' || SQLERRM);
    END;
  END LOOP;

  -- Patient rows: never Admitted, never holding a bed, never needed by a
  -- live (proposed/pending/booked) appointment such as a Phase D recall.
  SELECT array_agg(mrn) INTO doomed FROM (
    SELECT p.mrn FROM patients p
     WHERE p.mrn IS NOT NULL
       AND lower(coalesce(p.status, '')) <> 'admitted'
       AND GREATEST(p.created_at, COALESCE(p.admission_time, p.created_at)) < cutoff
       AND NOT EXISTS (SELECT 1 FROM bed_management b WHERE b.current_patient_mrn = p.mrn)
       AND NOT EXISTS (SELECT 1 FROM fhir_appointments a
                        WHERE a.patient_mrn = p.mrn
                          AND a.status IN ('proposed','pending','booked'))
     LIMIT 2000) s;
  IF doomed IS NOT NULL AND NOT p_dry_run THEN
    BEGIN
      FOR pol IN SELECT * FROM data_retention_policies WHERE enabled AND mode = 'with_patient' ORDER BY purge_order, table_name LOOP
        IF to_regclass('public.' || pol.table_name) IS NOT NULL THEN
          EXECUTE format('DELETE FROM public.%I WHERE %I = ANY($1)', pol.table_name, pol.mrn_column) USING doomed;
        END IF;
      END LOOP;
      INSERT INTO retired_mrns(mrn) SELECT unnest(doomed) ON CONFLICT DO NOTHING;
      DELETE FROM patients WHERE mrn = ANY(doomed);
    EXCEPTION WHEN foreign_key_violation OR lock_not_available THEN
      res := res || jsonb_build_object('patients_error', SQLERRM);
      doomed := NULL;
    END;
  END IF;
  res := res || jsonb_build_object('patients', coalesce(array_length(doomed, 1), 0));

  IF NOT p_dry_run THEN
    BEGIN DELETE FROM cron.job_run_details WHERE end_time < cutoff; EXCEPTION WHEN OTHERS THEN NULL; END;
  END IF;
  RETURN res;
END $$;
REVOKE EXECUTE ON FUNCTION public.purge_simulation_data(boolean,int,int) FROM PUBLIC, anon, authenticated;

-- MRN reuse: new ghost MRNs skip anything live, retired, or referenced by an
-- appointment (e.g. a myspehr booking for a not-yet-admitted MRN).
CREATE OR REPLACE FUNCTION public.gen_ghost_mrn() RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE m text; tries int := 0;
BEGIN
  LOOP
    m := 'MRN-' || floor(random() * 900000 + 100000)::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM patients WHERE mrn = m)
          AND NOT EXISTS (SELECT 1 FROM retired_mrns WHERE mrn = m)
          AND NOT EXISTS (SELECT 1 FROM fhir_appointments WHERE patient_mrn = m);
    tries := tries + 1;
    EXIT WHEN tries >= 50;  -- give up; caller's ON CONFLICT (mrn) DO NOTHING still applies
  END LOOP;
  RETURN m;
END $$;
REVOKE EXECUTE ON FUNCTION public.gen_ghost_mrn() FROM PUBLIC, anon, authenticated;

-- auto_admit_ghost_patient() was hand-edited live and is not captured in any
-- migration, so rather than transcribe ~250 lines, replace its single MRN
-- line in the live definition. Applied only if the line occurs exactly once
-- (idempotent: a re-run finds 0 occurrences and does nothing).
DO $$
DECLARE
  def text;
  old_line constant text := $l$new_mrn := 'MRN-' || floor(random() * 900000 + 100000)::text;$l$;
  cnt int;
BEGIN
  def := pg_get_functiondef('public.auto_admit_ghost_patient()'::regprocedure);
  cnt := (length(def) - length(replace(def, old_line, ''))) / length(old_line);
  IF cnt = 1 THEN
    EXECUTE replace(def, old_line, 'new_mrn := public.gen_ghost_mrn();');
  ELSE
    RAISE NOTICE 'auto_admit_ghost_patient MRN patch skipped (% occurrences)', cnt;
  END IF;
END $$;

-- Old narrower cache purge: its tables are all in the registry now. Fix the
-- pre-existing anon-callable grant and retire its cron job.
REVOKE EXECUTE ON FUNCTION public.purge_expired_local_cache() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-expired-local-cache-daily') THEN
    PERFORM cron.unschedule('purge-expired-local-cache-daily');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-simulation-data-15min') THEN
    PERFORM cron.unschedule('purge-simulation-data-15min');
  END IF;
END $$;
-- The cron job itself is scheduled in 20260925192500_retention_purge_cron.sql,
-- applied only after the dry run and one manual real run were verified.
