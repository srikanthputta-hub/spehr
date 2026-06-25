
-- AUTO API agent: QA queue, custom value sets, CDS overrides, audit event log

-- 1. nlp_qa_queue: NLP mappings held for human review (80-94% confidence)
CREATE TABLE IF NOT EXISTS public.nlp_qa_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn TEXT NOT NULL,
  patient_name TEXT,
  complaint_snippet TEXT,
  confidence NUMERIC(5,2) NOT NULL,
  proposed_codes JSONB NOT NULL DEFAULT '{}'::jsonb,
  facility_name TEXT,
  source_audit_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewer TEXT,
  reviewed_at TIMESTAMPTZ,
  sla_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '60 seconds'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nlp_qa_queue_status_idx ON public.nlp_qa_queue(status, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nlp_qa_queue TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nlp_qa_queue TO anon;
GRANT ALL ON public.nlp_qa_queue TO service_role;
ALTER TABLE public.nlp_qa_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY nlp_qa_queue_all ON public.nlp_qa_queue FOR ALL USING (true) WITH CHECK (true);

-- 2. custom_value_sets: user-built groupings of terminology codes
CREATE TABLE IF NOT EXISTS public.custom_value_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  system TEXT NOT NULL,
  codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  author TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_value_sets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_value_sets TO anon;
GRANT ALL ON public.custom_value_sets TO service_role;
ALTER TABLE public.custom_value_sets ENABLE ROW LEVEL SECURITY;
CREATE POLICY custom_value_sets_all ON public.custom_value_sets FOR ALL USING (true) WITH CHECK (true);

-- 3. cds_overrides: physician overrides of CDS Hook alerts
CREATE TABLE IF NOT EXISTS public.cds_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  drug_rxnorm TEXT,
  drug_name TEXT,
  condition_snomed TEXT,
  condition_name TEXT,
  reason TEXT NOT NULL,
  physician_id TEXT,
  physician_name TEXT,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cds_overrides TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cds_overrides TO anon;
GRANT ALL ON public.cds_overrides TO service_role;
ALTER TABLE public.cds_overrides ENABLE ROW LEVEL SECURITY;
CREATE POLICY cds_overrides_all ON public.cds_overrides FOR ALL USING (true) WITH CHECK (true);

-- 4. auto_api_events: enterprise event ledger for the AUTO API agent
CREATE TABLE IF NOT EXISTS public.auto_api_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  mrn TEXT,
  actor TEXT NOT NULL DEFAULT 'AUTO API',
  facility_name TEXT,
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auto_api_events_created_idx ON public.auto_api_events(created_at DESC);
CREATE INDEX IF NOT EXISTS auto_api_events_type_idx ON public.auto_api_events(event_type, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auto_api_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.auto_api_events TO anon;
GRANT ALL ON public.auto_api_events TO service_role;
ALTER TABLE public.auto_api_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY auto_api_events_all ON public.auto_api_events FOR ALL USING (true) WITH CHECK (true);

-- 5. Per-engine toggles on system_settings (additive; nullable defaults preserve existing rows)
ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS auto_doc_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_admin_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_it_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_api_enabled BOOLEAN NOT NULL DEFAULT true;

-- 6. Seed sample QA queue rows so the UI is non-empty on first paint
INSERT INTO public.nlp_qa_queue (mrn, patient_name, complaint_snippet, confidence, proposed_codes, facility_name, sla_expires_at)
SELECT
  p.mrn,
  COALESCE(p.name, p.first_name || ' ' || p.last_name),
  LEFT(COALESCE(p.chief_complaint, ''), 80),
  82 + (random() * 12)::numeric(5,2),
  jsonb_build_object(
    'ICD-10', jsonb_build_array('I21.9'),
    'SNOMED CT', jsonb_build_array('22298006')
  ),
  p.facility_name,
  now() + (interval '60 seconds')
FROM public.patients p
WHERE p.status = 'Admitted'
ORDER BY p.admission_time DESC NULLS LAST
LIMIT 3
ON CONFLICT DO NOTHING;
