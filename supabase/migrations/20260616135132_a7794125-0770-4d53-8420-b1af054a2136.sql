
-- 1) Drop dependent views, retype column, recreate views

DROP VIEW IF EXISTS public.unified_patient_view;
DROP VIEW IF EXISTS public.fhir_export_view;

ALTER TABLE public.lab_results
  ALTER COLUMN result_value TYPE text USING result_value::text;

-- Recreate fhir_export_view (lab_results.result_value passed through as-is to valueQuantity.value;
-- jsonb_build_object accepts text and clients tolerate non-numeric values).
CREATE VIEW public.fhir_export_view AS
WITH fhir_patient AS (
  SELECT patients.mrn,
    jsonb_build_object(
      'resourceType', 'Patient',
      'id', patients.id,
      'active', true,
      'identifier', jsonb_build_array(jsonb_build_object('use','official','system','http://spehr.local/mrn','value', patients.mrn)),
      'name', jsonb_build_array(jsonb_build_object('use','official','family', patients.last_name,'given', jsonb_build_array(patients.first_name))),
      'gender',
        CASE
          WHEN lower(patients.gender) = ANY (ARRAY['m','male']) THEN 'male'
          WHEN lower(patients.gender) = ANY (ARRAY['f','female']) THEN 'female'
          WHEN lower(patients.gender) = 'other' THEN 'other'
          ELSE 'unknown'
        END,
      'birthDate', COALESCE(patients.dob::text, NULL),
      'extension', jsonb_build_array(
        jsonb_build_object('url','http://spehr.local/fhir/StructureDefinition/encounter-status','valueString', patients.status),
        jsonb_build_object('url','http://spehr.local/fhir/StructureDefinition/standardized-output','valueJson', patients.standardized_output)
      )
    ) AS resource_json
  FROM patients
),
fhir_meds AS (
  SELECT mrn,
    jsonb_agg(jsonb_build_object(
      'resourceType','MedicationRequest',
      'id', id,
      'status', lower(COALESCE(status,'active')),
      'intent','order',
      'subject', jsonb_build_object('reference','Patient/'||mrn),
      'medicationCodeableConcept', jsonb_build_object('coding', jsonb_build_array(jsonb_build_object('display', COALESCE(drug_name, medication_name, drug)))),
      'dosageInstruction', jsonb_build_array(jsonb_build_object('text', (dose||' ')||COALESCE(route,'')))
    )) AS meds_array
  FROM medication_orders
  GROUP BY mrn
),
fhir_labs AS (
  SELECT mrn,
    jsonb_agg(jsonb_build_object(
      'resourceType','Observation',
      'id', id,
      'status','final',
      'category', jsonb_build_array(jsonb_build_object('coding', jsonb_build_array(jsonb_build_object('system','http://terminology.hl7.org/CodeSystem/observation-category','code','laboratory')))),
      'code', jsonb_build_object('coding', jsonb_build_array(jsonb_build_object('display', test_name))),
      'subject', jsonb_build_object('reference','Patient/'||mrn),
      'valueQuantity', jsonb_build_object('value', result_value, 'unit', unit),
      'interpretation', jsonb_build_array(jsonb_build_object('coding', jsonb_build_array(jsonb_build_object('code',
        CASE WHEN flag='HIGH' THEN 'H' WHEN flag='LOW' THEN 'L' ELSE 'N' END,
        'display', flag)))),
      'effectiveDateTime', time_drawn
    )) AS labs_array
  FROM lab_results
  GROUP BY mrn
)
SELECT p.mrn,
  jsonb_build_object(
    'resourceType','Bundle',
    'type','searchset',
    'total', 1 + COALESCE(jsonb_array_length(m.meds_array),0) + COALESCE(jsonb_array_length(l.labs_array),0),
    'entry', (jsonb_build_array(p.resource_json) || COALESCE(m.meds_array,'[]'::jsonb)) || COALESCE(l.labs_array,'[]'::jsonb)
  ) AS fhir_bundle
FROM fhir_patient p
LEFT JOIN fhir_meds m ON p.mrn = m.mrn
LEFT JOIN fhir_labs l ON p.mrn = l.mrn;

