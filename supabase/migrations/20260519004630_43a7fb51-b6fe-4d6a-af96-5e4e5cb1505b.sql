ALTER TABLE public.shift_notes 
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Draft',
  ADD COLUMN IF NOT EXISTS esigned_at timestamptz;