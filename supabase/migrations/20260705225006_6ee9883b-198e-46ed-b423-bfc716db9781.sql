-- Add clinical tables missing from Supabase realtime so the client-side
-- useBackgroundFhirSync fast-path re-enqueues on any clinical change.
-- The three tables below fire INSERTs during an admission cascade but are
-- currently absent from `supabase_realtime`, so the client push loop misses
-- them until the next 30s loadRows() refresh.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='lab_results'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lab_results;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='clinical_notes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.clinical_notes;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='conditions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conditions;
  END IF;
END $$;

-- Bootstrap the single per-MRN clinical cursor used by fhir-outbound-poll's
-- new pollClinical() function. Same pattern as the invoice/chargeitem/
-- appointment cursors: 24h look-back on first run so we don't backfill
-- everything ever inserted.
INSERT INTO public.fhir_sync_state (key, value) VALUES
  ('outbound_clinical_last_synced_at', jsonb_build_object('ts', (now() - interval '24 hours')::text))
ON CONFLICT (key) DO NOTHING;