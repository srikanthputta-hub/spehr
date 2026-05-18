ALTER TABLE public.clinical_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view clinical notes"
ON public.clinical_notes FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert clinical notes"
ON public.clinical_notes FOR INSERT TO authenticated WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_clinical_notes_mrn_created ON public.clinical_notes(mrn, created_at DESC);