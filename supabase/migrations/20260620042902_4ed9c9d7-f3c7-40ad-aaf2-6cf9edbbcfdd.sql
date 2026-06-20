
-- =============================================================
-- Universal Data Persistence & Provenance Layer
-- =============================================================

-- 1. Provenance origin enum
DO $$ BEGIN
  CREATE TYPE public.provenance_origin AS ENUM ('human', 'automation', 'system', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Generic FHIR catch-all (dynamic resource provisioning)
CREATE TABLE IF NOT EXISTS public.fhir_resources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type   text NOT NULL,
  resource_id     text,
  mrn             text,
  payload         jsonb NOT NULL,
  source          text,
  created_by_type public.provenance_origin NOT NULL DEFAULT 'automation',
  author_id       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_fhir_resources_type ON public.fhir_resources(resource_type);
CREATE INDEX IF NOT EXISTS idx_fhir_resources_mrn  ON public.fhir_resources(mrn);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fhir_resources TO authenticated;
GRANT ALL ON public.fhir_resources TO service_role;
ALTER TABLE public.fhir_resources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fhir_resources_all_auth" ON public.fhir_resources;
CREATE POLICY "fhir_resources_all_auth" ON public.fhir_resources FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3. Master provenance / audit log (every write echoes here)
CREATE TABLE IF NOT EXISTS public.data_provenance (
  id              bigserial PRIMARY KEY,
  table_name      text NOT NULL,
  row_id          text,
  operation       text NOT NULL,
  origin          public.provenance_origin NOT NULL DEFAULT 'unknown',
  author_id       text,
  author_label    text,
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provenance_table ON public.data_provenance(table_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provenance_author ON public.data_provenance(author_id);

GRANT SELECT, INSERT ON public.data_provenance TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.data_provenance_id_seq TO authenticated;
GRANT ALL ON public.data_provenance TO service_role;
GRANT ALL ON SEQUENCE public.data_provenance_id_seq TO service_role;
ALTER TABLE public.data_provenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "provenance_read_auth" ON public.data_provenance;
CREATE POLICY "provenance_read_auth" ON public.data_provenance FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "provenance_insert_auth" ON public.data_provenance;
CREATE POLICY "provenance_insert_auth" ON public.data_provenance FOR INSERT TO authenticated WITH CHECK (true);

-- 4. Offline / failed-write outbox (write-through master archive)
CREATE TABLE IF NOT EXISTS public.pending_writes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name      text NOT NULL,
  operation       text NOT NULL,
  payload         jsonb NOT NULL,
  origin          public.provenance_origin NOT NULL DEFAULT 'unknown',
  author_id       text,
  status          text NOT NULL DEFAULT 'pending',
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_writes_status ON public.pending_writes(status, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_writes TO authenticated;
GRANT ALL ON public.pending_writes TO service_role;
ALTER TABLE public.pending_writes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "pending_writes_all_auth" ON public.pending_writes;
CREATE POLICY "pending_writes_all_auth" ON public.pending_writes FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 5. Shared updated_at trigger function (idempotent)
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 6. Bulk-apply provenance columns + updated_at trigger to every base table in public
DO $$
DECLARE
  t RECORD;
  has_created boolean;
  has_updated boolean;
  has_origin  boolean;
  has_author  boolean;
BEGIN
  FOR t IN
    SELECT c.relname AS tbl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname NOT IN ('data_provenance','pending_writes','schema_migrations','simulation_chief_complaints','automation_watchdog_logs')
  LOOP
    -- created_by_type
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t.tbl AND column_name='created_by_type') INTO has_origin;
    IF NOT has_origin THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN created_by_type public.provenance_origin NOT NULL DEFAULT ''unknown''', t.tbl);
    END IF;

    -- author_id
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t.tbl AND column_name='author_id') INTO has_author;
    IF NOT has_author THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN author_id text', t.tbl);
    END IF;

    -- created_at
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t.tbl AND column_name='created_at') INTO has_created;
    IF NOT has_created THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()', t.tbl);
    END IF;

    -- updated_at + trigger
    SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t.tbl AND column_name='updated_at') INTO has_updated;
    IF NOT has_updated THEN
      EXECUTE format('ALTER TABLE public.%I ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()', t.tbl);
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_updated_at ON public.%I', t.tbl);
    EXECUTE format('CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at()', t.tbl);
  END LOOP;
END $$;

-- 7. Dynamic FHIR resource upsert helper (no DDL needed at runtime — catch-all table)
CREATE OR REPLACE FUNCTION public.persist_fhir_resource(
  _resource_type text,
  _resource_id   text,
  _mrn           text,
  _payload       jsonb,
  _source        text DEFAULT 'auto-doc',
  _origin        public.provenance_origin DEFAULT 'automation',
  _author_id     text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO public.fhir_resources (resource_type, resource_id, mrn, payload, source, created_by_type, author_id)
  VALUES (_resource_type, _resource_id, _mrn, _payload, _source, _origin, _author_id)
  ON CONFLICT (resource_type, resource_id)
  DO UPDATE SET payload = EXCLUDED.payload,
                mrn = COALESCE(EXCLUDED.mrn, public.fhir_resources.mrn),
                source = EXCLUDED.source,
                updated_at = now()
  RETURNING id INTO new_id;

  INSERT INTO public.data_provenance (table_name, row_id, operation, origin, author_id, author_label, payload)
  VALUES ('fhir_resources', new_id::text, 'UPSERT', _origin, _author_id, _source, jsonb_build_object('resource_type', _resource_type, 'resource_id', _resource_id));

  RETURN new_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.persist_fhir_resource(text,text,text,jsonb,text,public.provenance_origin,text) TO authenticated, service_role;
