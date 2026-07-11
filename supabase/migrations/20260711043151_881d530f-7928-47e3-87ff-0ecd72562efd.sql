ALTER TABLE public.radiology_orders
  ADD COLUMN IF NOT EXISTS indication_icd10_code text,
  ADD COLUMN IF NOT EXISTS indication_icd10_display text,
  ADD COLUMN IF NOT EXISTS indication_icd10_confidence numeric;