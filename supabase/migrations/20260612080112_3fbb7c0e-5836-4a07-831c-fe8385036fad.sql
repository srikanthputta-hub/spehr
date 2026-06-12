
CREATE TABLE public.medical_terminology (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code_system TEXT NOT NULL,
  code TEXT NOT NULL,
  display TEXT NOT NULL,
  category TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code_system, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.medical_terminology TO authenticated;
GRANT SELECT ON public.medical_terminology TO anon;
GRANT ALL ON public.medical_terminology TO service_role;

ALTER TABLE public.medical_terminology ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read terminology"
  ON public.medical_terminology FOR SELECT
  USING (true);

CREATE POLICY "Authenticated can insert terminology"
  ON public.medical_terminology FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated can update terminology"
  ON public.medical_terminology FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated can delete terminology"
  ON public.medical_terminology FOR DELETE TO authenticated
  USING (true);

CREATE INDEX idx_medical_terminology_system ON public.medical_terminology(code_system);

-- Seed with terminology used across the system
INSERT INTO public.medical_terminology (code_system, code, display, category, description) VALUES
-- ICD-10 — Chief complaints / diagnoses used by admission randomizer
('ICD-10', 'R07.9', 'Chest pain, unspecified', 'Symptoms', 'Used in chief-complaint workflow'),
('ICD-10', 'R06.02', 'Shortness of breath', 'Symptoms', 'Respiratory complaint'),
('ICD-10', 'I63.9', 'Cerebral infarction, unspecified (Stroke)', 'Diagnosis', 'Stroke Alert protocol'),
('ICD-10', 'S09.90XA', 'Unspecified injury of head, initial encounter (Trauma)', 'Diagnosis', 'Trauma protocol'),
('ICD-10', 'A41.9', 'Sepsis, unspecified organism', 'Diagnosis', 'Sepsis bundle'),
('ICD-10', 'N39.0', 'Urinary tract infection, site not specified', 'Diagnosis', 'UTI workflow'),
('ICD-10', 'J18.9', 'Pneumonia, unspecified organism', 'Diagnosis', 'Respiratory'),
('ICD-10', 'I10', 'Essential (primary) hypertension', 'Diagnosis', 'Hypertension'),
('ICD-10', 'E11.9', 'Type 2 diabetes mellitus without complications', 'Diagnosis', 'Endocrine'),

-- SNOMED CT — Clinical concepts
('SNOMED CT', '29857009', 'Chest pain (finding)', 'Finding', 'Chief complaint synonym'),
('SNOMED CT', '267036007', 'Dyspnea (finding)', 'Finding', 'Shortness of breath'),
('SNOMED CT', '230690007', 'Cerebrovascular accident', 'Disorder', 'Stroke'),
('SNOMED CT', '417163006', 'Traumatic injury', 'Disorder', 'Trauma'),
('SNOMED CT', '91302008', 'Sepsis (disorder)', 'Disorder', 'Sepsis'),
('SNOMED CT', '32485007', 'Hospital admission (procedure)', 'Procedure', 'Admission event'),
('SNOMED CT', '58000006', 'Patient discharge (procedure)', 'Procedure', 'Discharge event'),
('SNOMED CT', '18629005', 'Administration of medication (procedure)', 'Procedure', 'MAR action'),

-- LOINC — Labs in LAB_CATALOG
('LOINC', '6690-2', 'Leukocytes [#/volume] in Blood (WBC)', 'Hematology', 'Lab order'),
('LOINC', '718-7', 'Hemoglobin [Mass/volume] in Blood', 'Hematology', 'Lab order'),
('LOINC', '4544-3', 'Hematocrit [Volume Fraction] of Blood', 'Hematology', 'Lab order'),
('LOINC', '777-3', 'Platelets [#/volume] in Blood', 'Hematology', 'Lab order'),
('LOINC', '6301-6', 'INR in Platelet poor plasma', 'Coagulation', 'Lab order'),
('LOINC', '2951-2', 'Sodium [Moles/volume] in Serum/Plasma', 'Chemistry', 'BMP/CMP'),
('LOINC', '2823-3', 'Potassium [Moles/volume] in Serum/Plasma', 'Chemistry', 'BMP/CMP'),
('LOINC', '2075-0', 'Chloride [Moles/volume] in Serum/Plasma', 'Chemistry', 'BMP/CMP'),
('LOINC', '1963-8', 'Bicarbonate [Moles/volume] in Serum/Plasma', 'Chemistry', 'BMP/CMP'),
('LOINC', '3094-0', 'BUN [Mass/volume] in Serum/Plasma', 'Chemistry', 'BMP/CMP'),
('LOINC', '2160-0', 'Creatinine [Mass/volume] in Serum/Plasma', 'Chemistry', 'BMP/CMP'),
('LOINC', '2345-7', 'Glucose [Mass/volume] in Serum/Plasma', 'Chemistry', 'BMP/CMP'),
('LOINC', '10839-9', 'Troponin I.cardiac [Mass/volume] in Serum/Plasma', 'Cardiac Markers', 'ACS workup'),
('LOINC', '30934-4', 'Natriuretic peptide B [Mass/volume] in Serum/Plasma (BNP)', 'Cardiac Markers', 'CHF workup'),
('LOINC', '13969-1', 'Creatine kinase MB [Mass/volume]', 'Cardiac Markers', 'ACS workup'),
('LOINC', '5811-5', 'Specific gravity of Urine by Test strip', 'Urinalysis', 'UA'),
('LOINC', '5803-2', 'pH of Urine by Test strip', 'Urinalysis', 'UA'),
('LOINC', '5799-2', 'Leukocyte esterase [Presence] in Urine', 'Urinalysis', 'UA'),
('LOINC', '5802-4', 'Nitrite [Presence] in Urine', 'Urinalysis', 'UA'),

-- RxNorm — Medications in MEDICATION_CATALOG
('RxNorm', '203134', 'Piperacillin / Tazobactam 4.5 g Injection', 'Antibiotics', 'Med order'),
('RxNorm', '105370', 'Ceftriaxone 1 g Injection', 'Antibiotics', 'Med order'),
('RxNorm', '11124', 'Vancomycin 1 g Injection', 'Antibiotics', 'Med order'),
('RxNorm', '248656', 'Azithromycin 500 mg Oral Tablet', 'Antibiotics', 'Med order'),
('RxNorm', '314076', 'Lisinopril 10 mg Oral Tablet', 'Antihypertensives', 'Med order'),
('RxNorm', '197361', 'Amlodipine 5 mg Oral Tablet', 'Antihypertensives', 'Med order'),
('RxNorm', '866427', 'Metoprolol Tartrate 25 mg Oral Tablet', 'Antihypertensives', 'Med order'),
('RxNorm', '905395', 'Hydralazine 10 mg Injection', 'Antihypertensives', 'Med order'),
('RxNorm', '313782', 'Acetaminophen 650 mg Oral Tablet', 'Analgesics', 'Med order'),
('RxNorm', '197807', 'Ibuprofen 600 mg Oral Tablet', 'Analgesics', 'Med order'),
('RxNorm', '894994', 'Morphine Sulfate 2 mg Injection', 'Analgesics', 'Med order'),
('RxNorm', '849438', 'Ketorolac 15 mg Injection', 'Analgesics', 'Med order'),
('RxNorm', '854235', 'Enoxaparin 40 mg Subcutaneous', 'Anticoagulants', 'Med order'),
('RxNorm', '855288', 'Heparin 5000 units Subcutaneous', 'Anticoagulants', 'Med order'),
('RxNorm', '1364430', 'Apixaban 5 mg Oral Tablet', 'Anticoagulants', 'Med order'),
('RxNorm', '855332', 'Warfarin 5 mg Oral Tablet', 'Anticoagulants', 'Med order'),
('RxNorm', '702028', 'Pantoprazole 40 mg Injection', 'Gastrointestinal', 'Med order'),
('RxNorm', '198047', 'Ondansetron 4 mg Injection', 'Gastrointestinal', 'Med order'),
('RxNorm', '197435', 'Famotidine 20 mg Oral Tablet', 'Gastrointestinal', 'Med order'),
('RxNorm', '746169', 'Senna-Docusate 8.6/50 mg Oral Tablet', 'Gastrointestinal', 'Med order'),

-- VSAC Value Sets used in the application
('VSAC', '2.16.840.1.113883.3.666.5.307', 'Emergency Department Visit', 'Value Set', 'Encounter classification'),
('VSAC', '2.16.840.1.113883.3.666.5.1129', 'Sepsis (Diagnosis)', 'Value Set', 'Sepsis bundle'),
('VSAC', '2.16.840.1.113762.1.4.1029.207', 'Hospital Admission', 'Value Set', 'Admission event'),
('VSAC', '2.16.840.1.113883.3.117.1.7.1.292', 'Stroke', 'Value Set', 'Stroke Alert'),
('VSAC', '2.16.840.1.113883.3.464.1003.196.12.1213', 'Antibiotics for Sepsis', 'Value Set', 'Medication grouper');

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$
LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_medical_terminology_updated_at
  BEFORE UPDATE ON public.medical_terminology
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
