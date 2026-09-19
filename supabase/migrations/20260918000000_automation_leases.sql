-- ============================================================================
-- automation_leases — atomic DB-backed leader-election lease
-- ----------------------------------------------------------------------------
-- Implements the "Proposed fix — atomic DB-backed lease" section of
-- docs/leader-election-fix-design.md. Replaces the useAutoTerminologist.ts
-- localStorage read-then-write leader election (tryAcquireLeader) and the
-- getLastRunAt()-based check-then-act cadence gate with a single atomic
-- UPDATE ... WHERE ... RETURNING claim, callable from the client via
-- supabase.rpc('claim_automation_lease', ...).
--
-- *** PAIRED CHANGE — READ BEFORE APPLYING ***
-- This migration must be applied to the target Supabase project BEFORE the
-- corresponding src/hooks/useAutoTerminologist.ts code (which calls the
-- claim_automation_lease / heartbeat_automation_lease RPCs below) is
-- deployed. The RPCs do not exist until this migration runs, so the two
-- changes are not independently shippable — deploying the hook first against
-- a project without this migration will make every tick a no-op (RPC not
-- found), and applying only this migration is inert until the hook change
-- ships. This file is provided for review; it is NOT applied automatically.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table: one row per automation engine (PK = engine name). Reusable by other
-- engines (e.g. a future useAutomationWatchdog migration) — out of scope here
-- per the design doc, but the schema supports it.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.automation_leases (
  engine        text PRIMARY KEY,
  holder        text,
  leased_until  timestamptz NOT NULL DEFAULT '-infinity'::timestamptz,
  last_run_at   timestamptz NOT NULL DEFAULT '-infinity'::timestamptz
);

COMMENT ON TABLE public.automation_leases IS
  'Atomic DB-backed leader-election lease per automation engine. Written only '
  'via claim_automation_lease()/heartbeat_automation_lease() SECURITY DEFINER '
  'functions — no direct table grants to anon/authenticated. See '
  'docs/leader-election-fix-design.md.';

-- Seed one row for the auto_terminologist engine so the very first claim
-- attempt has a row to UPDATE (the claim function only ever UPDATEs, never
-- inserts). '-infinity' for both leased_until and last_run_at means the
-- first tab to tick can claim immediately.
INSERT INTO public.automation_leases (engine, holder, leased_until, last_run_at)
VALUES ('auto_terminologist', NULL, '-infinity'::timestamptz, '-infinity'::timestamptz)
ON CONFLICT (engine) DO NOTHING;

-- ----------------------------------------------------------------------------
-- claim_automation_lease — the single atomic claim call.
--
-- Zero rows returned  = another tab currently holds the lease, or the
--                        min_interval_ms cadence hasn't elapsed yet →
--                        caller should skip this cycle.
-- One row returned    = caller now owns the lease for lease_ms and should
--                        run the cycle. last_run_at is advanced to now() at
--                        claim time (same "heartbeat first, never drift"
--                        behaviour as the old getLastRunAt()-gated insert).
--
-- The UPDATE's WHERE predicate and SET both execute under the same row
-- lock, so exactly one concurrent caller can ever win a given claim.
--
-- SECURITY — server-side clamping (both params are caller-controlled and
-- reach anon/authenticated via GRANT EXECUTE below, so they must never be
-- trusted as-is):
--   _lease_ms        clamped to [30000, 300000] (30s–5min). The app's real
--                     value is LEADER_LEASE_MS = 180000 (3min) in
--                     useAutoTerminologist.ts — this brackets that with
--                     headroom while capping the max lease length so a
--                     caller can no longer request an ~24.8-day lease and
--                     lock every other tab out indefinitely.
--   _min_interval_ms clamped to [60000, 3600000] (1min–1hr). The app's real
--                     value is RUN_INTERVAL_MS = 600000 (10min) — this
--                     brackets that, while stopping a near-zero/negative
--                     value from defeating the cadence gate and driving
--                     excessive downstream API/DB load.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_automation_lease(
  _engine text,
  _holder text,
  _lease_ms integer,
  _min_interval_ms integer
)
RETURNS SETOF public.automation_leases
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.automation_leases
     SET holder       = _holder,
         leased_until = now() + (GREATEST(LEAST(_lease_ms, 300000), 30000)::text || ' milliseconds')::interval,
         last_run_at  = now()
   WHERE engine = _engine
     AND leased_until < now()                                                      -- no live holder
     AND last_run_at  < now() - (GREATEST(LEAST(_min_interval_ms, 3600000), 60000)::text || ' milliseconds')::interval  -- cadence gate, clamped
  RETURNING *;
