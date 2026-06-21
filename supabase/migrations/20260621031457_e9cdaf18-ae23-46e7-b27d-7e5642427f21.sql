
CREATE TABLE IF NOT EXISTS public.fhir_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn text NOT NULL,
  facility_name text,
  sender text NOT NULL CHECK (sender IN ('patient','provider','system')),
  sender_label text,
  recipient text NOT NULL CHECK (recipient IN ('patient','provider','careteam')),
  subject text,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'in-progress' CHECK (status IN ('preparation','in-progress','completed','entered-in-error','unread','read')),
  parent_id uuid REFERENCES public.fhir_communications(id) ON DELETE SET NULL,
  resource jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fhir_communications_mrn_idx ON public.fhir_communications(mrn);
CREATE INDEX IF NOT EXISTS fhir_communications_facility_idx ON public.fhir_communications(facility_name);
CREATE INDEX IF NOT EXISTS fhir_communications_created_idx ON public.fhir_communications(created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fhir_communications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fhir_communications TO authenticated;
GRANT ALL ON public.fhir_communications TO service_role;

ALTER TABLE public.fhir_communications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fhir_communications read" ON public.fhir_communications FOR SELECT USING (true);
CREATE POLICY "fhir_communications insert" ON public.fhir_communications FOR INSERT WITH CHECK (true);
CREATE POLICY "fhir_communications update" ON public.fhir_communications FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "fhir_communications delete" ON public.fhir_communications FOR DELETE USING (true);

DROP TRIGGER IF EXISTS touch_fhir_communications_updated_at ON public.fhir_communications;
CREATE TRIGGER touch_fhir_communications_updated_at
  BEFORE UPDATE ON public.fhir_communications
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Enable realtime
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.fhir_communications;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.fhir_observations;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.fhir_appointments;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
