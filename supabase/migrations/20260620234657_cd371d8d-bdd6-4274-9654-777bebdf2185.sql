CREATE TABLE IF NOT EXISTS public.fhir_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_name text NOT NULL,
  patient_mrn text,
  patient_name text NOT NULL,
  practitioner_name text,
  service_type text,
  description text,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'booked',
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fhir_appointments_facility_start_idx
  ON public.fhir_appointments (facility_name, start_time DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fhir_appointments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fhir_appointments TO anon;
GRANT ALL ON public.fhir_appointments TO service_role;

ALTER TABLE public.fhir_appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Appointments are readable by everyone"
  ON public.fhir_appointments FOR SELECT
  USING (true);

CREATE POLICY "Anyone can create appointments"
  ON public.fhir_appointments FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update appointments"
  ON public.fhir_appointments FOR UPDATE
  USING (true) WITH CHECK (true);

CREATE POLICY "Anyone can cancel appointments"
  ON public.fhir_appointments FOR DELETE
  USING (true);

CREATE TRIGGER fhir_appointments_touch_updated_at
  BEFORE UPDATE ON public.fhir_appointments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();