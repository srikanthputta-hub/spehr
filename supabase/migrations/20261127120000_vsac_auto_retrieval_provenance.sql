-- Auto Terminologist: autonomous VSAC discovery & retrieval — provenance
-- columns + a database guard on the publish gate.
--
-- NOT APPLIED. Written for review (see docs/auto-terminologist-vsac-retrieval-design.md).
-- Apply to `qxyvmvtecnnwqeqaouzh` BEFORE deploying the updated
-- `auto-terminologist-cycle` edge function. Deploying the function first is
-- safe — the discovery step cannot read its new columns, logs one
-- `vsac_error` line, and does nothing — but it is inert until this is applied.
--
-- Rollback (run in this order; nothing else depends on any of it):
--   -- 0. Requests parked in the new status would otherwise be orphaned. Any
--   --    drafts already staged stay in the library as ordinary drafts.
--   UPDATE public.terminology_requests SET status = 'pending' WHERE status = 'vsac_staged';
--   DROP TRIGGER  IF EXISTS guard_auto_staged_value_set ON public.custom_value_sets;
--   DROP FUNCTION IF EXISTS public.guard_auto_staged_value_set();
--   ALTER TABLE public.terminology_requests
--     DROP COLUMN IF EXISTS vsac_discovery_result,
--     DROP COLUMN IF EXISTS vsac_discovery_attempts,
--     DROP COLUMN IF EXISTS vsac_discovery_at;
--   ALTER TABLE public.custom_value_sets DROP COLUMN IF EXISTS provenance;
--
-- Everything here is additive and idempotent. No existing row changes.

-- 1. Where a value set came from -------------------------------------------

ALTER TABLE public.custom_value_sets
  ADD COLUMN IF NOT EXISTS provenance jsonb;

COMMENT ON COLUMN public.custom_value_sets.provenance IS
  'Where this value set came from, verbatim from the source system. For VSAC retrievals: {source, oid, vsac_version, vsac_status, vsac_publisher, vsac_date, expansion_timestamp, expansion_parameters, total_reported, codes_retrieved, content_sha256, retrieved_at, source_url, attribution, ...}. When staged_by = ''auto-terminologist'' the row was created by the Auto Terminologist''s VSAC discovery pass as an inert draft; the guard trigger below stops that engine from promoting it. NULL for hand-authored and legacy rows.';

-- 2. Discovery bookkeeping on the demand queue -----------------------------

ALTER TABLE public.terminology_requests
  ADD COLUMN IF NOT EXISTS vsac_discovery_at timestamptz,
  ADD COLUMN IF NOT EXISTS vsac_discovery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vsac_discovery_result jsonb;

COMMENT ON COLUMN public.terminology_requests.vsac_discovery_at IS
  'When the VSAC discovery pass last reached a verdict on this request (staged, previewed, or found no match). Drives the retry cooldown. NULL = never attempted.';
COMMENT ON COLUMN public.terminology_requests.vsac_discovery_attempts IS
  'How many times VSAC discovery found no usable match for this request. The pass stops at 3 (cooldown = attempts x 24h). Transient VSAC errors (network, 5xx, rate limit) do NOT count.';
COMMENT ON COLUMN public.terminology_requests.vsac_discovery_result IS
  'Audit trail of the last discovery verdict: {at, outcome (staged|previewed|no_match|already_in_library), mode, search_terms, source_of_candidates, considered: [{oid, name, publisher, total, outcome, reason, coverage, name_score}], chosen_oid, value_set_id, api_requests_used}. Read this first when asking why a request was or was not matched.';

-- `terminology_requests.status` has no CHECK constraint (see
-- 20261112180000_vsac_search_and_publication_poll_fields.sql), so the new
-- status value `vsac_staged` — "an inert draft was auto-staged from VSAC and
-- is waiting for a steward to review/publish it in the Value Set Library;
-- `value_set_id` points at it" — needs no DDL.

