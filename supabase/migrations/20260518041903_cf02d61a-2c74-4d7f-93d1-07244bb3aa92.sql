ALTER TABLE public.medication_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view medication orders"
ON public.medication_orders FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can update medication orders"
ON public.medication_orders FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_medication_orders_mrn ON public.medication_orders(mrn);