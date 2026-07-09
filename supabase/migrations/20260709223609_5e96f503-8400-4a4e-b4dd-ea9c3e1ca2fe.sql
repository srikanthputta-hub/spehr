
-- 1) formulary_catalog table (mirror of partner FHIR Medication resources)
CREATE TABLE IF NOT EXISTS public.formulary_catalog (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  rxnorm_code TEXT NOT NULL UNIQUE,
  drug_name TEXT,
  strength TEXT,
  dose_form TEXT,
  full_display TEXT,
  drug_class TEXT,
  typical_route TEXT,
  typical_frequency TEXT,
  is_high_alert BOOLEAN NOT NULL DEFAULT false,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_formulary_catalog_class ON public.formulary_catalog(drug_class);

GRANT SELECT ON public.formulary_catalog TO authenticated;
GRANT ALL   ON public.formulary_catalog TO service_role;

ALTER TABLE public.formulary_catalog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "formulary_catalog readable by authenticated"
  ON public.formulary_catalog FOR SELECT
  TO authenticated USING (true);

-- 2) Seed cursor for the new poll target so the first tick doesn't scan the whole history.
INSERT INTO public.fhir_sync_state (key, value)
VALUES ('medication_formulary_last_polled_at', jsonb_build_object('ts', (now() - interval '10 minutes')::text))
ON CONFLICT (key) DO NOTHING;

-- 3) Rewrite auto_admit_ghost_patient's medication section to sample from formulary_catalog.
--    Everything ELSE in the function stays byte-identical (safety-demo penicillin branch,
--    complaints, allergies, etc). We do this with a targeted CREATE OR REPLACE that copies
--    the existing body and swaps only the 6 chronic-condition IF blocks.
DO $mig$
DECLARE
  body TEXT;
  old_block TEXT;
  new_block TEXT;
