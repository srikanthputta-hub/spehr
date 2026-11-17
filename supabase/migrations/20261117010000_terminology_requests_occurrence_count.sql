-- Real occurrence-frequency signal for the "Needs Your Review" queue
-- (AutoTerminologistActivity.tsx): how many times has this exact gap
-- actually been hit, as distinct from how many distinct seed codes ended
-- up merged into the filed request.
--
-- requestTerminologyUpdate() (src/lib/value-set-registry.ts) already has a
-- merge path for a duplicate pending request: the unique partial index
-- added in 20261112162643_terminology_requests_pending_dedup_idx.sql
-- (requesting_consumer, requested_name) WHERE status = 'pending' causes a
-- repeat ask to hit a 23505 conflict on insert, at which point the merge
-- path re-reads the existing pending row and folds the new seed_codes into
-- it (deduped by code) instead of creating a duplicate row. This column
-- adds a real hit-counter alongside that merge: every time the merge path
-- fires — even when the seed codes it carries were already present (e.g.
-- the same gap re-triggered by a different MRN hitting the identical
-- code) — this represents one more real-world occurrence of the gap, so
-- the counter increments regardless of whether seed_codes actually grew.
--
-- Nullable per spec, with a default of 1 so it's populated for existing
-- rows too (ADD COLUMN ... DEFAULT backfills existing rows in Postgres,
-- it isn't just a default for future inserts) and for any future insert
-- path that doesn't explicitly set it.
alter table public.terminology_requests
  add column if not exists occurrence_count integer default 1;

comment on column public.terminology_requests.occurrence_count is
  'How many times this exact (requesting_consumer, requested_name) gap has actually been hit -- starts at 1 on insert and is incremented by requestTerminologyUpdate()''s merge path (src/lib/value-set-registry.ts) every time a duplicate pending request is detected via the terminology_requests_pending_dedup_idx unique index, distinct from the number of distinct seed_codes merged. Nullable for defensive reads; treat null as 1 in the UI.';
