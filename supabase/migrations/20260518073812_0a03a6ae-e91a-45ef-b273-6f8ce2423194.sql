ALTER TABLE public.shift_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view shift notes" ON public.shift_notes;
DROP POLICY IF EXISTS "Anyone can insert shift notes" ON public.shift_notes;

CREATE POLICY "Anyone can view shift notes"
ON public.shift_notes FOR SELECT
USING (true);

CREATE POLICY "Anyone can insert shift notes"
ON public.shift_notes FOR INSERT
WITH CHECK (true);