
CREATE TABLE IF NOT EXISTS public.radiology_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_mrn text NOT NULL,
  patient_name text,
  facility_name text,
  requested_by text,
  exam_type text NOT NULL,
  modality text,
  body_part text,
  clinical_indication text,
  status text NOT NULL DEFAULT 'ordered',
  snomed_code text,
  snomed_display text,
  report_text text,
  impression text,
  svcreq_fhir_id text,
  source text NOT NULL DEFAULT 'spehr',
  ordered_at timestamptz NOT NULL DEFAULT now(),
  resulted_at timestamptz,
  created_by_type public.provenance_origin NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Grants mirror lab_orders posture (RLS is off there; PostgREST implicit grants
-- are managed by Supabase). We add explicit grants defensively.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.radiology_orders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.radiology_orders TO anon;
GRANT ALL ON public.radiology_orders TO service_role;

CREATE INDEX IF NOT EXISTS idx_radiology_orders_patient_created
  ON public.radiology_orders (patient_mrn, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_orders_facility_status_created
  ON public.radiology_orders (facility_name, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_radiology_orders_svcreq_fhir_id
  ON public.radiology_orders (svcreq_fhir_id);
CREATE INDEX IF NOT EXISTS idx_radiology_orders_source
  ON public.radiology_orders (source);

-- updated_at trigger — reuse touch_updated_at helper used by lab_orders.
DROP TRIGGER IF EXISTS trg_touch_updated_at ON public.radiology_orders;
CREATE TRIGGER trg_touch_updated_at
  BEFORE UPDATE ON public.radiology_orders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Inbound-poll cursor seed so we don't rescan Medblocks' whole history on first tick.
INSERT INTO public.fhir_sync_state (key, value)
VALUES ('radiology_report_last_polled_at',
        jsonb_build_object('ts', (now() - interval '10 minutes')::text))
ON CONFLICT (key) DO NOTHING;
