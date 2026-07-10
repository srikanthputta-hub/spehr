ALTER TABLE public.fhir_invoices
  ADD COLUMN IF NOT EXISTS primary_diagnosis_icd10 text,
  ADD COLUMN IF NOT EXISTS primary_diagnosis_display text;