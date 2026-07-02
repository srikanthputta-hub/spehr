-- Add LOINC columns to vitals
ALTER TABLE public.vitals ADD COLUMN IF NOT EXISTS loinc_code text;
ALTER TABLE public.vitals ADD COLUMN IF NOT EXISTS loinc_display text;
ALTER TABLE public.vitals ADD COLUMN IF NOT EXISTS loinc_map jsonb;

-- Add LOINC columns to lab_results
ALTER TABLE public.lab_results ADD COLUMN IF NOT EXISTS loinc_code text;
ALTER TABLE public.lab_results ADD COLUMN IF NOT EXISTS loinc_display text;

-- Add source_section to conditions
ALTER TABLE public.conditions ADD COLUMN IF NOT EXISTS source_section text;