CREATE OR REPLACE FUNCTION public.auto_discharge_ghost_patients()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
    target RECORD;
    meds_text TEXT;
    labs_text TEXT;
    summary TEXT;
BEGIN
    IF (SELECT automation_enabled FROM system_settings WHERE id = 1) = false THEN RETURN; END IF;

    FOR target IN
        SELECT id, mrn, chief_complaint
        FROM (
            SELECT
                id, mrn, chief_complaint, facility_name, admission_time,
                row_number() OVER (PARTITION BY facility_name ORDER BY admission_time DESC) AS recency_rank
            FROM patients
            WHERE status = 'Admitted'
        ) ranked
        WHERE recency_rank > 5
        LIMIT 8
    LOOP
        SELECT string_agg(DISTINCT COALESCE(medication_name, drug_name), ', ')
          INTO meds_text
          FROM medication_orders
         WHERE patient_mrn = target.mrn
           AND status ILIKE 'Administered';

        SELECT string_agg(DISTINCT test_type, ', ')
          INTO labs_text
          FROM lab_orders
         WHERE patient_mrn = target.mrn;

        IF (meds_text IS NOT NULL AND length(meds_text) > 0)
            OR (labs_text IS NOT NULL AND length(labs_text) > 0) THEN
            summary := 'Patient admitted for ' || COALESCE(target.chief_complaint, 'evaluation')
                || '. Treated successfully with ' || COALESCE(meds_text, 'supportive care')
                || '. Labs processed: ' || COALESCE(labs_text, 'none')
                || '. Discharged in stable condition.';
        ELSE
            summary := 'Patient admitted for ' || COALESCE(target.chief_complaint, 'evaluation')
                || '. Standard clinical observation and care provided. '
                || 'No specific medication or laboratory data recorded for this encounter. '
                || 'Discharged in stable condition.';
        END IF;

        UPDATE patients
           SET status = 'Discharged',
               discharge_time = NOW(),
               discharge_summary = summary
         WHERE id = target.id;

        UPDATE public.bed_management
           SET status = 'Available',
               current_patient_mrn = NULL,
               status_updated_at = NOW()
         WHERE current_patient_mrn = target.mrn;
    END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_admit_ghost_patient()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
    i INT; selected_facility TEXT; room_label TEXT;
    new_mrn TEXT; new_first TEXT; new_last TEXT; new_complaint TEXT;
    new_age INT; new_gender TEXT; new_dob DATE;
    first_names TEXT[] := ARRAY['James','Mary','Robert','Patricia','John','Linda','Michael','Barbara','William','Elizabeth'];
    last_names TEXT[] := ARRAY['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez'];
    complaints TEXT[] := ARRAY[
      'Severe chest pain for the last two hours',
      'Shortness of breath since yesterday evening',
      'Sudden onset right-sided weakness',
      'Severe abdominal pain, started this morning',
      'Persistent fever and productive cough for 4 days',
      'Crushing substernal chest pressure radiating to left arm',
      'Worsening dyspnea on exertion over the past week',
      'Acute onset slurred speech and facial droop',
      'Sharp lower back pain after a fall this afternoon',
      'High-grade fever with chills and confusion since last night'
    ];
    facilities TEXT[] := ARRAY[
      'Memorial Hospital','St. Jude Medical Center','City General Infirmary',
      'County Health Pavilion','Srik Health Clinic'
    ];
BEGIN
    IF (SELECT automation_enabled FROM system_settings WHERE id = 1) = false THEN RETURN; END IF;

    UPDATE public.bed_management b
       SET status = 'Available',
           current_patient_mrn = NULL,
           status_updated_at = NOW()
     WHERE b.current_patient_mrn IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.patients p
          WHERE p.mrn = b.current_patient_mrn
            AND lower(p.status) = 'admitted'
       );

    FOR i IN 1..4 LOOP
        selected_facility := facilities[1 + floor(random() * array_length(facilities, 1))::int];
        new_mrn := 'MRN-' || floor(random() * 900000 + 100000)::text;
        new_first := first_names[1 + floor(random() * array_length(first_names, 1))::int];
        new_last := last_names[1 + floor(random() * array_length(last_names, 1))::int];
        new_complaint := complaints[1 + floor(random() * array_length(complaints, 1))::int];
        new_age := 18 + floor(random() * 72)::int;
        new_gender := CASE WHEN random() < 0.5 THEN 'male' ELSE 'female' END;
        new_dob := CURRENT_DATE - (new_age || ' years')::interval;
        room_label := NULL;

        UPDATE public.bed_management
           SET status = 'Occupied',
               current_patient_mrn = new_mrn,
               status_updated_at = NOW()
         WHERE id = (
             SELECT id FROM public.bed_management
              WHERE facility_name = selected_facility
                AND status = 'Available'
                AND current_patient_mrn IS NULL
              ORDER BY room_number, bed_letter
              LIMIT 1
              FOR UPDATE SKIP LOCKED
         )
         RETURNING room_number || '-' || bed_letter INTO room_label;

        IF room_label IS NULL THEN
            CONTINUE;
        END IF;

        INSERT INTO public.patients (
          mrn, first_name, last_name, name, age, gender, dob, biological_sex,
          gender_identity, status, facility_name, chief_complaint, admission_time, room
        )
        VALUES (
          new_mrn, new_first, new_last, new_first || ' ' || new_last, new_age,
          new_gender, new_dob, new_gender, new_gender, 'Admitted', selected_facility,
          new_complaint, NOW(), room_label
        )
        ON CONFLICT (mrn) DO NOTHING;
    END LOOP;
END;
$function$;