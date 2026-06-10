DROP TRIGGER IF EXISTS trg_seed_orders_for_admitted_patient ON public.patients;
DROP FUNCTION IF EXISTS public.seed_orders_for_admitted_patient();