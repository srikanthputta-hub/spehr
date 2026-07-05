DROP INDEX IF EXISTS public.fhir_appointments_fhir_id_key;
DROP INDEX IF EXISTS public.fhir_payment_notices_fhir_id_key;
ALTER TABLE public.fhir_appointments ADD CONSTRAINT fhir_appointments_fhir_id_key UNIQUE (fhir_id);
ALTER TABLE public.fhir_payment_notices ADD CONSTRAINT fhir_payment_notices_fhir_id_key UNIQUE (fhir_id);