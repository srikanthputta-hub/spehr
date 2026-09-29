-- Root-cause fix for the Risk Adjustment Coverage Gaps panel
-- (src/routes/finance-board.tsx, RiskAdjustmentGaps): zero published
-- clinical_application='Billing' value sets meant matchBillingValueSets()
-- could never produce an ICD-10 risk-adjustment charge line for ANY
-- patient, so the panel's "no gap" resolution path was structurally
-- unreachable and every chronic-diagnosis patient would be flagged
-- forever, regardless of actual coverage.
--
-- Seeds one published Billing value set mapping the same chronic
-- conditions the panel's CHRONIC_RE regex already checks for
-- (diabetes / heart failure / COPD / chronic kidney disease / dialysis)
-- to their standard ICD-10-CM codes, so matchBillingValueSets() has a
-- real value set to match a discharged patient's ICD-10 codes against.

INSERT INTO public.custom_value_sets
  (name, system, vocabulary, type, codes, status, description, clinical_application, author, published_at, oid, fhir_url)
VALUES
(
  'Chronic Condition Risk-Adjustment Diagnoses',
  'ICD-10',
  'ICD-10-CM',
  'extensional',
  '[
    {"code":"E11.9","display":"Type 2 diabetes mellitus without complications","vocabulary":"ICD-10-CM"},
    {"code":"E11.22","display":"Type 2 diabetes mellitus with diabetic chronic kidney disease","vocabulary":"ICD-10-CM"},
    {"code":"I50.9","display":"Heart failure, unspecified","vocabulary":"ICD-10-CM"},
    {"code":"I50.22","display":"Chronic systolic (congestive) heart failure","vocabulary":"ICD-10-CM"},
    {"code":"I50.32","display":"Chronic diastolic (congestive) heart failure","vocabulary":"ICD-10-CM"},
    {"code":"J44.9","display":"Chronic obstructive pulmonary disease, unspecified","vocabulary":"ICD-10-CM"},
    {"code":"J44.1","display":"Chronic obstructive pulmonary disease with (acute) exacerbation","vocabulary":"ICD-10-CM"},
    {"code":"N18.9","display":"Chronic kidney disease, unspecified","vocabulary":"ICD-10-CM"},
    {"code":"N18.6","display":"End stage renal disease","vocabulary":"ICD-10-CM"},
    {"code":"Z99.2","display":"Dependence on renal dialysis","vocabulary":"ICD-10-CM"}
  ]'::jsonb,
  'published',
  'Standard ICD-10-CM codes for the chronic diagnoses (diabetes, heart failure, COPD, chronic kidney disease, dialysis dependence) that finance-board''s Risk Adjustment Coverage Gaps panel flags. Enables matchBillingValueSets()/composeCharges() to generate a real ICD-10 risk-adjustment charge line for these patients, so the coverage-gap check has an achievable "no gap" outcome instead of being structurally guaranteed to always flag every chronic-diagnosis patient.',
  'Billing',
  'Clinical Terminologist (Coverage Gap Fix)',
  now(),
  '2.16.840.1.113883.3.spehr.billing.chronic-risk-adj',
  'http://spehr.live/fhir/ValueSet/chronic-condition-risk-adjustment-diagnoses'
)
ON CONFLICT DO NOTHING;

INSERT INTO public.value_set_dependencies (consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required)
SELECT 'Auto Admin — Invoice Risk-Adjustment Coding', 'src/lib/auto-doc.server.ts', 'ICD-10 risk-adjustment charge line matching (matchBillingValueSets) + finance-board Risk Adjustment Coverage Gaps panel', 'by_clinical_application', v.id, v.name, true
FROM public.custom_value_sets v WHERE v.name = 'Chronic Condition Risk-Adjustment Diagnoses' AND v.status = 'published'
ON CONFLICT DO NOTHING;
