
-- ============================================================
-- 1. Schema extensions on existing tables
-- ============================================================
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS target_discharge_at timestamptz,
  ADD COLUMN IF NOT EXISTS discharge_summary_generated boolean DEFAULT false;

ALTER TABLE public.automation_watchdog_logs
  ADD COLUMN IF NOT EXISTS engine text,
  ADD COLUMN IF NOT EXISTS payload jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

UPDATE public.automation_watchdog_logs SET created_at = checker_timestamp WHERE created_at IS NULL;

CREATE INDEX IF NOT EXISTS automation_watchdog_logs_engine_created_idx
  ON public.automation_watchdog_logs (engine, created_at DESC);

ALTER TABLE public.conditions
  ADD COLUMN IF NOT EXISTS term_status text DEFAULT 'pending';

ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS term_status text DEFAULT 'pending';

ALTER TABLE public.lab_orders
  ADD COLUMN IF NOT EXISTS term_status text DEFAULT 'pending';

-- ============================================================
-- 2. Vitals time-series
-- ============================================================
CREATE TABLE IF NOT EXISTS public.vitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn text NOT NULL,
  hr integer,
  bp_systolic integer,
  bp_diastolic integer,
  spo2 integer,
  rr integer,
  temp_c numeric(4,2),
  source text DEFAULT 'simulation',
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vitals_mrn_recorded_idx ON public.vitals (mrn, recorded_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vitals TO anon, authenticated;
GRANT ALL ON public.vitals TO service_role;
ALTER TABLE public.vitals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vitals_all" ON public.vitals;
CREATE POLICY "vitals_all" ON public.vitals FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 3. Clinical alerts (vitals-driven)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.clinical_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn text NOT NULL,
  severity text NOT NULL,
  type text NOT NULL,
  detail jsonb DEFAULT '{}'::jsonb,
  acknowledged boolean DEFAULT false,
  acknowledged_at timestamptz,
  acknowledged_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinical_alerts_mrn_idx ON public.clinical_alerts (mrn, created_at DESC);
CREATE INDEX IF NOT EXISTS clinical_alerts_open_idx ON public.clinical_alerts (acknowledged, created_at DESC) WHERE acknowledged = false;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clinical_alerts TO anon, authenticated;
GRANT ALL ON public.clinical_alerts TO service_role;
ALTER TABLE public.clinical_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clinical_alerts_all" ON public.clinical_alerts;
CREATE POLICY "clinical_alerts_all" ON public.clinical_alerts FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 4. Drug safety alerts (RxNorm × Allergy monitor)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.safety_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn text NOT NULL,
  alert_type text NOT NULL,
  severity text NOT NULL DEFAULT 'WARNING',
  drug_name text,
  drug_rxcui text,
  allergy_substance text,
  allergy_rxcui text,
  detail jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS safety_alerts_dedup_idx
  ON public.safety_alerts (mrn, drug_name, allergy_substance, alert_type)
  WHERE status = 'open';
GRANT SELECT, INSERT, UPDATE, DELETE ON public.safety_alerts TO anon, authenticated;
GRANT ALL ON public.safety_alerts TO service_role;
ALTER TABLE public.safety_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "safety_alerts_all" ON public.safety_alerts;
CREATE POLICY "safety_alerts_all" ON public.safety_alerts FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 5. Staff roster + patient assignments
-- ============================================================
CREATE TABLE IF NOT EXISTS public.staff_roster (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  role text NOT NULL,
  facility text NOT NULL,
  shift_start time,
  shift_end time,
  assigned_patient_count integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_roster_facility_role_idx ON public.staff_roster (facility, role, assigned_patient_count);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_roster TO anon, authenticated;
GRANT ALL ON public.staff_roster TO service_role;
ALTER TABLE public.staff_roster ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "staff_roster_all" ON public.staff_roster;
CREATE POLICY "staff_roster_all" ON public.staff_roster FOR ALL USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.patient_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn text NOT NULL UNIQUE,
  nurse_id uuid REFERENCES public.staff_roster(id) ON DELETE SET NULL,
  nurse_name text,
  physician_id uuid REFERENCES public.staff_roster(id) ON DELETE SET NULL,
  physician_name text,
  facility text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS patient_assignments_mrn_idx ON public.patient_assignments (mrn);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patient_assignments TO anon, authenticated;
GRANT ALL ON public.patient_assignments TO service_role;
ALTER TABLE public.patient_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "patient_assignments_all" ON public.patient_assignments;
CREATE POLICY "patient_assignments_all" ON public.patient_assignments FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 6. API health pings (FHIR / UMLS / Supabase latency)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.api_health_pings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service text NOT NULL,
  status text NOT NULL,
  latency_ms integer,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_health_pings_service_created_idx ON public.api_health_pings (service, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_health_pings TO anon, authenticated;
GRANT ALL ON public.api_health_pings TO service_role;
ALTER TABLE public.api_health_pings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "api_health_pings_all" ON public.api_health_pings;
CREATE POLICY "api_health_pings_all" ON public.api_health_pings FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 7. Realtime publication
-- ============================================================
DO $$
BEGIN
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='vitals';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.vitals; END IF;
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='clinical_alerts';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.clinical_alerts; END IF;
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='safety_alerts';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.safety_alerts; END IF;
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='patient_assignments';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.patient_assignments; END IF;
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='automation_watchdog_logs';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.automation_watchdog_logs; END IF;
  PERFORM 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='nlp_qa_queue';
  IF NOT FOUND THEN ALTER PUBLICATION supabase_realtime ADD TABLE public.nlp_qa_queue; END IF;
END $$;

-- ============================================================
-- 8. Auto-assign target_discharge_at on new admissions (5-20 min LOS)
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_target_discharge_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.target_discharge_at IS NULL AND (NEW.status IS NULL OR lower(NEW.status) = 'admitted') THEN
    NEW.target_discharge_at := COALESCE(NEW.admission_time, now())
      + ((5 + floor(random() * 16)) || ' minutes')::interval;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_target_discharge ON public.patients;
CREATE TRIGGER trg_set_target_discharge
  BEFORE INSERT ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.set_target_discharge_at();

-- Backfill existing admitted patients so the auto-discharge daemon has eligible MRNs immediately
UPDATE public.patients
   SET target_discharge_at = COALESCE(admission_time, now()) + ((5 + floor(random()*16)) || ' minutes')::interval
 WHERE target_discharge_at IS NULL AND lower(status) = 'admitted';

-- ============================================================
-- 9. Seed staff_roster (3-5 per facility)
-- ============================================================
INSERT INTO public.staff_roster (name, role, facility, shift_start, shift_end)
SELECT name, role, facility, shift_start, shift_end
FROM (VALUES
  ('Aisha Patel, RN',       'nurse',     'Memorial Hospital',        '07:00'::time, '19:00'::time),
  ('Marcus Lee, RN',        'nurse',     'Memorial Hospital',        '19:00'::time, '07:00'::time),
  ('Sarah Kim, RN',         'nurse',     'Memorial Hospital',        '07:00'::time, '19:00'::time),
  ('Dr. Elena Park, MD',    'physician', 'Memorial Hospital',        '07:00'::time, '19:00'::time),
  ('Dr. James O''Connor',   'physician', 'Memorial Hospital',        '19:00'::time, '07:00'::time),
  ('Priya Shah, RN',        'nurse',     'St. Jude Medical Center',  '07:00'::time, '19:00'::time),
  ('Tomas Reyes, RN',       'nurse',     'St. Jude Medical Center',  '19:00'::time, '07:00'::time),
  ('Dr. Alan Reyes, MD',    'physician', 'St. Jude Medical Center',  '07:00'::time, '19:00'::time),
  ('Dr. Mei Chen, MD',      'physician', 'St. Jude Medical Center',  '19:00'::time, '07:00'::time),
  ('Jamal Wright, RN',      'nurse',     'City General Infirmary',   '07:00'::time, '19:00'::time),
  ('Nora Bishop, RN',       'nurse',     'City General Infirmary',   '19:00'::time, '07:00'::time),
  ('Dr. Susan Hale, MD',    'physician', 'City General Infirmary',   '07:00'::time, '19:00'::time),
  ('Lily Tran, RN',         'nurse',     'County Health Pavilion',   '07:00'::time, '19:00'::time),
  ('Hugo Martinez, RN',     'nurse',     'County Health Pavilion',   '19:00'::time, '07:00'::time),
  ('Dr. Rohan Mehta, MD',   'physician', 'County Health Pavilion',   '07:00'::time, '19:00'::time),
  ('Eva Novak, RN',         'nurse',     'Srik Health Clinic',       '07:00'::time, '19:00'::time),
  ('Brian Hughes, RN',      'nurse',     'Srik Health Clinic',       '19:00'::time, '07:00'::time),
  ('Dr. Anika Roy, MD',     'physician', 'Srik Health Clinic',       '07:00'::time, '19:00'::time)
) AS v(name, role, facility, shift_start, shift_end)
WHERE NOT EXISTS (SELECT 1 FROM public.staff_roster);
