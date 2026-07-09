ALTER TABLE public.lab_orders ADD COLUMN IF NOT EXISTS svcreq_fhir_id text;
ALTER TABLE public.lab_orders ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'spehr';
CREATE INDEX IF NOT EXISTS lab_orders_svcreq_fhir_id_idx ON public.lab_orders (svcreq_fhir_id);
CREATE INDEX IF NOT EXISTS lab_orders_source_idx ON public.lab_orders (source);
-- Bootstrap poll cursor for inbound labs from the Health Hub Suite account.
INSERT INTO public.fhir_sync_state (key, value)
VALUES ('labs_observation_last_polled_at', jsonb_build_object('ts', (now() - interval '10 minutes')::text))
ON CONFLICT (key) DO NOTHING;