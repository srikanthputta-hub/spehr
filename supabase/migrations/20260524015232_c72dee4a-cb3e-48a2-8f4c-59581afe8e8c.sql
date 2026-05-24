CREATE POLICY "Anyone can view patients" ON public.patients FOR SELECT USING (true);
CREATE POLICY "Anyone can insert patients" ON public.patients FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update patients" ON public.patients FOR UPDATE USING (true);