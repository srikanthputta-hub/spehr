-- ==========================================================================
-- Part 1: sweep_stalled_clinical_orders — threshold 70 -> 50
-- Keep the literal 50 in sync with SAFETY_AUTO_REJECT_THRESHOLD in
-- src/lib/safety-alert-resolution.ts.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.sweep_stalled_clinical_orders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  alert_row RECORD;
  decision text;
  physician_name text;
  orig_order RECORD;
  now_iso timestamptz := now();
  score int;
  reason_text text;
  alt_drug_name text;
  alt_dose text;
  alt_route text;
  alt_freq text;
  src_drug text;
BEGIN
  FOR alert_row IN
    SELECT * FROM clinical_safety_alerts
    WHERE status = 'Pending Review'
      AND now_iso >= COALESCE(auto_resolve_at, created_at + interval '45 seconds')
    ORDER BY created_at
  LOOP
    score := COALESCE(alert_row.risk_score, 50);
    -- Keep in sync with SAFETY_AUTO_REJECT_THRESHOLD in src/lib/safety-alert-resolution.ts
    decision := CASE WHEN score >= 50 THEN 'Rejected' ELSE 'Overridden' END;

    SELECT ordering_physician INTO physician_name
    FROM medication_orders WHERE id = alert_row.medication_order_id;
    physician_name := COALESCE(physician_name, 'Attending Physician');

    reason_text := 'Risk score ' || score || '/100 (threshold: score >= 50 = auto-Reject, < 50 = auto-Override) -> '
      || decision || '. [SLA auto-resolved on behalf of ' || physician_name || ' — 45s review window expired] '
      || COALESCE(alert_row.family, alert_row.kind, 'Safety alert');

    UPDATE clinical_safety_alerts
    SET status = decision,
        decided_by = 'AI Safety Engine (Auto-SLA)',
        decided_at = now_iso,
        rationale = reason_text,
        resolved_by = 'AI Safety Engine (Auto-SLA)',
        resolution_rationale = reason_text,
        updated_at = now_iso
    WHERE id = alert_row.id
      AND status = 'Pending Review';

    IF FOUND AND alert_row.medication_order_id IS NOT NULL THEN
      SELECT * INTO orig_order FROM medication_orders WHERE id = alert_row.medication_order_id;

      IF decision = 'Rejected' THEN
        UPDATE medication_orders SET status = 'REJECTED_SAFETY_ALERT', updated_at = now_iso
        WHERE id = alert_row.medication_order_id;

        -- Only a truly rejected order needs a real alternate substituted —
        -- an "Overridden" order proceeds as originally written, so no
        -- second order should be created for it (previously this ran
        -- unconditionally for both branches, creating a redundant order
        -- even when the original was allowed to proceed).
        IF orig_order.id IS NOT NULL THEN
          src_drug := lower(COALESCE(orig_order.drug_name, orig_order.medication_name, ''));

          -- Pick a real, class-appropriate alternate instead of a placeholder
          -- string. A placeholder like "Pending Pharmacist Alternate
          -- Selection" would previously get silently marked "Administered"
          -- by the stale-order sweep below (or sent to the MAR as-is if a
          -- pharmacist clicked Approve), i.e. a fake, non-existent
          -- medication would end up recorded as given to the patient.
          IF src_drug ~ 'penicillin|amoxicillin|ampicillin|piperacillin|oxacillin|nafcillin|dicloxacillin' THEN
            alt_drug_name := 'Azithromycin';
            alt_dose := '500 mg'; alt_route := 'PO'; alt_freq := 'Daily';
          ELSIF src_drug ~ 'cefazolin|ceftriaxone|cefepime|cephalexin|cefuroxime|cefdinir' THEN
            alt_drug_name := 'Azithromycin';
            alt_dose := '500 mg'; alt_route := 'PO'; alt_freq := 'Daily';
          ELSIF src_drug ~ 'sulfamethoxazole|sulfa|trimethoprim' THEN
            alt_drug_name := 'Nitrofurantoin';
            alt_dose := '100 mg'; alt_route := 'PO'; alt_freq := 'BID';
          ELSE
            alt_drug_name := COALESCE(orig_order.drug_name, orig_order.medication_name, 'Alternate Agent');
            alt_dose := orig_order.dose; alt_route := orig_order.route; alt_freq := orig_order.frequency;
          END IF;

          -- Guard against duplicate substitution rows for the same rejected
          -- order (e.g. if this sweep is invoked more than once for the
          -- same alert before the alert's status flip is visible yet).
          IF NOT EXISTS (
            SELECT 1 FROM medication_orders
            WHERE coding_source = 'safety-substitution-sweep'
              AND patient_mrn = COALESCE(orig_order.patient_mrn, orig_order.mrn, alert_row.mrn)
              AND drug_name = alt_drug_name
              AND created_at > now_iso - interval '2 minutes'
          ) THEN
            INSERT INTO medication_orders (
              patient_mrn, mrn, patient_name, facility_name, drug_name, medication_name,
              dose, route, frequency, status, ordering_physician, coding_source, term_status, created_by_type
            ) VALUES (
              COALESCE(orig_order.patient_mrn, orig_order.mrn, alert_row.mrn),
              COALESCE(orig_order.mrn, alert_row.mrn),
              orig_order.patient_name,
              orig_order.facility_name,
              alt_drug_name,
              alt_drug_name,
              alt_dose, alt_route, alt_freq,
              'PENDING_PHARMACY',
              physician_name,
              'safety-substitution-sweep',
              'Auto-substituted ' || alt_drug_name || ' in place of rejected ' || COALESCE(orig_order.drug_name, orig_order.medication_name, 'medication') || ' (allergy/interaction conflict)',
              'automation'
            );
          END IF;
        END IF;
      ELSE
        UPDATE medication_orders SET status = 'PENDING_PHARMACY', updated_at = now_iso
        WHERE id = alert_row.medication_order_id;
      END IF;

      INSERT INTO cds_overrides (mrn, alert_type, severity, drug_name, condition_name, reason, physician_name, fired_at, decision, patient_name, facility_name, risk_score)
      VALUES (
        alert_row.mrn, alert_row.kind, COALESCE(alert_row.severity,'high'), alert_row.drug,
        CASE WHEN alert_row.kind = 'Drug-Drug' THEN alert_row.drug_b ELSE alert_row.allergy_name END,
        reason_text,
        physician_name, now_iso, decision,
        alert_row.patient_name, alert_row.facility_name, score
      );
    END IF;
  END LOOP;

  UPDATE medication_orders
  SET status = 'Administered', administered_at = now_iso, updated_at = now_iso
  WHERE created_at < now_iso - interval '10 minutes'
    AND upper(status) IN (
      'ORDERED', 'PENDING', 'PENDING VERIFICATION', 'PENDING_VERIFICATION',
      'PENDING_PHARMACY', 'DISPENSED', 'DUE'
    );

  UPDATE medication_orders mo
  SET status = 'PENDING_PHARMACY', updated_at = now_iso
  WHERE mo.status = 'HELD_SAFETY_REVIEW'
    AND mo.created_at < now_iso - interval '5 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM clinical_safety_alerts a
      WHERE a.medication_order_id = mo.id AND a.status = 'Pending Review'
    );

  UPDATE lab_orders
  SET status = 'Reported',
      resulted_at = now_iso,
      result_value = COALESCE(result_value, 'WBC: 7.8 k/uL, Hgb: 13.9 g/dL, Plt: 240 k/uL [WNL] — auto-finalized by workflow sweep')
  WHERE created_at < now_iso - interval '10 minutes'
    AND upper(status) IN ('ORDERED', 'PROCESSING', 'PENDING COLLECTION');
