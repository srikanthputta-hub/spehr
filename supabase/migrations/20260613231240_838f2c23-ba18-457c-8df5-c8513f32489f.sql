
-- 1. NLP custom rules table
CREATE TABLE public.nlp_custom_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('slang_mapping','banned_token')),
  raw_term TEXT NOT NULL,
  canonical_mapping TEXT,
  preferred_form TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_nlp_custom_rules_type ON public.nlp_custom_rules(type);
GRANT SELECT ON public.nlp_custom_rules TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nlp_custom_rules TO authenticated;
GRANT ALL ON public.nlp_custom_rules TO service_role;
ALTER TABLE public.nlp_custom_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read nlp rules" ON public.nlp_custom_rules FOR SELECT USING (true);
CREATE POLICY "Anyone can insert nlp rules" ON public.nlp_custom_rules FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can delete nlp rules" ON public.nlp_custom_rules FOR DELETE USING (true);

-- 2. Clinical safety alerts table
CREATE TABLE public.clinical_safety_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  mrn TEXT NOT NULL,
  patient_name TEXT,
  facility_name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('Drug-Allergy','Drug-Drug')),
  drug TEXT NOT NULL,
  drug_b TEXT,
  allergy_name TEXT,
  family TEXT NOT NULL,
  severity TEXT,
  status TEXT NOT NULL DEFAULT 'Pending Review' CHECK (status IN ('Pending Review','Overridden','Rejected')),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  rationale TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_csa_status ON public.clinical_safety_alerts(status);
CREATE INDEX idx_csa_mrn ON public.clinical_safety_alerts(mrn);
GRANT SELECT ON public.clinical_safety_alerts TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clinical_safety_alerts TO authenticated;
GRANT ALL ON public.clinical_safety_alerts TO service_role;
ALTER TABLE public.clinical_safety_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read safety alerts" ON public.clinical_safety_alerts FOR SELECT USING (true);
CREATE POLICY "Anyone can insert safety alerts" ON public.clinical_safety_alerts FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update safety alerts" ON public.clinical_safety_alerts FOR UPDATE USING (true);

-- 3. Patient diagnostic code arrays
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS icd10_codes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS snomed_codes TEXT[] NOT NULL DEFAULT '{}';
