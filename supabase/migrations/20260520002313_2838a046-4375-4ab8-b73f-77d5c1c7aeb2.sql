ALTER TABLE public.role_permissions REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.role_permissions;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;