END;
$function$;

-- ==========================================================================
-- Part 2: auto_admit_ghost_patient — 1/10 -> 1/6 safety demo, and pull
-- allergy + triggering medication from the published value sets.
-- ==========================================================================
CREATE OR REPLACE FUNCTION public.auto_admit_ghost_patient()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    i INT; batch_n INT;
    selected_facility TEXT; room_label TEXT;
    new_mrn TEXT; new_first TEXT; new_last TEXT; new_complaint TEXT;
    new_age INT; new_gender TEXT; new_dob DATE;
    cc_lower TEXT;
    chronic_pool TEXT[]; picked_chronic TEXT[]; picked_meds TEXT;
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
      'Severe chest pain for the last two hours','Shortness of breath since yesterday evening',
      'Sudden onset right-sided weakness','Severe abdominal pain, started this morning',
      'Persistent fever and productive cough for 4 days','Crushing substernal chest pressure radiating to left arm',
      'Worsening dyspnea on exertion over the past week','Acute onset slurred speech and facial droop',
      'Sharp lower back pain after a fall this afternoon','High-grade fever with chills and confusion since last night'
    ];
    facilities TEXT[] := ARRAY['Memorial Hospital','St. Jude Medical Center','City General Infirmary','County Health Pavilion','Srik Health Clinic'];
    em_first TEXT; drug_allergy_txt TEXT; env_allergy_txt TEXT;
    is_safety_demo BOOLEAN;
    inserted_mrn TEXT;
    ordering_doc TEXT;
    env_idx1 INT; env_idx2 INT;
    demo_counter INT;
    active_census INT;
    census_cap    CONSTANT INT := 85;
    headroom      INT;
    -- Governed pulls from the published Safety value sets
    demo_allergy_code TEXT; demo_allergy_name TEXT; demo_allergy_reaction TEXT;
    demo_med_code TEXT;     demo_med_name TEXT;
    vs_codes JSONB; vs_pick JSONB;
