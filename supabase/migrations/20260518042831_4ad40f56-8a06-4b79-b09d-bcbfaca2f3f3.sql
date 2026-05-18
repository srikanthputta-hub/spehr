ALTER TABLE public.lab_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view lab results"
ON public.lab_results FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_lab_results_mrn ON public.lab_results(mrn);