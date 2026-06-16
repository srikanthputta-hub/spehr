
CREATE OR REPLACE FUNCTION public.notify_push_to_fhir()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  edge_url text := 'https://fjncfbqwyrenoavhkvdr.supabase.co/functions/v1/push_to_fhir';
  payload  jsonb;
BEGIN
  payload := jsonb_build_object(
    'type',   TG_OP,
    'table',  TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA,
    'record', to_jsonb(NEW)
  );

  PERFORM net.http_post(
    url     := edge_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := payload
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push_to_fhir dispatch failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patients_push_to_fhir ON public.patients;

CREATE TRIGGER trg_patients_push_to_fhir
AFTER INSERT ON public.patients
FOR EACH ROW
EXECUTE FUNCTION public.notify_push_to_fhir();
