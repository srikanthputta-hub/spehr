-- Fix 12 RxNorm codes flagged by an independent audit against NLM RxNav
-- (https://rxnav.nlm.nih.gov) as carrying a wrong name in spehr, or not
-- being a current/valid RxNorm concept at all.
--
-- Every code/value below was independently re-verified live against
-- https://rxnav.nlm.nih.gov/REST/rxcui/{code}/properties.json before this
-- migration was written. See PR description for the full before/after
-- table and per-code rationale (label-fix vs. code-fix decision).
--
-- Root cause: `medical_terminology` holds two overlapping seed batches for
-- the same Auto Doc condition protocols (2026-09-01 and 2026-09-25/26).
-- The earlier batch has several outright wrong RxNorm codes (2191, 1819,
-- 702028, 866427, 894994). The later batch has the CORRECT codes for the
-- same drugs (562508, 7052, 283669, 866924) but ~93 of its rows (across
-- many unrelated drugs, not just these) got their `display` bulk-set to
-- the literal placeholder string "Acetaminophen" by a labeling bug. This
-- migration fixes only the rows that intersect the 12 audited codes;
-- the remaining ~93-5=88 "Acetaminophen"-mislabeled rows are a separate,
-- larger follow-up (tracked outside this PR, not fabricated-fixed here).
--
-- 207 / 292 / 307 / 1213 ("Hospital Admission" / "Stroke" / "Emergency
-- Department Visit" / "Antibiotics for Sepsis") are NOT touched: they are
-- already correctly stored as code_system='VSAC' full dotted OIDs (e.g.
-- '2.16.840.1.113762.1.4.1029.207'), not RxNorm. The audit's "filed under
-- RxNorm" numbers are the trailing segment of those OIDs, not RxNorm
-- codes spehr ever stored — no spehr bug exists here, so no fix is made.
--
-- NOTE: this migration was already applied directly to qxyvmvtecnnwqeqaouzh
-- (dry-run SELECT-validated first) during investigation, because it fixes
-- a confirmed patient-data-impact bug (MRN-995147 / MRN-663203). It is
-- included here, in the same idempotent form, for review/history and so
-- `supabase db` tooling and any other environment stay in sync.

-- 1) Rows whose CODE was already correct for the drug real-world identity
--    the Auto Doc protocol clearly intended (confirmed via dose/route in
--    medication_orders / complaint-protocols.ts) but whose DISPLAY was
--    wrong (bulk "Acetaminophen" placeholder, or a stale third label).
UPDATE medical_terminology SET display = 'Aspirin', updated_at = now()
  WHERE code_system = 'RxNorm' AND code = '1191' AND display = 'Acetaminophen';

UPDATE medical_terminology SET display = 'Azithromycin', updated_at = now()
  WHERE code_system = 'RxNorm' AND code = '18631' AND display = 'Acetaminophen';

UPDATE medical_terminology SET display = 'Amoxicillin-Clavulanate', updated_at = now()
  WHERE code_system = 'RxNorm' AND code = '562508' AND display = 'Acetaminophen';

UPDATE medical_terminology SET display = 'Morphine', updated_at = now()
  WHERE code_system = 'RxNorm' AND code = '7052' AND display = 'Acetaminophen';

UPDATE medical_terminology SET display = 'Pantoprazole 40 mg Injection', updated_at = now()
  WHERE code_system = 'RxNorm' AND code = '283669' AND display = 'Acetaminophen';

-- 2193 really is ceftriaxone (confirmed on RxNav) and is already used
-- correctly for ceftriaxone elsewhere in the app (complaint-protocols.ts,
-- Sepsis + Post-Op Appendectomy protocols). Re-point this row's label at
-- its real identity instead of leaving it as a duplicate "Azithromycin"
-- entry (the Azithromycin/CAP use case now has its own correct row: 18631
-- above), so ceftriaxone finally has a correct Medical Dictionary entry.
UPDATE medical_terminology
  SET display = 'Ceftriaxone',
      description = 'IV antibiotic ordered by Auto Doc for Sepsis and Post-Operative Appendectomy protocols.',
      updated_at = now()
  WHERE code_system = 'RxNorm' AND code = '2193' AND display = 'Azithromycin';

-- 2) Rows whose code was simply wrong and is now superseded by a row that
--    already carries the correct current RxNorm code for the same real
--    drug/strength (fixed in step 1, or already correct beforehand for
--    866924 "Metoprolol Tartrate 25 MG Oral Tablet"). Delete the stale
--    wrong-code duplicates rather than leaving fake codes in the catalog.
DELETE FROM medical_terminology
  WHERE code_system = 'RxNorm' AND code = '2191' AND display = 'Amoxicillin-Clavulanate'; -- was ceftazidime
DELETE FROM medical_terminology
  WHERE code_system = 'RxNorm' AND code = '1819' AND display = 'Morphine'; -- was buprenorphine
DELETE FROM medical_terminology
  WHERE code_system = 'RxNorm' AND code = '702028' AND display = 'Pantoprazole 40 mg Injection'; -- was sodium chloride nasal spray
DELETE FROM medical_terminology
  WHERE code_system = 'RxNorm' AND code = '866427' AND display = 'Metoprolol Tartrate 25 mg Oral Tablet'; -- was metoprolol SUCCINATE ER

-- 3) Rows with no pre-existing duplicate: fix the code in place to the
--    real, current RxNorm concept matching the already-correct label.
UPDATE medical_terminology SET code = '198444', updated_at = now()
  WHERE code_system = 'RxNorm' AND code = '313782' AND display = 'Acetaminophen 650 mg Oral Tablet';
  -- 313782 is really "acetaminophen 325 MG Oral Tablet" (strength mismatch);
  -- 198444 is the real, current "acetaminophen 650 MG Oral Tablet".

UPDATE medical_terminology SET code = '2003714', updated_at = now()
  WHERE code_system = 'RxNorm' AND code = '894994' AND display = 'Morphine Sulfate 2 mg Injection';
  -- 894994 has no current RxNorm properties (NotCurrent/retired);
  -- 2003714 ("1 ML morphine sulfate 2 MG/ML Injection") is the real,
  -- current RxNorm concept for the same 2 mg injection.

-- 4) Live patient-facing data: medication_orders rows that were coded with
--    the wrong RxNorm code 2191 (really ceftazidime) for what is clearly,
--    by dose (875/125 mg PO BID — the standard amoxicillin-clavulanate
--    regimen), an amoxicillin-clavulanate order. Affects 5 rows, including
--    real-impact MRNs MRN-995147 and MRN-663203. Fix the code (and the
--    redundant ingredient_rxcui column) to the real, current RxNorm SCD
--    for the exact dose already on the order; rxnorm_display was already
--    correct text and is left as-is.
UPDATE medication_orders
  SET rxnorm_code = '562508',
      ingredient_rxcui = '562508',
      rxnorm_tty = 'SCD',
      updated_at = now()
  WHERE rxnorm_code = '2191';