-- 3. The publish gate, enforced in the database ----------------------------
--
-- The Auto Terminologist runs under the service_role credential. This trigger
-- makes it impossible for THAT credential to move a value set it auto-staged
-- to `review` or `published`, to rewrite its content once a steward owns it,
-- or to rewrite/strip its provenance — even if a bug or a future change in
-- the application code tried to.
--
-- Who counts as "the engine": a request whose JWT role claim is service_role,
-- OR whose Postgres role (current_user) is service_role. Checking both means a
-- SECURITY DEFINER wrapper that changes current_user does not shed the claim,
-- and a path with no claim set does not shed the role.
--
-- What it does NOT do, stated plainly:
--  * spehr has no user login today (see docs/edge-function-auth-hardening-plan.md),
--    so a steward in the browser arrives as the `anon` role and so does anyone
--    else holding the public anon key. The guard separates "the engine" from
--    "anyone using the app"; it cannot tell WHICH person published. That needs
--    real auth (Stage 2+ of that plan).
--  * The browser-tab copy of the cycle (src/hooks/useAutoTerminologist.ts) runs
--    as `anon`, so it is outside this guard by design. It is handed no VSAC
--    gateway, so it never stages a draft; the guard is not what stops it.
--  * It only constrains rows the engine itself stamped
--    (provenance.staged_by = 'auto-terminologist'). It deliberately does NOT
--    refuse every service_role insert of a non-draft row: spehrancillary.live
--    and spehranalytics.live share this project and may legitimately write
--    with the same credential, and nothing in this repo can prove they don't.
--    Once that is confirmed, a stricter rule ("service_role may only insert
--    drafts") is a one-line addition in the INSERT branch below.
--  * Direct SQL (migrations, the SQL editor) carries neither a JWT role nor
--    the service_role Postgres role and is not restricted.

CREATE OR REPLACE FUNCTION public.guard_auto_staged_value_set()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  claims_txt  text := nullif(current_setting('request.jwt.claims', true), '');
  caller_role text;
BEGIN
  BEGIN
    caller_role := coalesce(
      (claims_txt::jsonb) ->> 'role',
      nullif(current_setting('request.jwt.claim.role', true), '')
    );
  EXCEPTION WHEN others THEN
    caller_role := nullif(current_setting('request.jwt.claim.role', true), '');
  END;

  IF caller_role IS DISTINCT FROM 'service_role' AND current_user <> 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF (NEW.provenance ->> 'staged_by') = 'auto-terminologist'
       AND NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION
        'Auto-staged value sets must be created as draft (got %): only a human steward may promote one', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (OLD.provenance ->> 'staged_by') = 'auto-terminologist' THEN
    IF NEW.status IN ('review', 'published')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION
        'The Auto Terminologist may not move an auto-staged value set to % — a human steward must review and publish it', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.provenance IS DISTINCT FROM OLD.provenance THEN
      RAISE EXCEPTION
        'The Auto Terminologist may not rewrite or remove the provenance of an auto-staged value set'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Once a steward has taken the row past 'draft' (review / published /
    -- deprecation-suggested) its content is theirs. The engine may still flag
    -- it 'deprecation-suggested' and the FHIR publisher may stamp fhir_* fields,
    -- but it may not swap the codes or the OID under an approved value set —
    -- the retrieval record in `provenance` would no longer describe them.
    IF OLD.status IS DISTINCT FROM 'draft'
       AND (NEW.codes IS DISTINCT FROM OLD.codes OR NEW.oid IS DISTINCT FROM OLD.oid) THEN
      RAISE EXCEPTION
        'The Auto Terminologist may not change the codes or OID of an auto-staged value set a steward has taken past draft'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_auto_staged_value_set ON public.custom_value_sets;
CREATE TRIGGER guard_auto_staged_value_set
  BEFORE INSERT OR UPDATE ON public.custom_value_sets
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_auto_staged_value_set();
