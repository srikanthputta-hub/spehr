
INSERT INTO public.conditions (
  mrn, display_text, snomed_code, snomed_display,
  icd10_code, icd10_display, coding_source, coded_at,
  verification_status, clinical_status, category
)
SELECT
  p.mrn,
  p.chief_complaint,
  CASE
    WHEN p.chief_complaint ILIKE '%chest%' OR p.chief_complaint ILIKE '%substernal%' THEN '394659003'
    WHEN p.chief_complaint ILIKE '%stroke%' OR p.chief_complaint ILIKE '%slurred speech%' OR p.chief_complaint ILIKE '%facial droop%' OR p.chief_complaint ILIKE '%weakness%' THEN '422504002'
    WHEN p.chief_complaint ILIKE '%cough%' OR p.chief_complaint ILIKE '%pneumonia%' THEN '385093006'
    WHEN p.chief_complaint ILIKE '%breath%' OR p.chief_complaint ILIKE '%dyspnea%' THEN '267036007'
    WHEN p.chief_complaint ILIKE '%abdominal%' OR p.chief_complaint ILIKE '%belly%' THEN '21522001'
    WHEN p.chief_complaint ILIKE '%back%' OR p.chief_complaint ILIKE '%fall%' THEN '161891005'
    WHEN p.chief_complaint ILIKE '%fever%' OR p.chief_complaint ILIKE '%chills%' THEN '386661006'
    WHEN p.chief_complaint ILIKE '%bleed%' OR p.chief_complaint ILIKE '%hemat%' THEN '37372002'
    ELSE '404684003'
  END,
  CASE
    WHEN p.chief_complaint ILIKE '%chest%' OR p.chief_complaint ILIKE '%substernal%' THEN 'Acute Coronary Syndrome'
    WHEN p.chief_complaint ILIKE '%stroke%' OR p.chief_complaint ILIKE '%slurred speech%' OR p.chief_complaint ILIKE '%facial droop%' OR p.chief_complaint ILIKE '%weakness%' THEN 'Acute Ischemic Stroke'
    WHEN p.chief_complaint ILIKE '%cough%' OR p.chief_complaint ILIKE '%pneumonia%' THEN 'Community-Acquired Pneumonia'
    WHEN p.chief_complaint ILIKE '%breath%' OR p.chief_complaint ILIKE '%dyspnea%' THEN 'Dyspnea'
    WHEN p.chief_complaint ILIKE '%abdominal%' OR p.chief_complaint ILIKE '%belly%' THEN 'Abdominal Pain'
    WHEN p.chief_complaint ILIKE '%back%' OR p.chief_complaint ILIKE '%fall%' THEN 'Low Back Pain'
    WHEN p.chief_complaint ILIKE '%fever%' OR p.chief_complaint ILIKE '%chills%' THEN 'Fever'
    WHEN p.chief_complaint ILIKE '%bleed%' THEN 'Upper GI Bleed'
    ELSE 'Clinical Finding'
  END,
  CASE
    WHEN p.chief_complaint ILIKE '%chest%' OR p.chief_complaint ILIKE '%substernal%' THEN 'I24.9'
    WHEN p.chief_complaint ILIKE '%stroke%' OR p.chief_complaint ILIKE '%slurred speech%' OR p.chief_complaint ILIKE '%facial droop%' OR p.chief_complaint ILIKE '%weakness%' THEN 'I63.9'
    WHEN p.chief_complaint ILIKE '%cough%' OR p.chief_complaint ILIKE '%pneumonia%' THEN 'J18.9'
    WHEN p.chief_complaint ILIKE '%breath%' OR p.chief_complaint ILIKE '%dyspnea%' THEN 'R06.00'
    WHEN p.chief_complaint ILIKE '%abdominal%' OR p.chief_complaint ILIKE '%belly%' THEN 'R10.9'
    WHEN p.chief_complaint ILIKE '%back%' OR p.chief_complaint ILIKE '%fall%' THEN 'M54.50'
    WHEN p.chief_complaint ILIKE '%fever%' OR p.chief_complaint ILIKE '%chills%' THEN 'R50.9'
    WHEN p.chief_complaint ILIKE '%bleed%' THEN 'K92.2'
    ELSE 'R69'
  END,
  CASE
    WHEN p.chief_complaint ILIKE '%chest%' THEN 'Acute Coronary Syndrome'
    WHEN p.chief_complaint ILIKE '%stroke%' OR p.chief_complaint ILIKE '%weakness%' THEN 'Acute Ischemic Stroke'
    WHEN p.chief_complaint ILIKE '%cough%' THEN 'Community-Acquired Pneumonia'
    WHEN p.chief_complaint ILIKE '%breath%' THEN 'Dyspnea, unspecified'
    WHEN p.chief_complaint ILIKE '%abdominal%' THEN 'Unspecified abdominal pain'
    WHEN p.chief_complaint ILIKE '%back%' THEN 'Low back pain, unspecified'
    WHEN p.chief_complaint ILIKE '%fever%' THEN 'Fever, unspecified'
    WHEN p.chief_complaint ILIKE '%bleed%' THEN 'Hematemesis'
    ELSE 'Illness, unspecified'
  END,
  'auto-api-backfill',
  now(),
  'provisional',
  'active',
  'encounter-diagnosis'
FROM public.patients p
WHERE p.chief_complaint IS NOT NULL
  AND p.mrn IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.conditions c
    WHERE c.mrn = p.mrn AND c.snomed_code IS NOT NULL
  );

