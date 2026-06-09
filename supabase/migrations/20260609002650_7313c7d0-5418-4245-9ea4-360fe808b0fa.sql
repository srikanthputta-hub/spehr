CREATE OR REPLACE FUNCTION public.seed_orders_for_admitted_patient()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  complaint text := lower(coalesce(NEW.chief_complaint, NEW.diagnosis, ''));
  patient_display text := coalesce(
    nullif(trim(coalesce(NEW.name, '')), ''),
    nullif(trim(coalesce(NEW.first_name, '') || ' ' || coalesce(NEW.last_name, '')), ''),
    'Unknown'
  );
BEGIN
  IF NEW.status IS DISTINCT FROM 'Admitted' OR NEW.mrn IS NULL THEN
    RETURN NEW;
  END IF;

  WITH med_protocol(medication_name, dose, route_name, ord) AS (
    VALUES
      (
        CASE
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%stemi%' OR complaint LIKE '%nstemi%' OR complaint LIKE '%acs%' THEN 'Aspirin'
          WHEN complaint LIKE '%shortness of breath%' OR complaint LIKE '%sob%' OR complaint LIKE '%dyspnea%' THEN 'Albuterol'
          WHEN complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' THEN 'Aspirin'
          WHEN complaint LIKE '%trauma%' OR complaint LIKE '%fall%' OR complaint LIKE '%mvc%' OR complaint LIKE '%fracture%' THEN 'Morphine Sulfate'
          WHEN complaint LIKE '%sepsis%' OR complaint LIKE '%septic%' OR complaint LIKE '%infection%' THEN 'Piperacillin-Tazobactam'
          WHEN complaint LIKE '%abdominal%' OR complaint LIKE '%abd pain%' OR complaint LIKE '%appendicitis%' OR complaint LIKE '%pancreatitis%' THEN 'Ondansetron'
          WHEN complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' THEN 'Acetaminophen'
          WHEN complaint LIKE '%dka%' OR complaint LIKE '%hyperglycemia%' OR complaint LIKE '%diabetic%' THEN 'Regular Insulin'
          WHEN complaint LIKE '%altered mental%' OR complaint LIKE '%ams%' OR complaint LIKE '%confusion%' OR complaint LIKE '%syncope%' THEN 'Thiamine'
          ELSE 'Acetaminophen'
        END,
        CASE
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' THEN '325 mg'
          WHEN complaint LIKE '%shortness of breath%' OR complaint LIKE '%sob%' OR complaint LIKE '%dyspnea%' THEN '2.5 mg'
          WHEN complaint LIKE '%trauma%' OR complaint LIKE '%fall%' OR complaint LIKE '%mvc%' OR complaint LIKE '%fracture%' THEN '4 mg'
          WHEN complaint LIKE '%sepsis%' OR complaint LIKE '%septic%' OR complaint LIKE '%infection%' THEN '4.5 g'
          WHEN complaint LIKE '%abdominal%' OR complaint LIKE '%abd pain%' OR complaint LIKE '%appendicitis%' OR complaint LIKE '%pancreatitis%' THEN '4 mg'
          WHEN complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' THEN '650 mg'
          WHEN complaint LIKE '%dka%' OR complaint LIKE '%hyperglycemia%' OR complaint LIKE '%diabetic%' THEN '10 units'
          WHEN complaint LIKE '%altered mental%' OR complaint LIKE '%ams%' OR complaint LIKE '%confusion%' OR complaint LIKE '%syncope%' THEN '100 mg'
          ELSE '650 mg'
        END,
        CASE
          WHEN complaint LIKE '%shortness of breath%' OR complaint LIKE '%sob%' OR complaint LIKE '%dyspnea%' THEN 'Nebulizer'
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' OR complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' THEN 'PO'
          ELSE 'IV'
        END,
        1
      ),
      (
        CASE
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%stemi%' OR complaint LIKE '%nstemi%' OR complaint LIKE '%acs%' THEN 'Nitroglycerin'
          WHEN complaint LIKE '%shortness of breath%' OR complaint LIKE '%sob%' OR complaint LIKE '%dyspnea%' THEN 'Methylprednisolone'
          WHEN complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' THEN 'Atorvastatin'
          WHEN complaint LIKE '%trauma%' OR complaint LIKE '%fall%' OR complaint LIKE '%mvc%' OR complaint LIKE '%fracture%' THEN 'Ondansetron'
          WHEN complaint LIKE '%sepsis%' OR complaint LIKE '%septic%' OR complaint LIKE '%infection%' THEN 'Vancomycin'
          WHEN complaint LIKE '%abdominal%' OR complaint LIKE '%abd pain%' OR complaint LIKE '%appendicitis%' OR complaint LIKE '%pancreatitis%' THEN 'Pantoprazole'
          WHEN complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' THEN 'Ceftriaxone'
          WHEN complaint LIKE '%dka%' OR complaint LIKE '%hyperglycemia%' OR complaint LIKE '%diabetic%' THEN 'Normal Saline'
          WHEN complaint LIKE '%altered mental%' OR complaint LIKE '%ams%' OR complaint LIKE '%confusion%' OR complaint LIKE '%syncope%' THEN 'Dextrose 50%'
          ELSE 'Lisinopril'
        END,
        CASE
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%stemi%' OR complaint LIKE '%nstemi%' OR complaint LIKE '%acs%' THEN '0.4 mg'
          WHEN complaint LIKE '%shortness of breath%' OR complaint LIKE '%sob%' OR complaint LIKE '%dyspnea%' THEN '125 mg'
          WHEN complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' THEN '80 mg'
          WHEN complaint LIKE '%trauma%' OR complaint LIKE '%fall%' OR complaint LIKE '%mvc%' OR complaint LIKE '%fracture%' THEN '4 mg'
          WHEN complaint LIKE '%sepsis%' OR complaint LIKE '%septic%' OR complaint LIKE '%infection%' THEN '1 g'
          WHEN complaint LIKE '%abdominal%' OR complaint LIKE '%abd pain%' OR complaint LIKE '%appendicitis%' OR complaint LIKE '%pancreatitis%' THEN '40 mg'
          WHEN complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' THEN '1 g'
          WHEN complaint LIKE '%dka%' OR complaint LIKE '%hyperglycemia%' OR complaint LIKE '%diabetic%' THEN '1 L bolus'
          WHEN complaint LIKE '%altered mental%' OR complaint LIKE '%ams%' OR complaint LIKE '%confusion%' OR complaint LIKE '%syncope%' THEN '25 g'
          ELSE '10 mg'
        END,
        CASE
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%stemi%' OR complaint LIKE '%nstemi%' OR complaint LIKE '%acs%' THEN 'SL'
          WHEN complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' OR complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' OR complaint = '' THEN 'PO'
          ELSE 'IV'
        END,
        2
      ),
      (
        CASE
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%stemi%' OR complaint LIKE '%nstemi%' OR complaint LIKE '%acs%' THEN 'Morphine Sulfate'
          WHEN complaint LIKE '%shortness of breath%' OR complaint LIKE '%sob%' OR complaint LIKE '%dyspnea%' THEN 'Furosemide'
          WHEN complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' THEN 'Labetalol'
          WHEN complaint LIKE '%trauma%' OR complaint LIKE '%fall%' OR complaint LIKE '%mvc%' OR complaint LIKE '%fracture%' THEN 'Ketorolac'
          WHEN complaint LIKE '%sepsis%' OR complaint LIKE '%septic%' OR complaint LIKE '%infection%' THEN 'Acetaminophen'
          WHEN complaint LIKE '%abdominal%' OR complaint LIKE '%abd pain%' OR complaint LIKE '%appendicitis%' OR complaint LIKE '%pancreatitis%' THEN 'Morphine Sulfate'
          WHEN complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' THEN 'Ibuprofen'
          WHEN complaint LIKE '%dka%' OR complaint LIKE '%hyperglycemia%' OR complaint LIKE '%diabetic%' THEN 'Potassium Chloride'
          WHEN complaint LIKE '%altered mental%' OR complaint LIKE '%ams%' OR complaint LIKE '%confusion%' OR complaint LIKE '%syncope%' THEN 'Ondansetron'
          ELSE 'Famotidine'
        END,
        CASE
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%abdominal%' OR complaint LIKE '%abd pain%' OR complaint LIKE '%appendicitis%' OR complaint LIKE '%pancreatitis%' THEN '2 mg'
          WHEN complaint LIKE '%shortness of breath%' OR complaint LIKE '%sob%' OR complaint LIKE '%dyspnea%' THEN '40 mg'
          WHEN complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' THEN '10 mg'
          WHEN complaint LIKE '%trauma%' OR complaint LIKE '%fall%' OR complaint LIKE '%mvc%' OR complaint LIKE '%fracture%' THEN '15 mg'
          WHEN complaint LIKE '%sepsis%' OR complaint LIKE '%septic%' OR complaint LIKE '%infection%' THEN '650 mg'
          WHEN complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' THEN '600 mg'
          WHEN complaint LIKE '%dka%' OR complaint LIKE '%hyperglycemia%' OR complaint LIKE '%diabetic%' THEN '20 mEq'
          WHEN complaint LIKE '%altered mental%' OR complaint LIKE '%ams%' OR complaint LIKE '%confusion%' OR complaint LIKE '%syncope%' THEN '4 mg'
          ELSE '20 mg'
        END,
        CASE
          WHEN complaint LIKE '%sepsis%' OR complaint LIKE '%septic%' OR complaint LIKE '%infection%' OR complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' OR complaint = '' THEN 'PO'
          ELSE 'IV'
        END,
        3
      )
  )
  INSERT INTO public.medication_orders (
    patient_id, patient_mrn, mrn, patient_name, facility_name,
    medication_name, drug_name, dose, route, frequency, status, ordered_by
  )
  SELECT
    NEW.id, NEW.mrn, NEW.mrn, patient_display, NEW.facility_name,
    mp.medication_name, mp.medication_name, mp.dose, mp.route_name, 'Once',
    'Ordered', 'Ghost AI - Admission Workflow'
  FROM med_protocol mp
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.medication_orders mo
    WHERE mo.patient_mrn = NEW.mrn
      AND lower(coalesce(mo.medication_name, mo.drug_name, '')) = lower(mp.medication_name)
  )
  ON CONFLICT DO NOTHING;

  WITH lab_protocol(test_type, result_summary, ord) AS (
    VALUES
      (
        CASE
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%stemi%' OR complaint LIKE '%nstemi%' OR complaint LIKE '%acs%' THEN 'Cardiac Troponin I'
          WHEN complaint LIKE '%shortness of breath%' OR complaint LIKE '%sob%' OR complaint LIKE '%dyspnea%' THEN 'Arterial Blood Gas (ABG)'
          WHEN complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' THEN 'Glucose (Fingerstick)'
          WHEN complaint LIKE '%trauma%' OR complaint LIKE '%fall%' OR complaint LIKE '%mvc%' OR complaint LIKE '%fracture%' THEN 'Hemoglobin / Hematocrit'
          WHEN complaint LIKE '%sepsis%' OR complaint LIKE '%septic%' OR complaint LIKE '%infection%' THEN 'Lactic Acid'
          WHEN complaint LIKE '%abdominal%' OR complaint LIKE '%abd pain%' OR complaint LIKE '%appendicitis%' OR complaint LIKE '%pancreatitis%' THEN 'Lipase'
          WHEN complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' THEN 'WBC'
          WHEN complaint LIKE '%dka%' OR complaint LIKE '%hyperglycemia%' OR complaint LIKE '%diabetic%' THEN 'Glucose'
          WHEN complaint LIKE '%altered mental%' OR complaint LIKE '%ams%' OR complaint LIKE '%confusion%' OR complaint LIKE '%syncope%' THEN 'Glucose (Fingerstick)'
          ELSE 'Complete Blood Count (CBC)'
        END,
        NULL,
        1
      ),
      (
        CASE
          WHEN complaint LIKE '%chest pain%' OR complaint LIKE '%stemi%' OR complaint LIKE '%nstemi%' OR complaint LIKE '%acs%' THEN 'CK-MB'
          WHEN complaint LIKE '%shortness of breath%' OR complaint LIKE '%sob%' OR complaint LIKE '%dyspnea%' THEN 'BNP'
          WHEN complaint LIKE '%stroke%' OR complaint LIKE '%cva%' OR complaint LIKE '%tia%' THEN 'INR'
          WHEN complaint LIKE '%trauma%' OR complaint LIKE '%fall%' OR complaint LIKE '%mvc%' OR complaint LIKE '%fracture%' THEN 'INR'
          WHEN complaint LIKE '%sepsis%' OR complaint LIKE '%septic%' OR complaint LIKE '%infection%' THEN 'WBC'
          WHEN complaint LIKE '%abdominal%' OR complaint LIKE '%abd pain%' OR complaint LIKE '%appendicitis%' OR complaint LIKE '%pancreatitis%' THEN 'WBC'
          WHEN complaint LIKE '%fever%' OR complaint LIKE '%pyrexia%' THEN 'Blood Culture'
          WHEN complaint LIKE '%dka%' OR complaint LIKE '%hyperglycemia%' OR complaint LIKE '%diabetic%' THEN 'Basic Metabolic Panel (BMP)'
          WHEN complaint LIKE '%altered mental%' OR complaint LIKE '%ams%' OR complaint LIKE '%confusion%' OR complaint LIKE '%syncope%' THEN 'Sodium'
          ELSE 'Basic Metabolic Panel (BMP)'
        END,
        NULL,
        2
      )
  )
  INSERT INTO public.lab_orders (
    patient_mrn, patient_name, facility_name, requested_by, test_type, status, ordered_by
  )
  SELECT
    NEW.mrn, patient_display, NEW.facility_name,
    'Ghost AI - Admission Workflow', lp.test_type, 'Ordered', 'Ghost AI - Admission Workflow'
  FROM lab_protocol lp
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.lab_orders lo
    WHERE lo.patient_mrn = NEW.mrn
      AND lower(lo.test_type) = lower(lp.test_type)
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_orders_for_admitted_patient ON public.patients;
CREATE TRIGGER trg_seed_orders_for_admitted_patient
AFTER INSERT OR UPDATE OF status ON public.patients
FOR EACH ROW
WHEN (NEW.status = 'Admitted')
EXECUTE FUNCTION public.seed_orders_for_admitted_patient();

UPDATE public.patients
SET status = status
WHERE status = 'Admitted';