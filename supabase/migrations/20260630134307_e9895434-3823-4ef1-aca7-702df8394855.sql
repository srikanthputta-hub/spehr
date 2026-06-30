
CREATE TABLE IF NOT EXISTS public.auto_terminologist_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  message text NOT NULL,
  value_set_id uuid REFERENCES public.custom_value_sets(id) ON DELETE SET NULL,
  confidence numeric,
  action text,
  theme text,
  codes_count int,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.auto_terminologist_log TO anon, authenticated;
GRANT ALL ON public.auto_terminologist_log TO service_role;

ALTER TABLE public.auto_terminologist_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auto_terminologist_log_read" ON public.auto_terminologist_log
  FOR SELECT USING (true);
CREATE POLICY "auto_terminologist_log_insert" ON public.auto_terminologist_log
  FOR INSERT WITH CHECK (true);

CREATE INDEX IF NOT EXISTS auto_terminologist_log_run_at_idx
  ON public.auto_terminologist_log (run_at DESC);
