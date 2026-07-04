CREATE TABLE public.cds_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn text NOT NULL,
  suggestion_id text NOT NULL,
  label text NOT NULL,
  severity text NOT NULL,
  items jsonb NOT NULL,
  trigger_code text,
  trigger_display text,
  fired_at timestamptz DEFAULT now(),
  dismissed boolean DEFAULT false,
  admission_key text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX ON public.cds_suggestions (mrn, dismissed);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cds_suggestions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cds_suggestions TO anon;
GRANT ALL ON public.cds_suggestions TO service_role;

ALTER TABLE public.cds_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all" ON public.cds_suggestions
  FOR ALL USING (true) WITH CHECK (true);