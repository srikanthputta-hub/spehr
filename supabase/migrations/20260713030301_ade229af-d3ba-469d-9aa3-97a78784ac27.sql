ALTER TABLE public.terminology_requests
  ADD COLUMN IF NOT EXISTS request_type text NOT NULL DEFAULT 'create',
  ADD COLUMN IF NOT EXISTS target_value_set_id uuid REFERENCES public.custom_value_sets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS terminology_requests_target_value_set_id_idx
  ON public.terminology_requests(target_value_set_id);