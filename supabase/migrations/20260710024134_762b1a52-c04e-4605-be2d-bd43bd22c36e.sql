ALTER TABLE public.custom_value_sets
  ADD COLUMN IF NOT EXISTS fhir_published_at TIMESTAMPTZ;