UPDATE public.lab_orders SET
  loinc_code = CASE
    WHEN test_type ILIKE 'hemoglobin%' OR test_type ILIKE 'hgb%' THEN '718-7'
    WHEN test_type ILIKE 'wbc%' OR test_type ILIKE 'white blood%' THEN '6690-2'
    WHEN test_type ILIKE 'platelet%' THEN '777-3'
    WHEN test_type ILIKE 'glucose%' THEN '2345-7'
    WHEN test_type ILIKE 'creatinine%' THEN '2160-0'
    WHEN test_type ILIKE 'troponin t%' OR test_type ILIKE 'high sensitivity troponin t%' THEN '89579-7'
    WHEN test_type ILIKE 'troponin i%' THEN '10839-9'
    WHEN test_type ILIKE 'creatine kinase%' OR test_type = 'CK' THEN '2157-6'
    WHEN test_type ILIKE 'ecg%' THEN '11524-6'
    ELSE NULL
  END,
  loinc_display = CASE
    WHEN test_type ILIKE 'hemoglobin%' OR test_type ILIKE 'hgb%' THEN 'Hemoglobin [Mass/volume] in Blood'
    WHEN test_type ILIKE 'wbc%' OR test_type ILIKE 'white blood%' THEN 'Leukocytes [#/volume] in Blood'
    WHEN test_type ILIKE 'platelet%' THEN 'Platelets [#/volume] in Blood'
    WHEN test_type ILIKE 'glucose%' THEN 'Glucose [Mass/volume] in Serum or Plasma'
    WHEN test_type ILIKE 'creatinine%' THEN 'Creatinine [Mass/volume] in Serum or Plasma'
    WHEN test_type ILIKE 'troponin t%' OR test_type ILIKE 'high sensitivity troponin t%' THEN 'Troponin T cardiac panel'
    WHEN test_type ILIKE 'troponin i%' THEN 'Troponin I cardiac [Mass/volume] in Serum or Plasma'
    WHEN test_type ILIKE 'creatine kinase%' OR test_type = 'CK' THEN 'Creatine kinase [Enzymatic activity/volume]'
    WHEN test_type ILIKE 'ecg%' THEN 'EKG study'
    ELSE NULL
  END,
  coding_source = 'auto-api-backfill',
  coded_at = now()
WHERE loinc_code IS NULL AND test_type IS NOT NULL;

UPDATE public.medication_orders SET
  rxnorm_code = CASE
    WHEN medication_name ILIKE 'aspirin%' THEN '1191'
    WHEN medication_name ILIKE 'acetaminophen%codeine%' THEN '214199'
    WHEN medication_name ILIKE 'acetaminophen%' THEN '161'
    WHEN medication_name ILIKE 'ibuprofen%' THEN '5640'
    WHEN medication_name ILIKE 'morphine%' THEN '7052'
    WHEN medication_name ILIKE 'metoprolol%' THEN '6918'
    WHEN medication_name ILIKE 'lisinopril%' THEN '29046'
    WHEN medication_name ILIKE 'atorvastatin%' THEN '83367'
    WHEN medication_name ILIKE 'clopidogrel%' THEN '32968'
    WHEN medication_name ILIKE 'amoxicillin%' THEN '723'
    WHEN medication_name ILIKE 'azithromycin%' THEN '18631'
    WHEN medication_name ILIKE 'pantoprazole%' THEN '40790'
    WHEN medication_name ILIKE 'metformin%' THEN '6809'
    WHEN medication_name ILIKE 'heparin%' THEN '5224'
    WHEN medication_name ILIKE 'insulin%' THEN '5856'
    WHEN medication_name ILIKE 'furosemide%' THEN '4603'
    WHEN medication_name ILIKE 'ondansetron%' THEN '26225'
    WHEN medication_name ILIKE 'ceftriaxone%' THEN '2193'
    ELSE NULL
  END,
  rxnorm_display = CASE
    WHEN medication_name ILIKE 'aspirin%' THEN 'Aspirin'
    WHEN medication_name ILIKE 'acetaminophen%codeine%' THEN 'Acetaminophen / Codeine'
    WHEN medication_name ILIKE 'acetaminophen%' THEN 'Acetaminophen'
    WHEN medication_name ILIKE 'ibuprofen%' THEN 'Ibuprofen'
    WHEN medication_name ILIKE 'morphine%' THEN 'Morphine'
    WHEN medication_name ILIKE 'metoprolol%' THEN 'Metoprolol'
    WHEN medication_name ILIKE 'lisinopril%' THEN 'Lisinopril'
    WHEN medication_name ILIKE 'atorvastatin%' THEN 'Atorvastatin'
    WHEN medication_name ILIKE 'clopidogrel%' THEN 'Clopidogrel'
    WHEN medication_name ILIKE 'amoxicillin%' THEN 'Amoxicillin'
    WHEN medication_name ILIKE 'azithromycin%' THEN 'Azithromycin'
    WHEN medication_name ILIKE 'pantoprazole%' THEN 'Pantoprazole'
    WHEN medication_name ILIKE 'metformin%' THEN 'Metformin'
    WHEN medication_name ILIKE 'heparin%' THEN 'Heparin'
    WHEN medication_name ILIKE 'insulin%' THEN 'Insulin'
    WHEN medication_name ILIKE 'furosemide%' THEN 'Furosemide'
    WHEN medication_name ILIKE 'ondansetron%' THEN 'Ondansetron'
    WHEN medication_name ILIKE 'ceftriaxone%' THEN 'Ceftriaxone'
    ELSE NULL
  END,
  coding_source = 'auto-api-backfill',
  coded_at = now()
WHERE rxnorm_code IS NULL AND medication_name IS NOT NULL;