GRANT SELECT ON public.fhir_export_view TO authenticated;
GRANT ALL    ON public.fhir_export_view TO service_role;

CREATE VIEW public.unified_patient_view AS
WITH patient_meds AS (
  SELECT mrn,
    jsonb_agg(jsonb_build_object(
      'drug_name', COALESCE(drug_name, medication_name, drug),
      'dosage', dose,
      'route', route,
      'status', status,
      'administered_at', administered_at
    )) AS meds_list
  FROM medication_orders GROUP BY mrn
),
patient_labs AS (
  SELECT mrn,
    jsonb_agg(jsonb_build_object(
      'test_name', test_name,
      'value', result_value,
      'unit', unit,
      'status', flag,
      'reported_at', time_drawn
    )) AS labs_list
  FROM lab_results GROUP BY mrn
)
SELECT p.mrn,
  jsonb_build_object(
    'mrn', p.mrn,
    'patient_id', p.id,
    'first_name', p.first_name,
    'last_name', p.last_name,
    'birth_date', p.dob,
    'gender', p.gender,
    'medications', COALESCE(m.meds_list,'[]'::jsonb),
    'lab_observations', COALESCE(l.labs_list,'[]'::jsonb)
  ) AS unified_bundle
FROM patients p
LEFT JOIN patient_meds m ON p.mrn = m.mrn
LEFT JOIN patient_labs l ON p.mrn = l.mrn;

GRANT SELECT ON public.unified_patient_view TO authenticated;
GRANT ALL    ON public.unified_patient_view TO service_role;

-- 2) patients.gender: backfill, default, NOT NULL, FHIR-compliant CHECK
UPDATE public.patients SET gender = 'unknown'
 WHERE gender IS NULL OR btrim(gender) = '';
UPDATE public.patients SET gender = 'male'    WHERE LOWER(btrim(gender)) IN ('m','male');
UPDATE public.patients SET gender = 'female'  WHERE LOWER(btrim(gender)) IN ('f','female');
UPDATE public.patients SET gender = 'other'   WHERE LOWER(btrim(gender)) IN ('o','other');
UPDATE public.patients SET gender = 'unknown'
 WHERE LOWER(btrim(gender)) NOT IN ('male','female','other','unknown');

ALTER TABLE public.patients ALTER COLUMN gender SET DEFAULT 'unknown';
ALTER TABLE public.patients ALTER COLUMN gender SET NOT NULL;

ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_gender_fhir_chk;
ALTER TABLE public.patients
  ADD CONSTRAINT patients_gender_fhir_chk
  CHECK (LOWER(gender) IN ('male','female','other','unknown'));

-- 3) FHIR sync via pg_net -> fhir-sync edge function
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.notify_fhir_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  edge_url text := 'https://fjncfbqwyrenoavhkvdr.supabase.co/functions/v1/fhir-sync';
  payload  jsonb;
BEGIN
  payload := jsonb_build_object(
    'type',       TG_OP,
    'table',      TG_TABLE_NAME,
    'schema',     TG_TABLE_SCHEMA,
    'record',     CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END,
    'old_record', CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END
  );

  PERFORM net.http_post(
    url     := edge_url,
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := payload
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fhir-sync dispatch failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_fhir_sync_patients ON public.patients;
CREATE TRIGGER trg_fhir_sync_patients
AFTER INSERT OR UPDATE ON public.patients
FOR EACH ROW EXECUTE FUNCTION public.notify_fhir_sync();

DROP TRIGGER IF EXISTS trg_fhir_sync_medication_orders ON public.medication_orders;
CREATE TRIGGER trg_fhir_sync_medication_orders
AFTER INSERT OR UPDATE ON public.medication_orders
FOR EACH ROW EXECUTE FUNCTION public.notify_fhir_sync();

DROP TRIGGER IF EXISTS trg_fhir_sync_lab_results ON public.lab_results;
CREATE TRIGGER trg_fhir_sync_lab_results
AFTER INSERT OR UPDATE ON public.lab_results
FOR EACH ROW EXECUTE FUNCTION public.notify_fhir_sync();