$$;

COMMENT ON FUNCTION public.claim_automation_lease(text, text, integer, integer) IS
  'Atomically claim the lease for one automation engine cycle. Returns 0 or 1 '
  'rows. _lease_ms is server-side clamped to [30000,300000]ms and '
  '_min_interval_ms to [60000,3600000]ms regardless of caller input — see '
  'docs/leader-election-fix-design.md.';

-- ----------------------------------------------------------------------------
-- heartbeat_automation_lease — mid-cycle lease renewal so a long-running
-- cycle cannot have its lease stolen by another tab before it finishes, while
-- a crashed/closed tab still frees the lease within one TTL (it simply stops
-- renewing and leased_until lapses naturally).
--
-- Also doubles as the best-effort RELEASE call: passing a small/negative
-- _lease_ms (e.g. -1000) sets leased_until into the past, which makes the
-- lease immediately claimable again by the next claim_automation_lease call.
-- This keeps the migration to exactly two functions per the design doc,
-- rather than adding a third release_automation_lease function.
--
-- Only renews when _holder still matches the current holder — a tab that
-- lost the lease (e.g. TTL lapsed and another tab claimed it) cannot steal
-- it back via heartbeat.
--
-- SECURITY — server-side clamping: _lease_ms is caller-controlled and this
-- function is GRANTed to anon/authenticated, so it must never be trusted
-- as-is. Clamped to [-300000, 300000] (-5min..5min), NOT the positive-only
-- [30000,300000] range used by claim_automation_lease, because this
-- function deliberately doubles as the release call (see above) —
-- useAutoTerminologist.ts's releaseLeaseBestEffort() passes _lease_ms =
-- -1000 to move leased_until into the past immediately. A positive-only
-- floor would silently turn that "release now" into "release in 30s+".
-- The ceiling still closes the real hole: a caller can no longer pass an
-- ~24.8-day _lease_ms to renew the lease far into the future and lock out
-- every other tab indefinitely. The app's real renewal value is
-- LEADER_LEASE_MS = 180000 (3min), comfortably inside [−300000, 300000].
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.heartbeat_automation_lease(
  _engine text,
  _holder text,
  _lease_ms integer
)
RETURNS SETOF public.automation_leases
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.automation_leases
     SET leased_until = now() + (GREATEST(LEAST(_lease_ms, 300000), -300000)::text || ' milliseconds')::interval
   WHERE engine = _engine
     AND holder = _holder
  RETURNING *;
$$;

COMMENT ON FUNCTION public.heartbeat_automation_lease(text, text, integer) IS
  'Renew (or, with a negative _lease_ms, best-effort release) the current '
  'holder''s lease. No-op if _holder no longer matches the recorded holder. '
  '_lease_ms is server-side clamped to [-300000,300000]ms regardless of '
  'caller input (asymmetric vs. claim_automation_lease to preserve the '
  'negative-value release path) — see docs/leader-election-fix-design.md.';

-- ----------------------------------------------------------------------------
-- RLS — no direct table access for anon/authenticated. All access goes
-- through the two SECURITY DEFINER functions above (whose owner, the
-- migration role, is the table owner and therefore exempt from RLS in the
-- normal Postgres/Supabase default of RLS not applying to table owners).
-- ----------------------------------------------------------------------------
ALTER TABLE public.automation_leases ENABLE ROW LEVEL SECURITY;
-- Deliberately no CREATE POLICY statements — RLS with zero policies denies
-- all rows to non-owner roles, which is what we want here.

REVOKE ALL ON public.automation_leases FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.claim_automation_lease(text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_automation_lease(text, text, integer, integer) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.heartbeat_automation_lease(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.heartbeat_automation_lease(text, text, integer) TO anon, authenticated;
