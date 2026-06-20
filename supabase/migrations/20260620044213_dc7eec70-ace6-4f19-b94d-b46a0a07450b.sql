GRANT INSERT ON public.lab_results TO anon;
DROP POLICY IF EXISTS "Anon can insert lab results" ON public.lab_results;
CREATE POLICY "Anon can insert lab results" ON public.lab_results FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS "Anon can read lab results" ON public.lab_results;
CREATE POLICY "Anon can read lab results" ON public.lab_results FOR SELECT TO anon USING (true);
GRANT SELECT ON public.lab_results TO anon;