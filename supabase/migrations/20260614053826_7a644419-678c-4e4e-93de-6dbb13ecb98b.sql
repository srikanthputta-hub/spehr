
-- Rename in-progress cleaning status to a clean two-word label and free
-- legacy "Discharged" rows that were never finalized.
UPDATE public.bed_management
   SET status = 'Cleaning'
 WHERE status IN ('Discharged - Deep Cleaning In Progress', 'Discharged');

-- Free any bed that holds an MRN no longer admitted, and clear any
-- "ED/Triage" room labels left over from the old fallback behaviour.
UPDATE public.bed_management b
   SET status = 'Available',
       current_patient_mrn = NULL,
       status_updated_at = NOW()
 WHERE b.current_patient_mrn IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.patients p
      WHERE p.mrn = b.current_patient_mrn
        AND p.status = 'Admitted'
   );

UPDATE public.patients SET room = NULL WHERE room = 'ED/Triage';

-- Ghost AI admission cron: only admit when a real Available bed exists in
-- the chosen facility, and atomically claim that bed in the same
-- transaction so the bed board never goes negative or duplicates an
-- assignment. If no bed is free in the picked facility, the iteration is
-- skipped — the cron will try again on the next tick.
CREATE OR REPLACE FUNCTION public.auto_admit_ghost_patient()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    i INT; selected_facility TEXT; room_label TEXT;
    new_mrn TEXT; new_first TEXT; new_last TEXT; new_complaint TEXT;
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

    FOR i IN 1..4 LOOP
        selected_facility := facilities[1 + floor(random() * array_length(facilities, 1))::int];
        new_mrn := 'MRN-' || floor(random() * 900000 + 100000)::text;
        new_first := first_names[1 + floor(random() * 10)::int];
        new_last := last_names[1 + floor(random() * 10)::int];
        new_complaint := complaints[1 + floor(random() * array_length(complaints, 1))::int];
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
            CONTINUE; -- facility full, skip this iteration
        END IF;

        INSERT INTO public.patients (mrn, first_name, last_name, status, facility_name, chief_complaint, admission_time, room)
        VALUES (new_mrn, new_first, new_last, 'Admitted', selected_facility, new_complaint, NOW(), room_label)
        ON CONFLICT (mrn) DO NOTHING;
    END LOOP;
END;
$function$;
