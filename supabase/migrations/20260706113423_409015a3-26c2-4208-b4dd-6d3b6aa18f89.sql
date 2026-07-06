
-- Phase 4: three published value sets for Auto Doc / Auto Admin

INSERT INTO public.custom_value_sets (name, system, vocabulary, type, codes, status, description, clinical_application, author, published_at, oid, fhir_url)
VALUES
(
  'Specialist Consult Triggers',
  'SNOMED-CT',
  'SNOMED CT',
  'extensional',
  '[
    {"code":"422504002","display":"Ischemic stroke","vocabulary":"SNOMED CT","recommended_specialty":"Neurology"},
    {"code":"57054005","display":"Acute myocardial infarction","vocabulary":"SNOMED CT","recommended_specialty":"Cardiology"},
    {"code":"84114007","display":"Heart failure","vocabulary":"SNOMED CT","recommended_specialty":"Cardiology"},
    {"code":"13645005","display":"Chronic obstructive pulmonary disease","vocabulary":"SNOMED CT","recommended_specialty":"Pulmonology"},
    {"code":"44054006","display":"Type 2 diabetes mellitus","vocabulary":"SNOMED CT","recommended_specialty":"Endocrinology"},
    {"code":"74474003","display":"Gastrointestinal hemorrhage","vocabulary":"SNOMED CT","recommended_specialty":"Gastroenterology"},
    {"code":"91302008","display":"Sepsis","vocabulary":"SNOMED CT","recommended_specialty":"Infectious Disease"}
  ]'::jsonb,
  'published',
  'Diagnoses that trigger a suggestion to consult a specialist. Codes resolved via UMLS/SNOMEDCT_US through the umls-proxy resolver (phase4-consolidation).',
  'CDS',
  'Clinical Terminologist (Phase 4)',
  now(),
  '2.16.840.1.113883.3.spehr.p4.consult',
  'http://spehr.live/fhir/ValueSet/specialist-consult-triggers'
),
(
  'Isolation Precaution Diagnoses',
  'SNOMED-CT',
  'SNOMED CT',
  'extensional',
  '[
    {"code":"266096002","display":"Methicillin resistant Staphylococcus aureus infection","vocabulary":"SNOMED CT","precaution_type":"Contact"},
    {"code":"186431008","display":"Clostridioides difficile infection","vocabulary":"SNOMED CT","precaution_type":"Contact"},
    {"code":"56717001","display":"Tuberculosis","vocabulary":"SNOMED CT","precaution_type":"Airborne"},
    {"code":"6142004","display":"Influenza","vocabulary":"SNOMED CT","precaution_type":"Droplet"},
    {"code":"840539006","display":"COVID-19","vocabulary":"SNOMED CT","precaution_type":"Droplet"}
  ]'::jsonb,
  'published',
  'Infectious diagnoses that require CDC transmission-based precautions. precaution_type follows standard CDC categories (Contact / Droplet / Airborne). Codes resolved via UMLS/SNOMEDCT_US.',
  'CDS',
  'Clinical Terminologist (Phase 4)',
  now(),
  '2.16.840.1.113883.3.spehr.p4.isolation',
  'http://spehr.live/fhir/ValueSet/isolation-precaution-diagnoses'
),
(
  'Inpatient-Only Procedures (Starter Set)',
  'SNOMED-CT',
  'SNOMED CT',
  'extensional',
  '[
    {"code":"609588000","display":"Total knee replacement","vocabulary":"SNOMED CT"},
    {"code":"52734007","display":"Total replacement of hip","vocabulary":"SNOMED CT"},
    {"code":"232717009","display":"Coronary artery bypass graft","vocabulary":"SNOMED CT"},
    {"code":"2598006","display":"Open heart surgery","vocabulary":"SNOMED CT"}
  ]'::jsonb,
  'published',
  'REPRESENTATIVE STARTER SET — NOT the full CMS Inpatient-Only list (which contains thousands of CPT/HCPCS entries updated annually). This value set illustrates the concept with 4 canonical inpatient-only procedures; the full CMS list is a separate governance workstream.',
  'CDS',
  'Clinical Terminologist (Phase 4)',
  now(),
  '2.16.840.1.113883.3.spehr.p4.inpatient',
  'http://spehr.live/fhir/ValueSet/inpatient-only-procedures-starter'
)
ON CONFLICT DO NOTHING;

INSERT INTO public.value_set_dependencies (consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required)
SELECT 'Auto Doc — Specialist Consult', 'src/routes/patient.$mrn.tsx', 'consult-suggestion banner', 'by_name', v.id, v.name, true
FROM public.custom_value_sets v WHERE v.name = 'Specialist Consult Triggers' AND v.status = 'published'
ON CONFLICT DO NOTHING;

INSERT INTO public.value_set_dependencies (consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required)
SELECT 'Auto Admin — Isolation/Status Flags', 'src/routes/patient.$mrn.tsx', 'isolation-precaution badge', 'by_name', v.id, v.name, true
FROM public.custom_value_sets v WHERE v.name = 'Isolation Precaution Diagnoses' AND v.status = 'published'
ON CONFLICT DO NOTHING;

INSERT INTO public.value_set_dependencies (consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required)
SELECT 'Auto Admin — Isolation/Status Flags', 'src/routes/patient.$mrn.tsx', 'inpatient-only status suggestion', 'by_name', v.id, v.name, true
FROM public.custom_value_sets v WHERE v.name = 'Inpatient-Only Procedures (Starter Set)' AND v.status = 'published'
ON CONFLICT DO NOTHING;

INSERT INTO public.value_set_dependencies (consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required)
SELECT 'Auto IT — Discharge Dual-Coding', 'src/lib/fhir-bundle.ts', 'best-effort dual-coding via umls-proxy crosswalk on outbound FHIR', 'by_clinical_application', NULL, '(dynamic: crosswalk enrichment, no fixed value set)', false
WHERE NOT EXISTS (
  SELECT 1 FROM public.value_set_dependencies
  WHERE consumer = 'Auto IT — Discharge Dual-Coding'
);
