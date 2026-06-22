
-- 1) Cleanup duplicates ------------------------------------------------------

-- clinical_notes: keep earliest row per (mrn, note_type, author) for auto/system authors
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY mrn, note_type, author ORDER BY created_at ASC, id ASC) AS rn
  FROM public.clinical_notes
  WHERE author IN ('Auto Doc', 'System Auto-Generated')
)
DELETE FROM public.clinical_notes c USING ranked r
WHERE c.id = r.id AND r.rn > 1;

-- allergies: keep earliest per (mrn, substance)
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY mrn, substance ORDER BY created_at ASC, id ASC) AS rn
  FROM public.allergies
)
DELETE FROM public.allergies a USING ranked r
WHERE a.id = r.id AND r.rn > 1;

-- observations: keep earliest per (patient_id, loinc_code, source)
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY patient_id, loinc_code, source ORDER BY created_at ASC, id ASC) AS rn
  FROM public.observations
  WHERE loinc_code IS NOT NULL AND source IS NOT NULL
)
DELETE FROM public.observations o USING ranked r
WHERE o.id = r.id AND r.rn > 1;

-- medication_requests: keep earliest per (patient_id, rxnorm_code, source)
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY patient_id, rxnorm_code, source ORDER BY created_at ASC, id ASC) AS rn
  FROM public.medication_requests
  WHERE rxnorm_code IS NOT NULL AND source IS NOT NULL
)
DELETE FROM public.medication_requests m USING ranked r
WHERE m.id = r.id AND r.rn > 1;

-- fhir_resources: keep earliest per (resource_type, resource_id)
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY resource_type, resource_id ORDER BY created_at ASC, id ASC) AS rn
  FROM public.fhir_resources
  WHERE resource_id IS NOT NULL
)
DELETE FROM public.fhir_resources f USING ranked r
WHERE f.id = r.id AND r.rn > 1;

-- 2) Add unique indexes / constraints for upsert ----------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_allergies_mrn_substance
  ON public.allergies (mrn, substance);

CREATE UNIQUE INDEX IF NOT EXISTS uq_observations_patient_loinc_source
  ON public.observations (patient_id, loinc_code, source)
  WHERE loinc_code IS NOT NULL AND source IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_medreq_patient_rxnorm_source
  ON public.medication_requests (patient_id, rxnorm_code, source)
  WHERE rxnorm_code IS NOT NULL AND source IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clinical_notes_mrn_type_auto_author
  ON public.clinical_notes (mrn, note_type, author)
  WHERE author IN ('Auto Doc', 'System Auto-Generated');

-- fhir_resources already has a unique index on (resource_type, resource_id) used by
-- persist_fhir_resource() (ON CONFLICT). Ensure it exists.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fhir_resources_type_id
  ON public.fhir_resources (resource_type, resource_id);
