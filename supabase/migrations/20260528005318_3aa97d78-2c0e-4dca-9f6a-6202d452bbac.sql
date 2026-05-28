
CREATE OR REPLACE FUNCTION public.auto_order_ghost_labs()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    target_patient RECORD;
    cc TEXT;
    full_name TEXT;
    -- protocol holders
    m1_name TEXT; m1_dose TEXT; m1_route TEXT;
    m2_name TEXT; m2_dose TEXT; m2_route TEXT;
    m3_name TEXT; m3_dose TEXT; m3_route TEXT;
    l1_name TEXT; l1_result TEXT;
    l2_name TEXT; l2_result TEXT;
BEGIN
    -- Master automation switch
    IF (SELECT automation_enabled FROM system_settings WHERE id = 1) = false THEN
        RETURN;
    END IF;

    FOR target_patient IN
        SELECT id, mrn, first_name, last_name, facility_name, chief_complaint
        FROM patients
        WHERE status = 'Admitted'
    LOOP
        -- Skip patients already seeded
        IF target_patient.mrn IN (SELECT patient_mrn FROM lab_orders) THEN
            CONTINUE;
        END IF;

        cc := lower(coalesce(target_patient.chief_complaint, ''));
        full_name := trim(coalesce(target_patient.first_name, '') || ' ' || coalesce(target_patient.last_name, ''));

        -- Chief-complaint protocol selection (mirrors src/lib/complaint-protocols.ts)
        IF cc LIKE '%chest pain%' OR cc LIKE '%stemi%' OR cc LIKE '%nstemi%' OR cc LIKE '%acs%' OR cc = 'mi' THEN
            m1_name := 'Aspirin';            m1_dose := '325 mg';  m1_route := 'PO';
            m2_name := 'Nitroglycerin';      m2_dose := '0.4 mg';  m2_route := 'SL';
            m3_name := 'Morphine Sulfate';   m3_dose := '2 mg';    m3_route := 'IV';
            l1_name := 'Cardiac Troponin I';      l1_result := 'Troponin I: 0.18 ng/mL [HIGH] (ref <0.04 ng/mL)';
            l2_name := 'CK-MB';                   l2_result := 'CK-MB: 8.2 ng/mL [HIGH] (ref 0-6.3 ng/mL)';
        ELSIF cc LIKE '%shortness of breath%' OR cc LIKE '%sob%' OR cc LIKE '%dyspnea%' OR cc LIKE '%copd%' OR cc LIKE '%asthma%' OR cc LIKE '%respiratory%' THEN
            m1_name := 'Albuterol';            m1_dose := '2.5 mg';  m1_route := 'Nebulizer';
            m2_name := 'Methylprednisolone';   m2_dose := '125 mg';  m2_route := 'IV';
            m3_name := 'Furosemide';           m3_dose := '40 mg';   m3_route := 'IV';
            l1_name := 'Arterial Blood Gas (ABG)';  l1_result := 'ABG: pH 7.31, PaO2 68, PaCO2 52 [ABNORMAL] (ref pH 7.35-7.45)';
            l2_name := 'BNP';                       l2_result := 'BNP: 412 pg/mL [HIGH] (ref <100 pg/mL)';
        ELSIF cc LIKE '%stroke%' OR cc LIKE '%cva%' OR cc LIKE '%tia%' OR cc LIKE '%neuro%' THEN
            m1_name := 'Aspirin';        m1_dose := '325 mg';  m1_route := 'PO';
            m2_name := 'Atorvastatin';   m2_dose := '80 mg';   m2_route := 'PO';
            m3_name := 'Labetalol';      m3_dose := '10 mg';   m3_route := 'IV';
            l1_name := 'Glucose (Fingerstick)';  l1_result := 'Glucose: 142 mg/dL [HIGH] (ref 70-110 mg/dL)';
            l2_name := 'INR';                    l2_result := 'INR: 1.1 (ref 0.8-1.2)';
        ELSIF cc LIKE '%trauma%' OR cc LIKE '%fall%' OR cc LIKE '%mvc%' OR cc LIKE '%fracture%' THEN
            m1_name := 'Morphine Sulfate';  m1_dose := '4 mg';   m1_route := 'IV';
            m2_name := 'Ondansetron';       m2_dose := '4 mg';   m2_route := 'IV';
            m3_name := 'Ketorolac';         m3_dose := '15 mg';  m3_route := 'IV';
            l1_name := 'Hemoglobin / Hematocrit';  l1_result := 'Hgb 11.4 g/dL / Hct 34% [LOW] (ref 12.0-17.0 g/dL)';
            l2_name := 'INR';                      l2_result := 'INR: 1.0 (ref 0.8-1.2)';
        ELSIF cc LIKE '%sepsis%' OR cc LIKE '%septic%' OR cc LIKE '%infection%' OR cc LIKE '%bacteremia%' THEN
            m1_name := 'Piperacillin-Tazobactam';  m1_dose := '4.5 g';   m1_route := 'IV';
            m2_name := 'Vancomycin';               m2_dose := '1 g';     m2_route := 'IV';
            m3_name := 'Acetaminophen';            m3_dose := '650 mg';  m3_route := 'PO';
            l1_name := 'Lactic Acid';  l1_result := 'Lactate: 4.8 mmol/L [CRITICAL HIGH] (ref 0.5-2.2 mmol/L)';
            l2_name := 'WBC';          l2_result := 'WBC: 18.3 k/uL [HIGH] (ref 4.5-11.0 k/uL)';
        ELSIF cc LIKE '%abdominal%' OR cc LIKE '%abd pain%' OR cc LIKE '%appendicitis%' OR cc LIKE '%pancreatitis%' THEN
            m1_name := 'Ondansetron';       m1_dose := '4 mg';   m1_route := 'IV';
            m2_name := 'Pantoprazole';      m2_dose := '40 mg';  m2_route := 'IV';
            m3_name := 'Morphine Sulfate';  m3_dose := '2 mg';   m3_route := 'IV';
            l1_name := 'Lipase';  l1_result := 'Lipase: 260 U/L [HIGH] (ref 10-140 U/L)';
            l2_name := 'WBC';     l2_result := 'WBC: 13.6 k/uL [HIGH] (ref 4.5-11.0 k/uL)';
        ELSIF cc LIKE '%fever%' OR cc LIKE '%pyrexia%' THEN
            m1_name := 'Acetaminophen';  m1_dose := '650 mg';  m1_route := 'PO';
            m2_name := 'Ceftriaxone';    m2_dose := '1 g';     m2_route := 'IV';
            m3_name := 'Ibuprofen';      m3_dose := '600 mg';  m3_route := 'PO';
            l1_name := 'WBC';            l1_result := 'WBC: 12.8 k/uL [HIGH] (ref 4.5-11.0 k/uL)';
            l2_name := 'Blood Culture';  l2_result := 'Blood Culture: Pending - preliminary (ref Negative)';
        ELSIF cc LIKE '%dka%' OR cc LIKE '%hyperglycemia%' OR cc LIKE '%diabetic%' THEN
            m1_name := 'Regular Insulin';      m1_dose := '10 units';  m1_route := 'IV';
            m2_name := 'Normal Saline';        m2_dose := '1 L bolus'; m2_route := 'IV';
            m3_name := 'Potassium Chloride';   m3_dose := '20 mEq';    m3_route := 'IV';
            l1_name := 'Glucose';                       l1_result := 'Glucose: 452 mg/dL [CRITICAL HIGH] (ref 70-110 mg/dL)';
            l2_name := 'Basic Metabolic Panel (BMP)';   l2_result := 'BMP: Anion Gap 22 [HIGH] (ref 8-16)';
        ELSIF cc LIKE '%altered mental%' OR cc LIKE '%ams%' OR cc LIKE '%confusion%' OR cc LIKE '%syncope%' THEN
            m1_name := 'Thiamine';        m1_dose := '100 mg';  m1_route := 'IV';
            m2_name := 'Dextrose 50%';    m2_dose := '25 g';    m2_route := 'IV';
            m3_name := 'Ondansetron';     m3_dose := '4 mg';    m3_route := 'IV';
            l1_name := 'Glucose (Fingerstick)';  l1_result := 'Glucose: 62 mg/dL [LOW] (ref 70-110 mg/dL)';
            l2_name := 'Sodium';                 l2_result := 'Sodium: 131 mEq/L [LOW] (ref 135-145 mEq/L)';
        ELSE
            -- Default protocol
            m1_name := 'Acetaminophen';  m1_dose := '650 mg';  m1_route := 'PO';
            m2_name := 'Lisinopril';     m2_dose := '10 mg';   m2_route := 'PO';
            m3_name := 'Famotidine';     m3_dose := '20 mg';   m3_route := 'PO';
            l1_name := 'Complete Blood Count (CBC)';      l1_result := 'CBC: WBC 7.4, Hgb 13.6, Plt 244 (ref WBC 4.5-11.0)';
            l2_name := 'Basic Metabolic Panel (BMP)';     l2_result := 'BMP: Na 139, K 4.1, Cr 0.9 (ref Na 135-145)';
        END IF;

        -- Insert the 2 lab orders (auto-resulted)
        INSERT INTO lab_orders (patient_mrn, patient_name, facility_name, test_type, status, result_value, requested_by, ordered_by, collected_at)
        VALUES
          (target_patient.mrn, full_name, target_patient.facility_name, l1_name, 'Resulted', l1_result, 'Dr. Ghost', 'Ghost AI', NOW()),
          (target_patient.mrn, full_name, target_patient.facility_name, l2_name, 'Resulted', l2_result, 'Dr. Ghost', 'Ghost AI', NOW());

        -- Insert the 3 medication orders (auto-administered)
        INSERT INTO medication_orders (patient_id, patient_mrn, patient_name, facility_name, medication_name, drug_name, dose, route, status, ordered_by, administered_at)
        VALUES
          (target_patient.id, target_patient.mrn, full_name, target_patient.facility_name, m1_name, m1_name, m1_dose, m1_route, 'Administered', 'Ghost AI', NOW()),
          (target_patient.id, target_patient.mrn, full_name, target_patient.facility_name, m2_name, m2_name, m2_dose, m2_route, 'Administered', 'Ghost AI', NOW()),
          (target_patient.id, target_patient.mrn, full_name, target_patient.facility_name, m3_name, m3_name, m3_dose, m3_route, 'Administered', 'Ghost AI', NOW());

    END LOOP;
END;
$function$;