BEGIN
  SELECT pg_get_functiondef('public.auto_admit_ghost_patient'::regproc) INTO body;

  -- Replace each hardcoded INSERT with a SELECT-from-catalog-then-INSERT block.
  -- Fallback keeps original hardcoded values if catalog empty for that class.

  old_block := $$        IF 'Hypertension' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Lisinopril', 'Lisinopril', '10 mg', 'PO', 'Daily', '29046', 'Lisinopril', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;$$;
  new_block := $$        IF 'Hypertension' = ANY(picked_chronic) THEN
            PERFORM public._ghost_insert_med_from_class(inserted_mrn, new_first || ' ' || new_last, selected_facility, ordering_doc,
              ARRAY['ACE Inhibitor','ARB','Beta Blocker','Calcium Channel Blocker','Diuretic'],
              'Lisinopril','10 mg','PO','Daily','29046');
        END IF;$$;
  body := replace(body, old_block, new_block);

  old_block := $$        IF 'Type 2 Diabetes' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Metformin', 'Metformin', '500 mg', 'PO', 'BID', '6809', 'Metformin', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;$$;
  new_block := $$        IF 'Type 2 Diabetes' = ANY(picked_chronic) THEN
            PERFORM public._ghost_insert_med_from_class(inserted_mrn, new_first || ' ' || new_last, selected_facility, ordering_doc,
              ARRAY['Antidiabetic','Insulin'],
              'Metformin','500 mg','PO','BID','6809');
        END IF;$$;
  body := replace(body, old_block, new_block);

  old_block := $$        IF 'Hyperlipidemia' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Atorvastatin', 'Atorvastatin', '40 mg', 'PO', 'QHS', '83367', 'Atorvastatin', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;$$;
  new_block := $$        IF 'Hyperlipidemia' = ANY(picked_chronic) THEN
            PERFORM public._ghost_insert_med_from_class(inserted_mrn, new_first || ' ' || new_last, selected_facility, ordering_doc,
              ARRAY['Statin'],
              'Atorvastatin','40 mg','PO','QHS','83367');
        END IF;$$;
  body := replace(body, old_block, new_block);

  old_block := $$        IF 'Coronary Artery Disease' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Aspirin', 'Aspirin', '81 mg', 'PO', 'Daily', '1191', 'Aspirin', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;$$;
  new_block := $$        IF 'Coronary Artery Disease' = ANY(picked_chronic) THEN
            PERFORM public._ghost_insert_med_from_class(inserted_mrn, new_first || ' ' || new_last, selected_facility, ordering_doc,
              ARRAY['Antiplatelet'],
              'Aspirin','81 mg','PO','Daily','1191');
        END IF;$$;
  body := replace(body, old_block, new_block);

  old_block := $$        IF 'Atrial Fibrillation' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Apixaban', 'Apixaban', '5 mg', 'PO', 'BID', '1364430', 'Apixaban', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;$$;
  new_block := $$        IF 'Atrial Fibrillation' = ANY(picked_chronic) THEN
            PERFORM public._ghost_insert_med_from_class(inserted_mrn, new_first || ' ' || new_last, selected_facility, ordering_doc,
              ARRAY['Anticoagulant'],
              'Apixaban','5 mg','PO','BID','1364430');
        END IF;$$;
  body := replace(body, old_block, new_block);

  old_block := $$        IF 'GERD' = ANY(picked_chronic) THEN
            INSERT INTO public.medication_orders (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency, rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by, facility_name, created_by_type)
            VALUES (inserted_mrn, inserted_mrn, new_first || ' ' || new_last, 'Omeprazole', 'Omeprazole', '20 mg', 'PO', 'Daily', '7646', 'Omeprazole', 'ghost-admission-automation', 'PENDING_VERIFICATION', ordering_doc, ordering_doc, selected_facility, 'automation');
        END IF;$$;
  new_block := $$        IF 'GERD' = ANY(picked_chronic) THEN
            PERFORM public._ghost_insert_med_from_class(inserted_mrn, new_first || ' ' || new_last, selected_facility, ordering_doc,
              ARRAY['Proton Pump Inhibitor'],
              'Omeprazole','20 mg','PO','Daily','7646');
        END IF;$$;
  body := replace(body, old_block, new_block);

  -- First, define the helper that samples from formulary_catalog.
  EXECUTE $helper$
    CREATE OR REPLACE FUNCTION public._ghost_insert_med_from_class(
      p_mrn TEXT,
      p_patient_name TEXT,
      p_facility TEXT,
      p_ordering_doc TEXT,
      p_classes TEXT[],
      p_fallback_name TEXT,
      p_fallback_dose TEXT,
      p_fallback_route TEXT,
      p_fallback_freq TEXT,
      p_fallback_rxnorm TEXT
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
    DECLARE
      r RECORD;
      v_drug_name TEXT; v_dose TEXT; v_route TEXT; v_freq TEXT; v_rxnorm TEXT; v_display TEXT;
    BEGIN
      SELECT rxnorm_code, drug_name, strength, dose_form, full_display, typical_route, typical_frequency
        INTO r
        FROM public.formulary_catalog
       WHERE drug_class = ANY(p_classes)
         AND rxnorm_code IS NOT NULL
       ORDER BY random()
       LIMIT 1;

      IF r.rxnorm_code IS NULL THEN
        v_drug_name := p_fallback_name;
        v_dose      := p_fallback_dose;
        v_route     := p_fallback_route;
        v_freq      := p_fallback_freq;
        v_rxnorm    := p_fallback_rxnorm;
        v_display   := p_fallback_name;
      ELSE
        v_drug_name := COALESCE(NULLIF(r.drug_name,''), split_part(r.full_display,' ',1));
        v_dose      := COALESCE(NULLIF(r.strength,''), p_fallback_dose);
        v_route     := CASE lower(COALESCE(r.typical_route,''))
                         WHEN 'oral' THEN 'PO'
                         WHEN 'subcutaneous' THEN 'SubQ'
                         WHEN 'subq' THEN 'SubQ'
                         WHEN '' THEN p_fallback_route
                         ELSE r.typical_route
                       END;
        v_freq      := COALESCE(NULLIF(r.typical_frequency,''), p_fallback_freq);
        v_rxnorm    := r.rxnorm_code;
        v_display   := COALESCE(NULLIF(r.full_display,''), v_drug_name);
      END IF;

      INSERT INTO public.medication_orders
        (mrn, patient_mrn, patient_name, drug_name, medication_name, dose, route, frequency,
         rxnorm_code, rxnorm_display, coding_source, status, ordering_physician, ordered_by,
         facility_name, created_by_type)
      VALUES
        (p_mrn, p_mrn, p_patient_name, v_drug_name, v_drug_name, v_dose, v_route, v_freq,
         v_rxnorm, v_display, 'ghost-admission-automation', 'PENDING_VERIFICATION',
         p_ordering_doc, p_ordering_doc, p_facility, 'automation');
    END;
    $fn$;
  $helper$;

  -- Strip the leading `CREATE OR REPLACE FUNCTION public.auto_admit_ghost_patient()` header
  -- from pg_get_functiondef output — EXECUTE needs a full CREATE OR REPLACE statement
  -- which pg_get_functiondef already produces, so we can just EXECUTE `body` directly.
  EXECUTE body;
END
$mig$;
