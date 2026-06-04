ALTER TABLE public.medication_orders ADD COLUMN IF NOT EXISTS dispensed_at timestamptz;
ALTER TABLE public.lab_orders ADD COLUMN IF NOT EXISTS resulted_at timestamptz;