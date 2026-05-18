ALTER TABLE public.hospital_staff ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view hospital staff"
ON public.hospital_staff
FOR SELECT
USING (true);

CREATE POLICY "Anyone can insert hospital staff"
ON public.hospital_staff
FOR INSERT
WITH CHECK (true);