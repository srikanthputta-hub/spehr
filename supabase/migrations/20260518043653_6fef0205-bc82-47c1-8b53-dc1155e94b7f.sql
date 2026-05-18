CREATE POLICY "Authenticated users can admit patients"
ON public.patients FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can discharge patients"
ON public.patients FOR DELETE TO authenticated USING (true);

ALTER TABLE public.patients REPLICA IDENTITY FULL;