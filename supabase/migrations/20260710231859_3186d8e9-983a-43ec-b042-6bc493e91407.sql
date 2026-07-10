
CREATE OR REPLACE FUNCTION public.admit_patient_from_appointment(p_appointment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    appt RECORD;
    selected_facility TEXT;
    room_label TEXT;
    new_mrn TEXT; new_first TEXT; new_last TEXT; new_complaint TEXT;
    new_age INT; new_gender TEXT; new_dob DATE;
    parts TEXT[];
    hpi_loc TEXT; hpi_char TEXT; hpi_dur TEXT;
    picked_chronic TEXT[]; picked_meds TEXT;
    cc_lower TEXT;
    em_first TEXT; drug_allergy_txt TEXT; env_allergy_txt TEXT;
    env_idx1 INT; env_idx2 INT;
    ordering_doc TEXT;
    inserted_mrn TEXT;
    active_census INT;
    census_cap CONSTANT INT := 85;
    fam_pool TEXT[] := ARRAY['Hypertension','Diabetes','Heart Attack','Stroke','Cancer','Hereditary Disorder','Mental Illness'];
    env_pool TEXT[] := ARRAY['Latex','Iodine','Contrast Dye','Peanuts','Tree Nuts','Shellfish','Pollen','Bee Sting'];
    drug_allergies_pool TEXT[] := ARRAY['Penicillin','Sulfa','Codeine','Morphine','Cefazolin'];
    reactions_pool TEXT[] := ARRAY['Hives','Rash','Anaphylaxis','Nausea','Swelling'];
    streets TEXT[] := ARRAY['Oak St','Maple Ave','Cedar Ln','Pine Rd','Elm Ct','Birch Way','Sunset Blvd','Lakeview Dr'];
    cities TEXT[] := ARRAY['Springfield','Riverton','Lakewood','Fairview','Madison','Georgetown','Salem','Bristol'];
    occupations TEXT[] := ARRAY['Teacher','Construction Worker','Software Engineer','Retired','Nurse','Driver','Accountant','Chef','Electrician','Sales Manager','Farmer','Mechanic'];
    insurers TEXT[] := ARRAY['Blue Cross Blue Shield','Aetna','UnitedHealthcare','Cigna','Humana','Kaiser Permanente','Medicare','Medicaid'];
    pcps TEXT[] := ARRAY['Dr. Alan Reyes, MD','Dr. Priya Shah, DO','Dr. Marcus Lee, MD','Dr. Elena Park, MD','Dr. James O''Connor, MD'];
    relationships TEXT[] := ARRAY['Spouse','Child','Parent','Sibling'];
    surgeries_pool TEXT[] := ARRAY['Appendectomy 2008 — no complications','Cholecystectomy 2015 — uneventful recovery','None reported'];
    hosp_pool TEXT[] := ARRAY['Admitted 2022 for pneumonia — 4 day stay','No prior admissions'];
    family_notes_pool TEXT[] := ARRAY['Father deceased age 68 — MI. Mother alive, HTN.','Non-contributory.'];
    aggravating_pool TEXT[] := ARRAY['Exertion','Movement','Deep breathing','Eating','Lying flat'];
    alleviating_pool TEXT[] := ARRAY['Rest','Nitroglycerin','Antacids','Sitting upright','NSAIDs'];
    first_names TEXT[] := ARRAY['James','Mary','Robert','Patricia','John','Linda','Michael','Barbara','William','Elizabeth'];
BEGIN
    SELECT * INTO appt FROM public.fhir_appointments WHERE id = p_appointment_id;
    IF NOT FOUND THEN RETURN; END IF;
    IF appt.patient_mrn IS NULL OR btrim(appt.patient_mrn) = '' THEN RETURN; END IF;
    IF appt.status <> 'booked' THEN RETURN; END IF;

    -- Skip if this MRN is already admitted anywhere
    IF EXISTS (SELECT 1 FROM public.patients WHERE mrn = appt.patient_mrn AND lower(status) = 'admitted') THEN
        UPDATE public.fhir_appointments SET status = 'fulfilled' WHERE id = p_appointment_id;
        RETURN;
    END IF;

    selected_facility := appt.facility_name;
    IF selected_facility IS NULL OR selected_facility = 'MySPEHR Portal' THEN RETURN; END IF;

    -- Census headroom
    SELECT COUNT(*) INTO active_census FROM public.patients WHERE lower(status) = 'admitted';
    IF active_census >= census_cap THEN RETURN; END IF;

    new_mrn := appt.patient_mrn;

    -- Parse name: real "First Last" if present, otherwise MySPEHR fallback
    IF appt.patient_name IS NOT NULL
       AND btrim(appt.patient_name) <> ''
       AND appt.patient_name <> appt.patient_mrn
       AND position(' ' IN btrim(appt.patient_name)) > 0 THEN
        parts := regexp_split_to_array(btrim(appt.patient_name), '\s+');
        new_first := parts[1];
        new_last := array_to_string(parts[2:array_length(parts,1)], ' ');
    ELSE
        new_first := 'MySPEHR';
        new_last := appt.patient_mrn;
    END IF;

    new_complaint := COALESCE(NULLIF(btrim(appt.description), ''), NULLIF(btrim(appt.service_type), ''), 'Scheduled visit');
    new_age := 30 + floor(random() * 50)::int;
    new_gender := CASE WHEN random() < 0.5 THEN 'male' ELSE 'female' END;
    new_dob := CURRENT_DATE - (new_age || ' years')::interval;
    cc_lower := lower(new_complaint);

    IF cc_lower LIKE '%chest%' THEN
        hpi_loc := 'Substernal, radiates to left arm'; picked_chronic := ARRAY['Hypertension','Hyperlipidemia'];
    ELSIF cc_lower LIKE '%abdom%' THEN
        hpi_loc := 'Right lower quadrant'; picked_chronic := ARRAY['GERD'];
    ELSIF cc_lower LIKE '%breath%' OR cc_lower LIKE '%cough%' THEN
        hpi_loc := 'Diffuse, worse on exertion'; picked_chronic := ARRAY['Hypertension'];
    ELSE
        hpi_loc := 'Generalized'; picked_chronic := ARRAY['Hypertension'];
    END IF;

    hpi_char := (ARRAY['Sharp','Dull','Throbbing','Aching','Pressure'])[1 + floor(random()*5)::int];
    hpi_dur := (ARRAY['Constant','Intermittent','Episodic','Progressive'])[1 + floor(random()*4)::int];

    picked_meds := 'Lisinopril 10 mg PO Daily';
    IF 'Hyperlipidemia' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Atorvastatin 40 mg PO QHS'; END IF;
    IF 'GERD' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Omeprazole 20 mg PO Daily'; END IF;

    em_first := first_names[1 + floor(random() * array_length(first_names, 1))::int];

    drug_allergy_txt := CASE WHEN random() < 0.6
        THEN drug_allergies_pool[1 + floor(random()*array_length(drug_allergies_pool,1))::int]
             || ' (' || reactions_pool[1 + floor(random()*array_length(reactions_pool,1))::int] || ')'
        ELSE 'NKDA' END;

    env_idx1 := 1 + floor(random()*array_length(env_pool,1))::int;
    env_idx2 := 1 + floor(random()*(array_length(env_pool,1)-1))::int;
    IF env_idx2 >= env_idx1 THEN env_idx2 := env_idx2 + 1; END IF;
    env_allergy_txt := env_pool[env_idx1] || ', ' || env_pool[env_idx2];

    -- Claim a bed at the appointment's facility
    UPDATE public.bed_management
       SET status = 'Occupied', current_patient_mrn = new_mrn, status_updated_at = NOW()
     WHERE id = (
         SELECT id FROM public.bed_management
          WHERE facility_name = selected_facility AND status = 'Available' AND current_patient_mrn IS NULL
          ORDER BY room_number, bed_letter LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING room_number || '-' || bed_letter INTO room_label;

    IF room_label IS NULL THEN RETURN; END IF;

    ordering_doc := COALESCE(NULLIF(btrim(appt.practitioner_name), ''),
                             pcps[1 + floor(random()*array_length(pcps,1))::int]);

    INSERT INTO public.patients (
      mrn, first_name, last_name, name, age, gender, dob, biological_sex,
      gender_identity, status, facility_name, chief_complaint, admission_time, room,
      occupation, address, phone,
      emergency_contact_name, emergency_contact_relationship, emergency_contact_phone,
      insurance_provider, insurance_policy_number, guarantor, primary_care_physician,
      hpi_onset, hpi_location, hpi_duration, hpi_character,
      hpi_aggravating_factors, hpi_alleviating_factors, hpi_severity,
      past_medical_history, past_surgical_history, past_hospitalizations,
      family_history, environmental_allergies, allergies, current_medications
    ) VALUES (
      new_mrn, new_first, new_last, new_first || ' ' || new_last, new_age,
      new_gender, new_dob, new_gender, new_gender, 'Admitted', selected_facility,
      new_complaint, COALESCE(appt.start_time, NOW()), room_label,
      occupations[1 + floor(random()*array_length(occupations,1))::int],
      (100 + floor(random()*9900))::text || ' ' || streets[1 + floor(random()*array_length(streets,1))::int] || ', ' || cities[1 + floor(random()*array_length(cities,1))::int],
      '(' || (200 + floor(random()*799))::text || ') ' || (200 + floor(random()*799))::text || '-' || (1000 + floor(random()*8999))::text,
      em_first || ' ' || new_last,
      relationships[1 + floor(random()*array_length(relationships,1))::int],
      '(' || (200 + floor(random()*799))::text || ') ' || (200 + floor(random()*799))::text || '-' || (1000 + floor(random()*8999))::text,
      insurers[1 + floor(random()*array_length(insurers,1))::int],
      'POL-' || (100000 + floor(random()*899999))::text, 'Self',
      ordering_doc,
      'Scheduled appointment',
      hpi_loc, hpi_dur, hpi_char,
      aggravating_pool[1 + floor(random()*array_length(aggravating_pool,1))::int],
      alleviating_pool[1 + floor(random()*array_length(alleviating_pool,1))::int],
      (3 + floor(random()*6))::int,
      array_to_string(picked_chronic, ', '),
      surgeries_pool[1 + floor(random()*array_length(surgeries_pool,1))::int],
      hosp_pool[1 + floor(random()*array_length(hosp_pool,1))::int],
      fam_pool[1 + floor(random()*array_length(fam_pool,1))::int] || '. ' || family_notes_pool[1 + floor(random()*array_length(family_notes_pool,1))::int],
      env_allergy_txt, drug_allergy_txt, picked_meds
    ) ON CONFLICT (mrn) DO NOTHING
    RETURNING mrn INTO inserted_mrn;

    IF inserted_mrn IS NULL THEN
        -- Release the bed we grabbed if the insert lost to conflict
        UPDATE public.bed_management SET status = 'Available', current_patient_mrn = NULL, status_updated_at = NOW()
         WHERE current_patient_mrn = new_mrn;
        UPDATE public.fhir_appointments SET status = 'fulfilled' WHERE id = p_appointment_id;
        RETURN;
    END IF;

    IF drug_allergy_txt LIKE 'Sulfa%' THEN
        INSERT INTO public.allergies (mrn, substance, substance_snomed, reaction, status, coding_source, created_by_type)
        VALUES (inserted_mrn, 'Sulfa', '387033004',
                substring(drug_allergy_txt FROM '\((.*)\)'), 'active', 'appointment-auto-admit', 'automation')
        ON CONFLICT (mrn, substance) DO UPDATE SET substance_snomed = EXCLUDED.substance_snomed, reaction = EXCLUDED.reaction;
    END IF;

    IF 'Hypertension' = ANY(picked_chronic) THEN
        PERFORM public._ghost_insert_med_from_class(inserted_mrn, new_first || ' ' || new_last, selected_facility, ordering_doc,
          ARRAY['ACE Inhibitor','ARB','Beta Blocker','Calcium Channel Blocker','Diuretic'],
          'Lisinopril','10 mg','PO','Daily','29046');
    END IF;
    IF 'Hyperlipidemia' = ANY(picked_chronic) THEN
        PERFORM public._ghost_insert_med_from_class(inserted_mrn, new_first || ' ' || new_last, selected_facility, ordering_doc,
          ARRAY['Statin'],'Atorvastatin','40 mg','PO','QHS','83367');
    END IF;
    IF 'GERD' = ANY(picked_chronic) THEN
        PERFORM public._ghost_insert_med_from_class(inserted_mrn, new_first || ' ' || new_last, selected_facility, ordering_doc,
          ARRAY['Proton Pump Inhibitor'],'Omeprazole','20 mg','PO','Daily','7646');
    END IF;

    INSERT INTO public.conditions (
        mrn, patient_name, display_text, category, clinical_status,
        verification_status, onset_date, snomed_code, snomed_display,
        icd10_code, icd10_display, coding_source, coded_at, created_by_type
    )
    SELECT inserted_mrn, new_first || ' ' || new_last, c.display_text,
           'problem-list-item', 'active', 'confirmed', now(),
           c.snomed_code, c.snomed_display, c.icd10_code, c.icd10_display,
           'appointment-auto-admit', now(), 'automation'
    FROM (VALUES
        ('Hypertension','38341003','Essential hypertension','I10','Essential (primary) hypertension'),
        ('Hyperlipidemia','55822004','Hyperlipidemia','E78.5','Hyperlipidemia, unspecified'),
        ('GERD','235595009','Gastroesophageal reflux disease','K21.9','Gastro-esophageal reflux disease without esophagitis')
    ) AS c(display_text, snomed_code, snomed_display, icd10_code, icd10_display)
    WHERE c.display_text = ANY(picked_chronic);

    UPDATE public.fhir_appointments SET status = 'fulfilled' WHERE id = p_appointment_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.auto_admit_due_appointments()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT id FROM public.fhir_appointments
         WHERE status = 'booked'
           AND start_time <= now()
           AND patient_mrn IS NOT NULL
         ORDER BY start_time
         LIMIT 50
    LOOP
        BEGIN
            PERFORM public.admit_patient_from_appointment(rec.id);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'admit_patient_from_appointment(%) failed: %', rec.id, SQLERRM;
        END;
    END LOOP;
END;
$$;

DO $$
BEGIN
  PERFORM cron.unschedule('auto_admit_appointments_job');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule('auto_admit_appointments_job', '* * * * *', $$SELECT public.auto_admit_due_appointments();$$);
