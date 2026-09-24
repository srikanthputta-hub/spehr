-- The fhir-sync/push_to_fhir notify triggers pre-date the pg_cron-driven
-- fhir-outbound-poll pipeline and were never ported correctly onto this
-- project (see the cloud handover, §11 / "Cloud health check"):
--
--   * notify_fhir_sync() → edge function `fhir-sync` never posts to the
--     upstream FHIR server at all — it only resolves fhir_export_view rows
--     and returns them. It has no auth header, so every call has been a
--     401 (34k+/day) that accomplished nothing even when it succeeded.
--   * notify_push_to_fhir() → edge function `push_to_fhir` requires a real
--     FHIR transaction Bundle ({ bundle: { resourceType: "Bundle",
--     type: "transaction" } }); the trigger sends a raw `to_jsonb(NEW)`
--     record instead, which the function has always rejected with
--     "Payload must be a FHIR Bundle of type 'transaction'". Also missing
--     its auth header (401s, 239/day).
--
-- Actual outbound sync to Medblocks for patients, medication_orders,
-- lab_orders, lab_results, radiology_orders, clinical_notes, conditions,
-- provider_notes and shift_notes is handled by the fhir-outbound-poll
-- pg_cron job's pollClinical() sweep — a strict superset of what these
-- triggers watched. Dropping them removes dead load and the 401 noise;
-- nothing downstream depended on their (nonexistent) output.

DROP TRIGGER IF EXISTS trg_fhir_sync_patients ON public.patients;
DROP TRIGGER IF EXISTS trg_fhir_sync_medication_orders ON public.medication_orders;
DROP TRIGGER IF EXISTS trg_fhir_sync_lab_results ON public.lab_results;
DROP TRIGGER IF EXISTS trg_patients_push_to_fhir ON public.patients;
