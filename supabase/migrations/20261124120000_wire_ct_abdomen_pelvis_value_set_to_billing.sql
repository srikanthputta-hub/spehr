-- Wire the published VSAC "CT Abdomen and Pelvis" value set
-- (OID 2.16.840.1.113762.1.4.1078.1244, 44 codes, Optum — part of the
-- 17-value-set VSAC audit import) into the one real integration point
-- found for it: Auto Doc's imaging charge-line CPT resolution
-- (composeCharges()/lookupImagingCpt() in src/lib/billing-pricing.ts).
--
-- Investigated and rejected as integration points (see PR description):
--   - RadiologyOrderPanel.tsx's order-entry dropdown is a closed, fixed
--     list (not free text), so there is no typo/wrong-code risk for a
--     value-set validation step to catch there, unlike the RxNorm/
--     condition free-text resolution flows this mirrors.
--   - The "CT Abdomen/Pelvis" exam's hardcoded SNOMED (169071000) is a
--     real, valid legacy SNOMED CT concept not in this VSAC value set's
--     curated code list, but RadiologyOrderPanel.tsx explicitly documents
--     that the partner Imaging center matches purely on the FHIR
--     ServiceRequest id (not this code's value), so changing it would be
--     a cosmetic, risk-only change with no behavioral benefit.
--
-- What IS a real, previously-ungoverned gap: composeCharges() already
-- prefers a governed "Charge Master" value set over hardcoded internal
-- placeholder codes for room/board, nursing, physician-consult, pharmacy,
-- and lab charge lines (applyChargeMaster()/pickChargeMaster()) — but
-- imaging CPT codes were 100% hardcoded literals
-- (IMAGING_CPT_BY_SNOMED/IMAGING_CPT_BY_EXAM), with no governed value set
-- backing them at all. This value set is now wired the same way the
-- "Chronic Condition Risk-Adjustment Diagnoses" value set is wired to
-- Auto Admin's billing path (see 20260929000000_seed_billing_chronic_
-- condition_value_set.sql) — via value_set_dependencies, resolved with
-- loadPublishedValueSetsForConsumer() rather than the
-- clinical_application='Billing' filter (this VSAC-imported clinical
-- value set has no clinical_application tag, same as every other
-- VSAC-pulled value set in this audit).
--
-- Net effect on today's live data: none of the 62 existing
-- "CT Abdomen/Pelvis" radiology_orders carry a contrast flag, so the
-- resolved CPT still lands on CPT 74176 ("...without contrast") exactly
-- as before — but that code now comes from the real, published,
-- VSAC-governed code list instead of a bare TypeScript literal, and any
-- future "with contrast" distinction has a real value set to resolve
-- 74177/74178 from instead of another hardcoded guess.

INSERT INTO public.value_set_dependencies
  (consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required)
SELECT
  'Auto Admin — Invoice Imaging Charges',
  'src/lib/auto-doc.server.ts',
  'Resolve the real CPT code for CT Abdomen/Pelvis imaging charge lines (composeCharges()/lookupImagingCpt() in billing-pricing.ts) from governed VSAC terminology instead of a hardcoded literal',
  'by_name',
  v.id,
  v.name,
  true
FROM public.custom_value_sets v
WHERE v.name = 'CT Abdomen and Pelvis'
  AND v.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM public.value_set_dependencies d
    WHERE d.consumer = 'Auto Admin — Invoice Imaging Charges'
      AND d.value_set_name = 'CT Abdomen and Pelvis'
  );
