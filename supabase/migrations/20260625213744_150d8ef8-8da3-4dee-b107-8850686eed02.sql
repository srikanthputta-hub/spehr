
-- Part 2: Terminology coding columns + audit/translation tables

-- 1. Add coding columns to existing tables
ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS loinc_code TEXT,
  ADD COLUMN IF NOT EXISTS loinc_display TEXT,
  ADD COLUMN IF NOT EXISTS umls_cui TEXT,
  ADD COLUMN IF NOT EXISTS coding_source TEXT,
  ADD COLUMN IF NOT EXISTS coded_at TIMESTAMPTZ;

ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS rxnorm_code TEXT,
  ADD COLUMN IF NOT EXISTS rxnorm_display TEXT,
  ADD COLUMN IF NOT EXISTS rxnorm_tty TEXT,
  ADD COLUMN IF NOT EXISTS ingredient_rxcui TEXT,
  ADD COLUMN IF NOT EXISTS umls_cui TEXT,
  ADD COLUMN IF NOT EXISTS coding_source TEXT,
  ADD COLUMN IF NOT EXISTS coded_at TIMESTAMPTZ;

ALTER TABLE public.allergies
  ADD COLUMN IF NOT EXISTS substance_rxcui TEXT,
  ADD COLUMN IF NOT EXISTS substance_snomed TEXT,
  ADD COLUMN IF NOT EXISTS substance_umls_cui TEXT,
  ADD COLUMN IF NOT EXISTS reaction_snomed TEXT,
  ADD COLUMN IF NOT EXISTS reaction_meddra TEXT,
  ADD COLUMN IF NOT EXISTS reaction_umls_cui TEXT,
  ADD COLUMN IF NOT EXISTS coding_source TEXT,
  ADD COLUMN IF NOT EXISTS coded_at TIMESTAMPTZ;

-- 2. Conditions table (new)
CREATE TABLE IF NOT EXISTS public.conditions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn TEXT NOT NULL,
  patient_name TEXT,
  display_text TEXT NOT NULL,
  category TEXT,
  clinical_status TEXT DEFAULT 'active',
  verification_status TEXT DEFAULT 'provisional',
  onset_date TIMESTAMPTZ,
  snomed_code TEXT,
  snomed_display TEXT,
  icd10_code TEXT,
  icd10_display TEXT,
  umls_cui TEXT,
  coding_source TEXT,
  coded_at TIMESTAMPTZ,
  recorded_by TEXT,
  created_by_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conditions TO authenticated;
GRANT SELECT ON public.conditions TO anon;
GRANT ALL ON public.conditions TO service_role;
ALTER TABLE public.conditions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "conditions_read_all" ON public.conditions FOR SELECT USING (true);
CREATE POLICY "conditions_write_auth" ON public.conditions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_conditions_mrn ON public.conditions(mrn);
CREATE INDEX IF NOT EXISTS idx_conditions_snomed ON public.conditions(snomed_code);

-- 3. Procedures table (new)
CREATE TABLE IF NOT EXISTS public.procedures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn TEXT NOT NULL,
  patient_name TEXT,
  display_text TEXT NOT NULL,
  status TEXT DEFAULT 'completed',
  performed_at TIMESTAMPTZ,
  cpt_code TEXT,
  cpt_display TEXT,
  snomed_code TEXT,
  snomed_display TEXT,
  icd10pcs_code TEXT,
  umls_cui TEXT,
  coding_source TEXT,
  coded_at TIMESTAMPTZ,
  performed_by TEXT,
  created_by_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.procedures TO authenticated;
GRANT SELECT ON public.procedures TO anon;
GRANT ALL ON public.procedures TO service_role;
ALTER TABLE public.procedures ENABLE ROW LEVEL SECURITY;
CREATE POLICY "procedures_read_all" ON public.procedures FOR SELECT USING (true);
CREATE POLICY "procedures_write_auth" ON public.procedures FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_procedures_mrn ON public.procedures(mrn);

-- 4. Allergy reactions (one-to-many per allergy)
CREATE TABLE IF NOT EXISTS public.allergy_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  allergy_id UUID NOT NULL REFERENCES public.allergies(id) ON DELETE CASCADE,
  mrn TEXT NOT NULL,
  manifestation TEXT NOT NULL,
  severity TEXT,
  snomed_code TEXT,
  snomed_display TEXT,
  meddra_code TEXT,
  meddra_display TEXT,
  umls_cui TEXT,
  coding_source TEXT,
  coded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.allergy_reactions TO authenticated;
GRANT SELECT ON public.allergy_reactions TO anon;
GRANT ALL ON public.allergy_reactions TO service_role;
ALTER TABLE public.allergy_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allergy_reactions_read_all" ON public.allergy_reactions FOR SELECT USING (true);
CREATE POLICY "allergy_reactions_write_auth" ON public.allergy_reactions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_allergy_reactions_allergy ON public.allergy_reactions(allergy_id);

-- 5. Terminology audit log (every UMLS resolution)
CREATE TABLE IF NOT EXISTS public.terminology_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type TEXT NOT NULL,
  resource_id UUID,
  mrn TEXT,
  input_text TEXT NOT NULL,
  vocabulary TEXT NOT NULL,
  resolved_code TEXT,
  resolved_display TEXT,
  umls_cui TEXT,
  confidence NUMERIC,
  action TEXT NOT NULL,
  cache_hit BOOLEAN DEFAULT false,
  elapsed_ms INTEGER,
  resolver TEXT,
  raw_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.terminology_audit TO authenticated;
GRANT ALL ON public.terminology_audit TO service_role;
ALTER TABLE public.terminology_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "terminology_audit_read_auth" ON public.terminology_audit FOR SELECT TO authenticated USING (true);
CREATE POLICY "terminology_audit_insert_auth" ON public.terminology_audit FOR INSERT TO authenticated WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_terminology_audit_created ON public.terminology_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_terminology_audit_resource ON public.terminology_audit(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_terminology_audit_cui ON public.terminology_audit(umls_cui);

-- 6. Consumer Health Vocabulary translations cache (MySpehr)
CREATE TABLE IF NOT EXISTS public.chv_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  professional_term TEXT NOT NULL,
  vocabulary TEXT NOT NULL,
  source_code TEXT,
  umls_cui TEXT,
  consumer_term TEXT NOT NULL,
  reading_level TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  source TEXT NOT NULL DEFAULT 'CHV',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (professional_term, language)
);
GRANT SELECT, INSERT, UPDATE ON public.chv_translations TO authenticated;
GRANT SELECT ON public.chv_translations TO anon;
GRANT ALL ON public.chv_translations TO service_role;
ALTER TABLE public.chv_translations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chv_read_all" ON public.chv_translations FOR SELECT USING (true);
CREATE POLICY "chv_write_auth" ON public.chv_translations FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS idx_chv_term ON public.chv_translations(professional_term);
CREATE INDEX IF NOT EXISTS idx_chv_cui ON public.chv_translations(umls_cui);

-- 7. updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_conditions_updated ON public.conditions;
CREATE TRIGGER trg_conditions_updated BEFORE UPDATE ON public.conditions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_procedures_updated ON public.procedures;
CREATE TRIGGER trg_procedures_updated BEFORE UPDATE ON public.procedures
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_allergy_reactions_updated ON public.allergy_reactions;
CREATE TRIGGER trg_allergy_reactions_updated BEFORE UPDATE ON public.allergy_reactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_chv_updated ON public.chv_translations;
CREATE TRIGGER trg_chv_updated BEFORE UPDATE ON public.chv_translations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
