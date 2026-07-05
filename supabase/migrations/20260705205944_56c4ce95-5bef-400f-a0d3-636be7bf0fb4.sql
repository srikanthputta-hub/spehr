CREATE TABLE IF NOT EXISTS public.fhir_sync_state (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.fhir_sync_state TO service_role;

ALTER TABLE public.fhir_sync_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fhir_sync_state service only read"
  ON public.fhir_sync_state
  FOR SELECT
  USING (false);

CREATE TRIGGER fhir_sync_state_touch_updated_at
  BEFORE UPDATE ON public.fhir_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

INSERT INTO public.fhir_sync_state (key, value) VALUES
  ('appointment_last_polled_at', jsonb_build_object('ts', (now() - interval '10 minutes')::text)),
  ('paymentnotice_last_polled_at', jsonb_build_object('ts', (now() - interval '10 minutes')::text))
ON CONFLICT (key) DO NOTHING;