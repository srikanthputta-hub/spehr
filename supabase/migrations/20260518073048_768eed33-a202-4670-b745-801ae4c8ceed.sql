
ALTER TABLE public.mar_logs ADD COLUMN IF NOT EXISTS mrn TEXT;
ALTER TABLE public.mar_logs ADD COLUMN IF NOT EXISTS medication_name TEXT;
ALTER TABLE public.mar_logs ADD COLUMN IF NOT EXISTS given_at TIMESTAMP WITH TIME ZONE DEFAULT now();
ALTER TABLE public.mar_logs ADD COLUMN IF NOT EXISTS given_by TEXT DEFAULT 'RN — Demo Session';

ALTER TABLE public.mar_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view MAR logs" ON public.mar_logs;
DROP POLICY IF EXISTS "Anyone can insert MAR logs" ON public.mar_logs;

CREATE POLICY "Anyone can view MAR logs"
  ON public.mar_logs FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert MAR logs"
  ON public.mar_logs FOR INSERT
  WITH CHECK (true);

ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS meds_due_count INTEGER NOT NULL DEFAULT 1;
