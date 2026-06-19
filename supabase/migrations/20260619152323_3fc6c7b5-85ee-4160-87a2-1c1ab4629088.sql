
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS assigned_department text;

CREATE TABLE IF NOT EXISTS public.auto_doc_runs (
  mrn text PRIMARY KEY,
  status text NOT NULL DEFAULT 'running',
  stage text NOT NULL DEFAULT 'pending',
  department text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error text
);
GRANT SELECT ON public.auto_doc_runs TO anon, authenticated;
GRANT ALL ON public.auto_doc_runs TO service_role;
ALTER TABLE public.auto_doc_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auto_doc_runs read" ON public.auto_doc_runs FOR SELECT USING (true);

CREATE TABLE IF NOT EXISTS public.auto_doc_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn text NOT NULL,
  stage text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auto_doc_logs_created_idx ON public.auto_doc_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS auto_doc_logs_mrn_idx ON public.auto_doc_logs (mrn, created_at DESC);
GRANT SELECT ON public.auto_doc_logs TO anon, authenticated;
GRANT ALL ON public.auto_doc_logs TO service_role;
ALTER TABLE public.auto_doc_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auto_doc_logs read" ON public.auto_doc_logs FOR SELECT USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.auto_doc_logs;

CREATE TABLE IF NOT EXISTS public.umls_term_cache (
  term text NOT NULL,
  vocabulary text NOT NULL,
  codes jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (term, vocabulary)
);
GRANT SELECT ON public.umls_term_cache TO anon, authenticated;
GRANT ALL ON public.umls_term_cache TO service_role;
ALTER TABLE public.umls_term_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY "umls cache read" ON public.umls_term_cache FOR SELECT USING (true);

-- Trigger: fire Auto Doc hook on new admissions (SQL-seeded ghost patients).
CREATE OR REPLACE FUNCTION public.notify_auto_doc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  hook_url text := 'https://project--c583ffa8-2be6-4140-bf75-9b224843471e.lovable.app/api/public/hooks/auto-doc';
BEGIN
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('mrn', NEW.mrn)
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'auto-doc dispatch failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS patients_auto_doc_after_insert ON public.patients;
CREATE TRIGGER patients_auto_doc_after_insert
AFTER INSERT ON public.patients
FOR EACH ROW
EXECUTE FUNCTION public.notify_auto_doc();
