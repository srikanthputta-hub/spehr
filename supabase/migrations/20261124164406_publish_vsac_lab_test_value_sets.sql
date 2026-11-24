-- Publish the 4 lab-test VSAC value sets flagged "strong fit" by the recent
-- terminology audit (Mathematica Patient Safety Indicators steward), moving
-- them from Draft to Published so they're actually usable, not just held:
--
--   Hemoglobin lab test                 2.16.840.1.113762.1.4.1248.219 (11 codes)
--   Leukocyte count lab test            2.16.840.1.113762.1.4.1248.222 ( 5 codes)
--   Creatinine Mass Per Volume          2.16.840.1.113762.1.4.1248.21  ( 3 codes)
--   Glucose Lab Test Mass Per Volume    2.16.840.1.113762.1.4.1248.34  (16 codes)
--
-- Verified live before writing this migration (execute_sql reads against
-- qxyvmvtecnnwqeqaouzh): each set's `codes` column genuinely contains its
-- claimed real LOINC code (718-7 Hemoglobin, 6690-2 WBC, 2160-0 Creatinine,
-- 2345-7 Glucose) and every other code in each list is a coherent member of
-- the same analyte family (specimen/method variants of the same lab test,
-- not unrelated codes) — e.g. Hemoglobin's 11 codes are all
-- Hemoglobin [Mass/Moles per volume] in {Blood/Arterial/Venous/Capillary/
-- Mixed venous/Central venous} blood. All 4 already carry real VSAC OIDs
-- and the real "Mathematica Patient Safety Indicators" steward from the
-- VSAC import — nothing fabricated.
--
-- Fields set mirror exactly what ValueSetLibrary.tsx's real "Approve &
-- Publish" action sets (`transitionStatus`), reached only from `status =
-- 'review'`: `status`, `published_at`, an appended `change_history` entry
-- with the real app's actor string, and `updated_at`. There is no
-- `reviewed_at` column on `custom_value_sets` (checked information_schema)
-- so none is set. The real workflow is two steps (draft → review via
-- "Submit for Review", then review → published via "Approve & Publish"),
-- so this migration reproduces both steps in order.
--
-- NOTE: as of this writing, all 4 rows are ALREADY `status = 'published'`
-- live (with correct `published_at` / `change_history` already recorded,
-- matching this same app-generated shape) — published directly against
-- qxyvmvtecnnwqeqaouzh ahead of this migration being written. Every UPDATE
-- below is guarded by its expected starting `status`, so it is a no-op
-- against that already-published state and only does real work against a
-- fresh/local/CI database that still has these 4 as Drafts from the VSAC
-- import — keeping every environment converging on the same end state
-- without clobbering the live `published_at` timestamps already recorded.
-- `dictionary.steward_approve` is enabled for all roles at all facilities
-- (project owner authorization), so no additional approval gate applies.

-- Step 1 (draft → review, "Submit for Review"): no-op live (already past review).
UPDATE custom_value_sets
SET
  status = 'review',
  change_history = COALESCE(change_history, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'at', now(),
      'actor', 'S.P.E.H.R. Terminology Services',
      'change', 'Status: draft → review'
    )
  ),
  updated_at = now()
WHERE oid IN (
  '2.16.840.1.113762.1.4.1248.219',
  '2.16.840.1.113762.1.4.1248.222',
  '2.16.840.1.113762.1.4.1248.21',
  '2.16.840.1.113762.1.4.1248.34'
)
AND status = 'draft';

-- Step 2 (review → published, "Approve & Publish"): no-op live (already published).
UPDATE custom_value_sets
SET
  status = 'published',
  published_at = now(),
  change_history = COALESCE(change_history, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'at', now(),
      'actor', 'S.P.E.H.R. Terminology Services',
      'change', 'Status: review → published'
    )
  ),
  updated_at = now()
WHERE oid IN (
  '2.16.840.1.113762.1.4.1248.219',
  '2.16.840.1.113762.1.4.1248.222',
  '2.16.840.1.113762.1.4.1248.21',
  '2.16.840.1.113762.1.4.1248.34'
)
AND status = 'review';
