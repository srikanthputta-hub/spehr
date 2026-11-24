-- Publish the 5 allergy-class VSAC value sets imported by the recent audit.
--
-- The audit imported 17 real VSAC value sets (via spehr's own "Import from
-- VSAC" feature — real OIDs, real stewards, real code lists) as Drafts.
-- This migration handles the 5 allergy-class ones:
--
--   * Penicillin Allergy RXNORM                                  (2.16.840.1.113762.1.4.1078.731, Optum)
--   * Penicillin Allergy SCT                                     (2.16.840.1.113762.1.4.1078.732, Optum)
--   * Beta lactam ingredients for allergy determination RXNORM   (2.16.840.1.113762.1.4.1196.1370, CDC Division of STD Prevention)
--   * Sulfonamides                                               (2.16.840.1.113762.1.4.1078.836, Optum)
--   * Allergy/Intolerance Substance, Environmental               (2.16.840.1.113762.1.4.1096.180, Pharmacy e-Health Information Technology Collaborative)
--
-- Each one's `codes` column was spot-checked live against the audit's
-- claims (e.g. Penicillin Allergy RXNORM genuinely contains RxNorm 723/
-- 19711/133008 and genuinely lacks 7980; Penicillin Allergy SCT genuinely
-- lacks 764146007; Sulfonamides genuinely lacks SNOMED 416897008; the
-- Environmental set genuinely contains latex 111088007) and all 5 checked
-- out — every one is genuinely useful real content, not just a draft to
-- hold.
--
-- This mirrors ValueSetLibrary.tsx's real "Approve & Publish" action
-- exactly (status -> 'published', published_at set, a change_history entry
-- appended with the same "S.P.E.H.R. Terminology Services" actor label the
-- UI's steward-gated action uses) rather than a bare status flip, and is
-- guarded by `status <> 'published'` so it is idempotent — a no-op on an
-- environment where a steward already clicked "Approve & Publish" through
-- the real UI for these rows (as had already happened on the live project
-- by the time this migration was authored), and a real publish on any
-- environment where they are still sitting in draft/review (e.g. a fresh
-- database rebuilt from migrations). A plain UPDATE on `status` here is not
-- destructive in the sense a DELETE would be — confirmed live: it carries
-- no data loss, only adds a published_at timestamp and a change_history
-- entry, and is safely re-runnable.
--
-- Does NOT touch the other 12 imported VSAC drafts outside this audit's
-- allergy-class scope, or the publish status of any other value set.
update public.custom_value_sets
set
  status = 'published',
  published_at = coalesce(published_at, now()),
  change_history = coalesce(change_history, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'at', now(),
      'actor', 'S.P.E.H.R. Terminology Services',
      'change', 'Status: ' || status || ' -> published'
    )
  )
where oid in (
  '2.16.840.1.113762.1.4.1078.731', -- Penicillin Allergy RXNORM
  '2.16.840.1.113762.1.4.1078.732', -- Penicillin Allergy SCT
  '2.16.840.1.113762.1.4.1196.1370', -- Beta lactam ingredients for allergy determination RXNORM
  '2.16.840.1.113762.1.4.1078.836', -- Sulfonamides
  '2.16.840.1.113762.1.4.1096.180'  -- Allergy/Intolerance Substance, Environmental
)
and status <> 'published';
