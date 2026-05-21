
-- 1. Migrate data FIRST (old constraint still allows Mercy values to remain, but new value must be allowed)
ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_facility_name_network_check;

UPDATE public.patients SET facility_name = 'Srik Health Clinic' WHERE facility_name = 'Mercy Childrens Hospital';
UPDATE public.lab_orders SET facility_name = 'Srik Health Clinic' WHERE facility_name = 'Mercy Childrens Hospital';
UPDATE public.medication_orders SET facility_name = 'Srik Health Clinic' WHERE facility_name = 'Mercy Childrens Hospital';
UPDATE public.patient_notes SET facility_name = 'Srik Health Clinic' WHERE facility_name = 'Mercy Childrens Hospital';
UPDATE public.hospital_staff SET facility_name = 'Srik Health Clinic' WHERE facility_name = 'Mercy Childrens Hospital';
UPDATE public.role_permissions SET facility_name = 'Srik Health Clinic' WHERE facility_name = 'Mercy Childrens Hospital';
UPDATE public.patient_transfers SET source_facility = 'Srik Health Clinic' WHERE source_facility = 'Mercy Childrens Hospital';
UPDATE public.patient_transfers SET destination_facility = 'Srik Health Clinic' WHERE destination_facility = 'Mercy Childrens Hospital';

-- 2. Re-add constraint with new facility list
ALTER TABLE public.patients ADD CONSTRAINT patients_facility_name_network_check
  CHECK (facility_name = ANY (ARRAY[
    'Memorial Hospital'::text,
    'St. Jude Medical Center'::text,
    'City General Infirmary'::text,
    'County Health Pavilion'::text,
    'Srik Health Clinic'::text
  ]));

-- 3. Update Ghost AI generator
CREATE OR REPLACE FUNCTION public.auto_admit_ghost_patient()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
    i INT; rand_facility INT; selected_facility TEXT;
    first_names TEXT[] := ARRAY['James', 'Mary', 'Robert', 'Patricia', 'John'];
    last_names TEXT[] := ARRAY['Smith', 'Johnson', 'Williams', 'Brown', 'Jones'];
    complaints TEXT[] := ARRAY['Chest Pain', 'Shortness of Breath', 'Stroke Alert', 'Trauma'];
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
        VALUES ('MRN-' || floor(random() * 900000 + 100000)::text, first_names[floor(random() * 5 + 1)], last_names[floor(random() * 5 + 1)], 'Admitted', selected_facility, complaints[floor(random() * 4 + 1)], NOW());
    END LOOP;
END;
$function$;
