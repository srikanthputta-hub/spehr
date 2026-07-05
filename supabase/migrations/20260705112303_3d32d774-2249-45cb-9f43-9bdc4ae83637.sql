CREATE TABLE IF NOT EXISTS public.terminology_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  message text NOT NULL,
  ref_id text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.terminology_activity_log TO anon, authenticated;
GRANT ALL ON public.terminology_activity_log TO service_role;

ALTER TABLE public.terminology_activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "terminology_activity_log_read" ON public.terminology_activity_log
  FOR SELECT USING (true);
CREATE POLICY "terminology_activity_log_insert" ON public.terminology_activity_log
  FOR INSERT WITH CHECK (true);

CREATE INDEX IF NOT EXISTS terminology_activity_log_feature_created_at_idx
  ON public.terminology_activity_log (feature, created_at DESC);