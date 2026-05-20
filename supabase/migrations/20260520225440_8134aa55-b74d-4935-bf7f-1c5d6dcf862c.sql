ALTER TABLE public.medication_orders
  ADD COLUMN IF NOT EXISTS facility_name text,
  ADD COLUMN IF NOT EXISTS ordering_physician text;

CREATE INDEX IF NOT EXISTS medication_orders_status_facility_idx
  ON public.medication_orders (status, facility_name);