CREATE OR REPLACE FUNCTION public.auto_admit_ghost_patient()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path = public
AS $function$
DECLARE
    i INT; rand_facility INT; selected_facility TEXT;
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
BEGIN
    IF (SELECT automation_enabled FROM system_settings WHERE id = 1) = false THEN RETURN; END IF;

    FOR i IN 1..4 LOOP
        rand_facility := floor(random() * 100) + 1;
        IF rand_facility <= 30 THEN selected_facility := 'Memorial Hospital';
        ELSIF rand_facility <= 55 THEN selected_facility := 'St. Jude Medical Center';
        ELSIF rand_facility <= 75 THEN selected_facility := 'City General Infirmary';
        ELSIF rand_facility <= 90 THEN selected_facility := 'County Health Pavilion';
        ELSE selected_facility := 'Srik Health Clinic'; END IF;

        INSERT INTO patients (mrn, first_name, last_name, status, facility_name, chief_complaint, admission_time)
        VALUES (
          'MRN-' || floor(random() * 900000 + 100000)::text,
          first_names[floor(random() * 10 + 1)],
          last_names[floor(random() * 10 + 1)],
          'Admitted',
          selected_facility,
          complaints[floor(random() * array_length(complaints, 1) + 1)],
          NOW()
        );
    END LOOP;
END;
$function$;