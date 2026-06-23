
-- 1. last_fhir_sync column on patients
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS last_fhir_sync timestamptz;

-- 2. Background dispatch function: resolves the affected MRN and fires the
-- Auto IT hook via pg_net. Non-blocking: errors are swallowed so they never
-- abort the originating clinical write.
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notify_fhir_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  hook_url text := 'https://project--c583ffa8-2be6-4140-bf75-9b224843471e.lovable.app/api/public/hooks/fhir-auto-sync';
  v_mrn text;
  v_event text := TG_OP;
  v_table text := TG_TABLE_NAME;
  rec record;
BEGIN
  -- Resolve which row carries the MRN (NEW for INSERT/UPDATE, OLD for DELETE)
  IF TG_OP = 'DELETE' THEN
    rec := OLD;
  ELSE
    rec := NEW;
  END IF;

  -- Column carrying the MRN differs by table
  IF v_table = 'patients' THEN
    v_mrn := rec.mrn;
  ELSIF v_table = 'clinical_notes' THEN
    v_mrn := rec.mrn;
  ELSE
    -- lab_orders, medication_orders use patient_mrn
    v_mrn := rec.patient_mrn;
  END IF;

  IF v_mrn IS NULL OR v_mrn = '' THEN
    RETURN rec;
  END IF;

  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'mrn', v_mrn,
      'table', v_table,
      'event', v_event
    )
  );

  RETURN rec;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fhir-auto-sync dispatch failed: %', SQLERRM;
  RETURN rec;
END;
$$;

-- 3. Attach triggers to each watched table
DROP TRIGGER IF EXISTS patients_fhir_sync ON public.patients;
CREATE TRIGGER patients_fhir_sync
AFTER INSERT OR UPDATE OR DELETE ON public.patients
FOR EACH ROW EXECUTE FUNCTION public.notify_fhir_sync();

DROP TRIGGER IF EXISTS lab_orders_fhir_sync ON public.lab_orders;
CREATE TRIGGER lab_orders_fhir_sync
AFTER INSERT OR UPDATE OR DELETE ON public.lab_orders
FOR EACH ROW EXECUTE FUNCTION public.notify_fhir_sync();

DROP TRIGGER IF EXISTS medication_orders_fhir_sync ON public.medication_orders;
CREATE TRIGGER medication_orders_fhir_sync
AFTER INSERT OR UPDATE OR DELETE ON public.medication_orders
FOR EACH ROW EXECUTE FUNCTION public.notify_fhir_sync();

DROP TRIGGER IF EXISTS clinical_notes_fhir_sync ON public.clinical_notes;
CREATE TRIGGER clinical_notes_fhir_sync
AFTER INSERT OR UPDATE OR DELETE ON public.clinical_notes
FOR EACH ROW EXECUTE FUNCTION public.notify_fhir_sync();

-- 4. Realtime on patients so the dashboard timestamp ticks live
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.patients;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
