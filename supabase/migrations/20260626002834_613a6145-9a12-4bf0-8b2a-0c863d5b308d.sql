
CREATE OR REPLACE FUNCTION public.auto_code_patient_complaint(_mrn text, _name text, _complaint text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c text := lower(coalesce(_complaint, ''));
  v_snomed text; v_snomed_d text;
  v_icd text;    v_icd_d text;
  v_cpt text;    v_cpt_d text;
  v_proc_disp text;
BEGIN
  IF _mrn IS NULL OR length(c) = 0 THEN RETURN; END IF;

  IF c ~ '(crushing|substernal|chest pressure|chest pain|angina|radiat.*arm|acs|myocardial)' THEN
    v_snomed := '29857009';  v_snomed_d := 'Chest pain';
    v_icd    := 'I20.9';     v_icd_d    := 'Angina pectoris, unspecified';
    v_cpt    := '93010';     v_cpt_d    := 'Electrocardiogram, routine ECG with interpretation';
    v_proc_disp := 'Electrocardiogram (12-lead)';
  ELSIF c ~ '(dyspnea|shortness of breath|sob|breathless|wheez)' THEN
    v_snomed := '267036007'; v_snomed_d := 'Dyspnea';
    v_icd    := 'R06.00';    v_icd_d    := 'Dyspnea, unspecified';
    v_cpt    := '71046';     v_cpt_d    := 'Radiologic exam, chest, 2 views';
    v_proc_disp := 'Chest X-ray, 2 views';
  ELSIF c ~ '(abdominal pain|abdomen pain|belly pain|stomach pain)' THEN
    v_snomed := '21522001';  v_snomed_d := 'Abdominal pain';
    v_icd    := 'R10.9';     v_icd_d    := 'Unspecified abdominal pain';
    v_cpt    := '74177';     v_cpt_d    := 'CT abdomen and pelvis with contrast';
    v_proc_disp := 'CT abdomen/pelvis with contrast';
  ELSIF c ~ '(back pain|lumbar|lower back)' THEN
    v_snomed := '161891005'; v_snomed_d := 'Backache';
    v_icd    := 'M54.50';    v_icd_d    := 'Low back pain, unspecified';
    v_cpt    := '72100';     v_cpt_d    := 'Radiologic exam, spine, lumbosacral; 2 or 3 views';
    v_proc_disp := 'Lumbar spine X-ray';
  ELSIF c ~ '(fever|febrile|pyrexia|sepsis|chills)' THEN
    v_snomed := '386661006'; v_snomed_d := 'Fever';
    v_icd    := 'R50.9';     v_icd_d    := 'Fever, unspecified';
    v_cpt    := '87040';     v_cpt_d    := 'Culture, bacterial; blood';
    v_proc_disp := 'Blood culture';
  ELSIF c ~ '(headache|migraine|cephalgia)' THEN
    v_snomed := '25064002';  v_snomed_d := 'Headache';
    v_icd    := 'R51.9';     v_icd_d    := 'Headache, unspecified';
    v_cpt    := '70450';     v_cpt_d    := 'CT head/brain without contrast';
    v_proc_disp := 'CT head without contrast';
  ELSIF c ~ '(stroke|cva|facial droop|slurred|hemiparesis|weakness)' THEN
    v_snomed := '422504002'; v_snomed_d := 'Ischemic stroke';
    v_icd    := 'I63.9';     v_icd_d    := 'Cerebral infarction, unspecified';
    v_cpt    := '70450';     v_cpt_d    := 'CT head/brain without contrast';
    v_proc_disp := 'CT head without contrast (stroke protocol)';
  ELSIF c ~ '(fall|trauma|laceration|injury|fracture|mvc|accident)' THEN
    v_snomed := '417163006'; v_snomed_d := 'Traumatic injury';
    v_icd    := 'T14.90XA';  v_icd_d    := 'Injury, unspecified, initial encounter';
    v_cpt    := '73630';     v_cpt_d    := 'Radiologic exam, foot; complete, min 3 views';
    v_proc_disp := 'Trauma series X-ray';
  ELSIF c ~ '(nausea|vomit|emesis)' THEN
    v_snomed := '422587007'; v_snomed_d := 'Nausea';
    v_icd    := 'R11.2';     v_icd_d    := 'Nausea with vomiting, unspecified';
    v_cpt    := '80053';     v_cpt_d    := 'Comprehensive metabolic panel';
    v_proc_disp := 'Comprehensive metabolic panel';
  ELSE
    v_snomed := '404684003'; v_snomed_d := 'Clinical finding';
    v_icd    := 'R69';       v_icd_d    := 'Illness, unspecified';
    v_cpt    := '99284';     v_cpt_d    := 'Emergency department visit, moderate complexity';
    v_proc_disp := 'Emergency department evaluation';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.conditions WHERE mrn = _mrn AND snomed_code = v_snomed) THEN
    INSERT INTO public.conditions (mrn, patient_name, display_text, category, clinical_status, verification_status,
      onset_date, snomed_code, snomed_display, icd10_code, icd10_display, coding_source, coded_at, created_by_type)
    VALUES (_mrn, _name, coalesce(_complaint, v_snomed_d), 'encounter-diagnosis', 'active', 'provisional',
      now(), v_snomed, v_snomed_d, v_icd, v_icd_d, 'AUTO_API', now(), 'auto');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.procedures WHERE mrn = _mrn AND cpt_code = v_cpt) THEN
    INSERT INTO public.procedures (mrn, patient_name, display_text, status, performed_at,
      cpt_code, cpt_display, coding_source, coded_at, created_by_type)
    VALUES (_mrn, _name, v_proc_disp, 'completed', now(),
      v_cpt, v_cpt_d, 'AUTO_API', now(), 'auto');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_patients_auto_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.auto_code_patient_complaint(NEW.mrn, NEW.name, NEW.chief_complaint);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patients_auto_code_ins ON public.patients;
CREATE TRIGGER trg_patients_auto_code_ins
AFTER INSERT ON public.patients
FOR EACH ROW EXECUTE FUNCTION public.trg_patients_auto_code();

DROP TRIGGER IF EXISTS trg_patients_auto_code_upd ON public.patients;
CREATE TRIGGER trg_patients_auto_code_upd
AFTER UPDATE OF chief_complaint ON public.patients
FOR EACH ROW
WHEN (NEW.chief_complaint IS DISTINCT FROM OLD.chief_complaint)
EXECUTE FUNCTION public.trg_patients_auto_code();

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT mrn, name, chief_complaint FROM public.patients LOOP
    PERFORM public.auto_code_patient_complaint(r.mrn, r.name, r.chief_complaint);
  END LOOP;
END $$;
