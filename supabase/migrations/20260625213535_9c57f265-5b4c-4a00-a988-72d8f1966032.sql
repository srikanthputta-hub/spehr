CREATE TABLE IF NOT EXISTS public.umls_cache (
  cache_key TEXT PRIMARY KEY,
  response JSONB NOT NULL,
  vocabulary TEXT NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

GRANT SELECT ON public.umls_cache TO anon, authenticated;
GRANT ALL ON public.umls_cache TO service_role;

ALTER TABLE public.umls_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "umls_cache readable by all"
  ON public.umls_cache FOR SELECT
  USING (true);

CREATE POLICY "umls_cache service role writes"
  ON public.umls_cache FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_umls_cache_expires ON public.umls_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_umls_cache_vocab ON public.umls_cache(vocabulary);