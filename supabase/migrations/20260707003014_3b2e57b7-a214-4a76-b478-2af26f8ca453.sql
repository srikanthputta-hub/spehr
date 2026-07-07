CREATE OR REPLACE FUNCTION public.auto_discharge_ghost_patients()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    target RECORD;
    meds_text TEXT; labs_text TEXT; summary TEXT;
    batch_n INT;
BEGIN
    IF (SELECT automation_enabled FROM system_settings WHERE id = 1) = false THEN RETURN; END IF;

    -- Match admit cadence: 3 + 47% chance of 4 per 5-min tick -> ~1000/24h
    batch_n := 3 + (CASE WHEN random() < 0.47 THEN 1 ELSE 0 END);

    FOR target IN
        SELECT id, mrn, chief_complaint
          FROM patients
         WHERE status = 'Admitted'
         ORDER BY
           (target_discharge_at IS NOT NULL AND target_discharge_at <= now()) DESC,
           COALESCE(target_discharge_at, admission_time) ASC NULLS LAST
         LIMIT batch_n
    LOOP
        SELECT string_agg(DISTINCT COALESCE(medication_name, drug_name), ', ')
          INTO meds_text FROM medication_orders
         WHERE patient_mrn = target.mrn AND status ILIKE 'Administered';

        SELECT string_agg(DISTINCT test_type, ', ')
          INTO labs_text FROM lab_orders WHERE patient_mrn = target.mrn;

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
           SET status = 'Discharged', discharge_time = NOW(), discharge_summary = summary
         WHERE id = target.id;

        -- Kick the just-freed bed into the 3-phase turnover cycle (Cleaning →
        -- Disinfecting → Making Bed → Available), driven by the client-side
        -- sweepBedCleaningCycles() sweep. Setting status directly to
        -- 'Available' here would bypass the turnover entirely for
        -- ghost-discharged patients.
        UPDATE public.bed_management
           SET status = 'Cleaning',
               current_patient_mrn = NULL,
               status_updated_at = NOW()
         WHERE current_patient_mrn = target.mrn;
    END LOOP;
END;
$function$;