CREATE OR REPLACE FUNCTION public.auto_admit_ghost_patient()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    i INT; selected_facility TEXT; room_label TEXT;
    new_mrn TEXT; new_first TEXT; new_last TEXT; new_complaint TEXT;
    new_age INT; new_gender TEXT; new_dob DATE;
    cc_lower TEXT;
    chronic_pool TEXT[];
    picked_chronic TEXT[];
    picked_meds TEXT;
    hpi_loc TEXT; hpi_char TEXT; hpi_dur TEXT;
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
    surgeries_pool TEXT[] := ARRAY['Appendectomy 2008 — no complications','Cholecystectomy 2015 — uneventful recovery','CABG x3 2019 — tolerated anesthesia well','Hip replacement 2021 — physical therapy completed','None reported'];
    hosp_pool TEXT[] := ARRAY['Admitted 2022 for pneumonia — 4 day stay','ED visit 2023 for chest pain — ruled out MI','Admitted 2020 for DKA — ICU 2 days','No prior admissions'];
    family_notes_pool TEXT[] := ARRAY['Father deceased age 68 — MI. Mother alive, HTN.','Mother — breast cancer. Father — Type 2 DM.','Sibling with stroke at age 55. No other notable hx.','Non-contributory.'];
    aggravating_pool TEXT[] := ARRAY['Exertion','Movement','Deep breathing','Eating','Lying flat'];
    alleviating_pool TEXT[] := ARRAY['Rest','Nitroglycerin','Antacids','Sitting upright','NSAIDs'];
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
    em_first TEXT;
    drug_allergy_txt TEXT;
    env_allergy_txt TEXT;
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
        cc_lower := lower(new_complaint);

        -- HPI derivation
        IF cc_lower LIKE '%chest%' THEN
            hpi_loc := 'Substernal, radiates to left arm';
            chronic_pool := ARRAY['Hypertension','Coronary Artery Disease','Hyperlipidemia'];
        ELSIF cc_lower LIKE '%abdom%' THEN
            hpi_loc := 'Right lower quadrant';
            chronic_pool := ARRAY['GERD','Type 2 Diabetes'];
        ELSIF cc_lower LIKE '%breath%' OR cc_lower LIKE '%dyspnea%' OR cc_lower LIKE '%cough%' THEN
            hpi_loc := 'Diffuse, worse on exertion';
            chronic_pool := ARRAY['COPD','Hypertension'];
        ELSIF cc_lower LIKE '%weakness%' OR cc_lower LIKE '%speech%' OR cc_lower LIKE '%droop%' THEN
            hpi_loc := 'Right upper and lower extremity';
            chronic_pool := ARRAY['Hypertension','Atrial Fibrillation'];
        ELSE
            hpi_loc := 'Generalized';
            chronic_pool := ARRAY['Hypertension','Hyperlipidemia'];
        END IF;

        hpi_char := (ARRAY['Sharp','Dull','Throbbing','Burning','Crushing','Aching','Stabbing','Pressure'])[1 + floor(random()*8)::int]
                    || ', ' ||
                    (ARRAY['Sharp','Dull','Throbbing','Burning','Crushing','Aching','Stabbing','Pressure'])[1 + floor(random()*8)::int];
        hpi_dur := (ARRAY['Constant','Intermittent','Episodic','Progressive'])[1 + floor(random()*4)::int];

        picked_chronic := chronic_pool;
        picked_meds := CASE
            WHEN 'Hypertension' = ANY(picked_chronic) THEN 'Lisinopril 10 mg PO Daily'
            ELSE 'Multivitamin 1 tab PO Daily'
        END;
        IF 'Type 2 Diabetes' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Metformin 500 mg PO BID'; END IF;
        IF 'Hyperlipidemia' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Atorvastatin 40 mg PO QHS'; END IF;
        IF 'Coronary Artery Disease' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Aspirin 81 mg PO Daily'; END IF;
        IF 'Atrial Fibrillation' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Apixaban 5 mg PO BID'; END IF;
        IF 'GERD' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Omeprazole 20 mg PO Daily'; END IF;

        em_first := first_names[1 + floor(random() * array_length(first_names, 1))::int];

        drug_allergy_txt := CASE WHEN random() < 0.7
            THEN drug_allergies_pool[1 + floor(random()*array_length(drug_allergies_pool,1))::int]
                 || ' (' || reactions_pool[1 + floor(random()*array_length(reactions_pool,1))::int] || ')'
            ELSE 'NKDA'
        END;

        env_allergy_txt := env_pool[1 + floor(random()*array_length(env_pool,1))::int]
                           || ', ' || env_pool[1 + floor(random()*array_length(env_pool,1))::int];

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
          gender_identity, status, facility_name, chief_complaint, admission_time, room,
          occupation, address, phone,
          emergency_contact_name, emergency_contact_relationship, emergency_contact_phone,
          insurance_provider, insurance_policy_number, guarantor, primary_care_physician,
          hpi_onset, hpi_location, hpi_duration, hpi_character,
          hpi_aggravating_factors, hpi_alleviating_factors, hpi_severity,
          past_medical_history, past_surgical_history, past_hospitalizations,
          family_history, environmental_allergies, allergies, current_medications
        )
        VALUES (
          new_mrn, new_first, new_last, new_first || ' ' || new_last, new_age,
          new_gender, new_dob, new_gender, new_gender, 'Admitted', selected_facility,
          new_complaint, NOW(), room_label,
          occupations[1 + floor(random()*array_length(occupations,1))::int],
          (100 + floor(random()*9900))::text || ' ' || streets[1 + floor(random()*array_length(streets,1))::int] || ', ' || cities[1 + floor(random()*array_length(cities,1))::int],
          '(' || (200 + floor(random()*799))::text || ') ' || (200 + floor(random()*799))::text || '-' || (1000 + floor(random()*8999))::text,
          em_first || ' ' || new_last,
          relationships[1 + floor(random()*array_length(relationships,1))::int],
          '(' || (200 + floor(random()*799))::text || ') ' || (200 + floor(random()*799))::text || '-' || (1000 + floor(random()*8999))::text,
          insurers[1 + floor(random()*array_length(insurers,1))::int],
          'POL-' || (100000 + floor(random()*899999))::text,
          'Self',
          pcps[1 + floor(random()*array_length(pcps,1))::int],
          (1 + floor(random()*12))::text || ' hours ago',
          hpi_loc, hpi_dur, hpi_char,
          aggravating_pool[1 + floor(random()*array_length(aggravating_pool,1))::int],
          alleviating_pool[1 + floor(random()*array_length(alleviating_pool,1))::int],
          (5 + floor(random()*5))::int,
          array_to_string(picked_chronic, ', '),
          surgeries_pool[1 + floor(random()*array_length(surgeries_pool,1))::int],
          hosp_pool[1 + floor(random()*array_length(hosp_pool,1))::int],
          fam_pool[1 + floor(random()*array_length(fam_pool,1))::int] || '. ' || family_notes_pool[1 + floor(random()*array_length(family_notes_pool,1))::int],
          env_allergy_txt,
          drug_allergy_txt,
          picked_meds
        )
        ON CONFLICT (mrn) DO NOTHING;
    END LOOP;
END;
$function$;