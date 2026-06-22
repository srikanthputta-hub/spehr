
CREATE TABLE IF NOT EXISTS public.observations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  patient_mrn TEXT,
  loinc_code VARCHAR(32),
  display_name VARCHAR(255) NOT NULL,
  value TEXT,
  value_numeric NUMERIC,
  unit VARCHAR(64),
  reference_range TEXT,
  abnormal_flag TEXT,
  status TEXT NOT NULL DEFAULT 'final',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT DEFAULT 'auto-doc',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.observations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.observations TO anon;
GRANT ALL ON public.observations TO service_role;
ALTER TABLE public.observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view observations" ON public.observations FOR SELECT USING (true);
CREATE POLICY "Anyone can insert observations" ON public.observations FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update observations" ON public.observations FOR UPDATE USING (true);
CREATE INDEX idx_observations_patient_id ON public.observations(patient_id);
CREATE INDEX idx_observations_mrn ON public.observations(patient_mrn);
CREATE INDEX idx_observations_loinc ON public.observations(loinc_code);
CREATE TRIGGER trg_observations_touch BEFORE UPDATE ON public.observations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.medication_requests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  patient_mrn TEXT,
  rxnorm_code VARCHAR(32),
  display_name VARCHAR(255) NOT NULL,
  dosage VARCHAR(255),
  route VARCHAR(64),
  frequency VARCHAR(128),
  status TEXT NOT NULL DEFAULT 'active',
  intent TEXT NOT NULL DEFAULT 'order',
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requester TEXT,
  source TEXT DEFAULT 'auto-doc',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.medication_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.medication_requests TO anon;
GRANT ALL ON public.medication_requests TO service_role;
ALTER TABLE public.medication_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view medication_requests" ON public.medication_requests FOR SELECT USING (true);
CREATE POLICY "Anyone can insert medication_requests" ON public.medication_requests FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update medication_requests" ON public.medication_requests FOR UPDATE USING (true);
CREATE INDEX idx_medreq_patient_id ON public.medication_requests(patient_id);
CREATE INDEX idx_medreq_mrn ON public.medication_requests(patient_mrn);
CREATE INDEX idx_medreq_rxnorm ON public.medication_requests(rxnorm_code);
CREATE TRIGGER trg_medreq_touch BEFORE UPDATE ON public.medication_requests
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON COLUMN public.patients.standardized_output IS 'DEPRECATED: legacy flattened terminology blob. New writes go to public.observations and public.medication_requests. Kept only for read-back of historical encounters.';
