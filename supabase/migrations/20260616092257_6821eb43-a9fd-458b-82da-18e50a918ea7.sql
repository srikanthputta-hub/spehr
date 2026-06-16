GRANT INSERT ON public.lab_results TO authenticated;
GRANT ALL ON public.lab_results TO service_role;

DROP POLICY IF EXISTS "Authenticated users can insert lab results" ON public.lab_results;
CREATE POLICY "Authenticated users can insert lab results"
  ON public.lab_results
  FOR INSERT
  TO authenticated
  WITH CHECK (true);