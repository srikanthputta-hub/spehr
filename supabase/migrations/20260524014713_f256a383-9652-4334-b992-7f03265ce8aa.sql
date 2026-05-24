-- 1. Neutralize plaintext signature PINs (demo data only)
UPDATE public.hospital_staff SET signature_pin = NULL WHERE signature_pin IS NOT NULL;

-- 2. Lock down search_path on every existing function that was flagged
ALTER FUNCTION public.auto_order_ghost_labs() SET search_path = public;
ALTER FUNCTION public.auto_administer_ghost_meds() SET search_path = public;
ALTER FUNCTION public.auto_result_ghost_labs() SET search_path = public;
ALTER FUNCTION public.cascade_clinical_automation() SET search_path = public;
ALTER FUNCTION public.auto_admit_ghost_patient() SET search_path = public;
ALTER FUNCTION public.auto_discharge_ghost_patients() SET search_path = public;
ALTER FUNCTION public.generate_default_orders_for_new_patient() SET search_path = public;

-- 3. Replace the always-true INSERT policy on clinical_notes with an auth-gated one
DROP POLICY IF EXISTS "Authenticated users can insert clinical notes" ON public.clinical_notes;
CREATE POLICY "Authenticated users can insert clinical notes"
  ON public.clinical_notes
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);