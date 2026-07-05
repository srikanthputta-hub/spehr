
-- Outbound FHIR sync state cursors. Mirror the inbound pattern.
-- Bootstrap to 24h ago so first cron run picks up a meaningful window of
-- existing data without replaying everything ever.
INSERT INTO public.fhir_sync_state (key, value) VALUES
  ('outbound_invoice_last_synced_at',     jsonb_build_object('ts', (now() - interval '24 hours')::text)),
  ('outbound_chargeitem_last_synced_at',  jsonb_build_object('ts', (now() - interval '24 hours')::text)),
  ('outbound_appointment_last_synced_at', jsonb_build_object('ts', (now() - interval '24 hours')::text))
ON CONFLICT (key) DO NOTHING;
