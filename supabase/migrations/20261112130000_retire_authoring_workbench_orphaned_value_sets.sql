-- Retire Authoring Workbench; clean up orphaned pre-VSAC-architecture value sets.
--
-- The Authoring Workbench (manual value-set authoring inside spehr) has been
-- removed: value sets are now authored in real NLM VSAC and pulled back via
-- the "Re-sync from VSAC" action (see PRs #56/#57, which replaced
-- auto-drafting with Auto Terminologist suggestion briefs into
-- `terminology_requests`).
--
-- This leaves six non-published `custom_value_sets` rows with no live
-- consumer (verified against `value_set_dependencies` before writing this
-- migration):
--
--   1. Three rows with fabricated-OID placeholders
--      (`2.16.840.1.113883.3.spehr.<timestamp>`), created by a since-fixed
--      bug in the Auto Terminologist background loop that auto-drafted
--      value sets instead of only suggesting them. They were never real
--      value sets, so they are deleted outright.
--   2. Three pre-existing seed/demo rows from 2026-09-01 (long before the
--      VSAC-pull architecture existed) that carry real-VSAC-format OIDs but
--      were never actually published through real VSAC. These are marked
--      `retired` (new status value; no CHECK constraint exists on
--      `custom_value_sets.status` to update) with a `change_history` entry
--      explaining why, so the audit trail is preserved rather than deleted.

-- 1. Delete the fake-OID rows outright — never real value sets.
delete from custom_value_sets
where id in (
  'f0873792-2efe-44d9-9922-30c6a7b27bc3',  -- Drug-Allergy coverage for "Penicillin"
  'ceeecff3-c600-4b19-8d00-ba5406fd8d06',  -- Drug-Allergy coverage for "Cefazolin"
  'e8421847-09c0-4321-9aac-99df8f2cf300'   -- CMS HRRP Conditions
);

-- 2. Retire the real-OID-format seed rows that predate the VSAC-pull
--    architecture and were never published through real VSAC.
update custom_value_sets
set
  status = 'retired',
  change_history = coalesce(change_history, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'actor', 'S.P.E.H.R. Terminology Services',
      'change', 'Retired - predates the VSAC-pull architecture; was never published through real VSAC. Authoring Workbench removed; if this value set is still needed, suggest it through Auto Terminologist or author it in real VSAC and pull it back via Re-sync.'
    )
  ),
  updated_at = now()
where id in (
  '895f9e19-8333-4495-b573-0e1266541878',  -- Hypertensive Disorders
  '8e1da1e8-45e7-45c3-a586-62cd4e96f395',  -- Sepsis & Septic Shock
  'de2814de-5a10-4a6f-ae73-2cae0b95bc90'   -- VTE Prophylaxis Medications
);
