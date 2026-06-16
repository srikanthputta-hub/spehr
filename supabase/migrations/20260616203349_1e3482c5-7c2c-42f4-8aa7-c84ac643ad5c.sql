ALTER FUNCTION public.auto_admit_ghost_patient()
  SECURITY DEFINER
  SET search_path TO public;

ALTER FUNCTION public.prune_active_patients_cache()
  SECURITY DEFINER
  SET search_path TO public;

ALTER FUNCTION public.route_admission_data()
  SECURITY DEFINER
  SET search_path TO public;

GRANT EXECUTE ON FUNCTION public.auto_admit_ghost_patient() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prune_active_patients_cache() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.route_admission_data() TO anon, authenticated, service_role;