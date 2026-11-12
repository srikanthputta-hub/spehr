-- Enforce the dedup guarantee that requestTerminologyUpdate() already
-- assumes (src/lib/value-set-registry.ts): it inserts a new pending
-- terminology_requests row, and on a unique_violation (23505) for
-- (requesting_consumer, requested_name) it re-reads the existing pending
-- row and merges the new seed_codes into it by code instead of creating a
-- duplicate. No such unique constraint actually existed in the live
-- schema — only the primary key — so every insert silently succeeded and
-- the merge path never fired. Over a few hours this produced 136
-- duplicate pending rows (e.g. "Drug-Allergy coverage for \"Penicillin\""
-- inserted 88 separate times instead of being merged into one row with 13
-- distinct codes).
--
-- Applied live against qxyvmvtecnnwqeqaouzh and confirmed via pg_indexes
-- before this migration file was added. The one-time consolidation of the
-- 136 pre-existing duplicate rows down to 4 (merging seed_codes by code,
-- matching requestTerminologyUpdate()'s own merge logic) was done
-- separately as one-time data cleanup and is not part of this migration.
CREATE UNIQUE INDEX terminology_requests_pending_dedup_idx
  ON public.terminology_requests (requesting_consumer, requested_name)
  WHERE status = 'pending';
