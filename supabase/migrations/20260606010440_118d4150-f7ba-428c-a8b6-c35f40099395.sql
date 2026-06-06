DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'patients'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.patients;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'medication_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.medication_orders;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lab_orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lab_orders;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'system_settings'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'system_settings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.system_settings;
  END IF;
END $$;

ALTER TABLE public.patients REPLICA IDENTITY FULL;
ALTER TABLE public.medication_orders REPLICA IDENTITY FULL;
ALTER TABLE public.lab_orders REPLICA IDENTITY FULL;

CREATE OR REPLACE FUNCTION public.auto_order_ghost_labs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Retired legacy bulk auto-completion routine.
  -- Live admission cascades are handled by the MRN-isolated application automation
  -- so medication/lab rows progress through Ordered -> active -> final states with
  -- precise execution timestamps instead of being inserted as already completed.
  RETURN;
END;
$$;