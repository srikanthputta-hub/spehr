ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS bp_systolic integer DEFAULT 120,
  ADD COLUMN IF NOT EXISTS bp_diastolic integer DEFAULT 80;

-- Backfill from legacy bp text column if present
UPDATE public.patients
SET bp_systolic = COALESCE(bp_systolic, NULLIF(split_part(bp, '/', 1), '')::int),
    bp_diastolic = COALESCE(bp_diastolic, NULLIF(split_part(bp, '/', 2), '')::int)
WHERE bp IS NOT NULL;

-- Force PostgREST to reload its schema cache
NOTIFY pgrst, 'reload schema';