BEGIN
    IF (SELECT automation_enabled FROM system_settings WHERE id = 1) = false THEN RETURN; END IF;

    UPDATE public.bed_management b
       SET status = 'Available', current_patient_mrn = NULL, status_updated_at = NOW()
     WHERE b.current_patient_mrn IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.mrn = b.current_patient_mrn AND lower(p.status) = 'admitted');

    SELECT COUNT(*) INTO active_census
      FROM public.patients
     WHERE lower(status) = 'admitted';

    headroom := census_cap - active_census;
    IF headroom <= 0 THEN
      RETURN;
    END IF;

    batch_n := 3 + (CASE WHEN random() < 0.47 THEN 1 ELSE 0 END);
    IF batch_n > headroom THEN batch_n := headroom; END IF;

    FOR i IN 1..batch_n LOOP
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

        IF cc_lower LIKE '%chest%' THEN
            hpi_loc := 'Substernal, radiates to left arm'; chronic_pool := ARRAY['Hypertension','Coronary Artery Disease','Hyperlipidemia'];
        ELSIF cc_lower LIKE '%abdom%' THEN
            hpi_loc := 'Right lower quadrant'; chronic_pool := ARRAY['GERD','Type 2 Diabetes'];
        ELSIF cc_lower LIKE '%breath%' OR cc_lower LIKE '%dyspnea%' OR cc_lower LIKE '%cough%' THEN
            hpi_loc := 'Diffuse, worse on exertion'; chronic_pool := ARRAY['COPD','Hypertension'];
        ELSIF cc_lower LIKE '%weakness%' OR cc_lower LIKE '%speech%' OR cc_lower LIKE '%droop%' THEN
            hpi_loc := 'Right upper and lower extremity'; chronic_pool := ARRAY['Hypertension','Atrial Fibrillation'];
        ELSE
            hpi_loc := 'Generalized'; chronic_pool := ARRAY['Hypertension','Hyperlipidemia'];
        END IF;

        hpi_char := (ARRAY['Sharp','Dull','Throbbing','Burning','Crushing','Aching','Stabbing','Pressure'])[1 + floor(random()*8)::int]
                    || ', ' || (ARRAY['Sharp','Dull','Throbbing','Burning','Crushing','Aching','Stabbing','Pressure'])[1 + floor(random()*8)::int];
        hpi_dur := (ARRAY['Constant','Intermittent','Episodic','Progressive'])[1 + floor(random()*4)::int];

        picked_chronic := chronic_pool;
        picked_meds := CASE WHEN 'Hypertension' = ANY(picked_chronic) THEN 'Lisinopril 10 mg PO Daily' ELSE 'Multivitamin 1 tab PO Daily' END;
        IF 'Type 2 Diabetes' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Metformin 500 mg PO BID'; END IF;
        IF 'Hyperlipidemia' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Atorvastatin 40 mg PO QHS'; END IF;
        IF 'Coronary Artery Disease' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Aspirin 81 mg PO Daily'; END IF;
        IF 'Atrial Fibrillation' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Apixaban 5 mg PO BID'; END IF;
        IF 'GERD' = ANY(picked_chronic) THEN picked_meds := picked_meds || '; Omeprazole 20 mg PO Daily'; END IF;

        em_first := first_names[1 + floor(random() * array_length(first_names, 1))::int];

        drug_allergy_txt := CASE WHEN random() < 0.7
            THEN drug_allergies_pool[1 + floor(random()*array_length(drug_allergies_pool,1))::int]
                 || ' (' || reactions_pool[1 + floor(random()*array_length(reactions_pool,1))::int] || ')'
            ELSE 'NKDA' END;

        env_idx1 := 1 + floor(random()*array_length(env_pool,1))::int;
        env_idx2 := 1 + floor(random()*(array_length(env_pool,1)-1))::int;
        IF env_idx2 >= env_idx1 THEN env_idx2 := env_idx2 + 1; END IF;
        env_allergy_txt := env_pool[env_idx1] || ', ' || env_pool[env_idx2];

        UPDATE public.bed_management
           SET status = 'Occupied', current_patient_mrn = new_mrn, status_updated_at = NOW()
         WHERE id = (
             SELECT id FROM public.bed_management
              WHERE facility_name = selected_facility AND status = 'Available' AND current_patient_mrn IS NULL
              ORDER BY room_number, bed_letter LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING room_number || '-' || bed_letter INTO room_label;

        IF room_label IS NULL THEN CONTINUE; END IF;

        UPDATE public.system_settings
           SET ghost_safety_demo_counter = ghost_safety_demo_counter + 1
         WHERE id = 1
         RETURNING ghost_safety_demo_counter INTO demo_counter;
        -- Every 6th ghost patient is a safety-alert demo (was every 10th).
        is_safety_demo := (demo_counter % 6 = 0);

        -- Resolve the demo allergy + triggering medication from the published
        -- value sets so this genuinely exercises value-set governance rather
        -- than hardcoded Penicillin/Amoxicillin strings. Falls back to the
        -- historical hardcoded pair if the value sets are absent/empty.
        IF is_safety_demo THEN
            demo_allergy_code := '373270004';
            demo_allergy_name := 'Penicillin';
            demo_allergy_reaction := reactions_pool[1 + floor(random()*array_length(reactions_pool,1))::int];
            demo_med_code := '723';
            demo_med_name := 'Amoxicillin';

            SELECT codes INTO vs_codes
              FROM public.custom_value_sets
             WHERE name = 'Penicillin/Beta-Lactam Allergens' AND status = 'published'
             LIMIT 1;
            IF vs_codes IS NOT NULL AND jsonb_array_length(vs_codes) > 0 THEN
                vs_pick := vs_codes -> floor(random() * jsonb_array_length(vs_codes))::int;
                IF vs_pick ? 'code' THEN
                    demo_allergy_code := COALESCE(vs_pick->>'code', demo_allergy_code);
                    demo_allergy_name := COALESCE(NULLIF(vs_pick->>'display',''), demo_allergy_name);
                END IF;
            END IF;

            SELECT codes INTO vs_codes
              FROM public.custom_value_sets
             WHERE name = 'Penicillin Class Drugs' AND status = 'published'
             LIMIT 1;
            IF vs_codes IS NOT NULL AND jsonb_array_length(vs_codes) > 0 THEN
                vs_pick := vs_codes -> floor(random() * jsonb_array_length(vs_codes))::int;
                IF vs_pick ? 'code' THEN
                    demo_med_code := COALESCE(vs_pick->>'code', demo_med_code);
                    demo_med_name := COALESCE(NULLIF(vs_pick->>'display',''), demo_med_name);
                END IF;
            END IF;

            drug_allergy_txt := demo_allergy_name || ' (' || demo_allergy_reaction || ')';
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
        ) VALUES (
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
          'POL-' || (100000 + floor(random()*899999))::text, 'Self',
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
          env_allergy_txt, drug_allergy_txt, picked_meds
        ) ON CONFLICT (mrn) DO NOTHING
        RETURNING mrn INTO inserted_mrn;

        IF inserted_mrn IS NULL THEN CONTINUE; END IF;

        IF is_safety_demo THEN
            INSERT INTO public.allergies (mrn, substance, substance_snomed, reaction, status, coding_source, created_by_type)
            VALUES (inserted_mrn, demo_allergy_name, demo_allergy_code, demo_allergy_reaction, 'active', 'ghost-admission-automation', 'automation')
            ON CONFLICT (mrn, substance) DO UPDATE SET substance_snomed = EXCLUDED.substance_snomed, reaction = EXCLUDED.reaction;
        ELSIF drug_allergy_txt LIKE 'Sulfa%' THEN
            INSERT INTO public.allergies (mrn, substance, substance_snomed, reaction, status, coding_source, created_by_type)
            VALUES (inserted_mrn, 'Sulfa', '387033004',
                    substring(drug_allergy_txt FROM '\((.*)\)'), 'active', 'ghost-admission-automation', 'automation')
            ON CONFLICT (mrn, substance) DO UPDATE SET substance_snomed = EXCLUDED.substance_snomed, reaction = EXCLUDED.reaction;
        END IF;

        ordering_doc := pcps[1 + floor(random()*array_length(pcps,1))::int];

        IF 'Hypertension' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Lisinopril', 'Lisinopril', '10 mg', 'PO', 'Daily', '29046', 'Lisinopril', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;
        IF 'Type 2 Diabetes' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Metformin', 'Metformin', '500 mg', 'PO', 'BID', '6809', 'Metformin', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;
        IF 'Hyperlipidemia' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Atorvastatin', 'Atorvastatin', '40 mg', 'PO', 'QHS', '83367', 'Atorvastatin', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;
        IF 'Coronary Artery Disease' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Aspirin', 'Aspirin', '81 mg', 'PO', 'Daily', '1191', 'Aspirin', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;
        IF 'Atrial Fibrillation' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Apixaban', 'Apixaban', '5 mg', 'PO', 'BID', '1364430', 'Apixaban', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;
        IF 'GERD' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Omeprazole', 'Omeprazole', '20 mg', 'PO', 'Daily', '7646', 'Omeprazole', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;

        IF is_safety_demo THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, demo_med_name, demo_med_name, '500 mg', 'PO', 'TID', demo_med_code, demo_med_name, 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;
    END LOOP;
END;
$function$;
