ALTER TABLE public.bed_management REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.bed_management;