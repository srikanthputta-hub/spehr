ALTER TABLE public.cds_overrides ADD COLUMN IF NOT EXISTS decision text;

UPDATE public.cds_overrides
SET decision = CASE
  WHEN reason ILIKE '%rejection%' THEN 'Rejected'
  WHEN reason ILIKE '%override%' THEN 'Overridden'
  ELSE decision
END
WHERE decision IS NULL;