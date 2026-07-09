-- Bump the lab_orders row so it re-enters the eligible window
update public.lab_orders
set updated_at = now()
where patient_mrn = 'MRN-316173' and loinc_code = '718-7';

-- Rewind the clinical cursor to just before the bump
update public.fhir_sync_state
set value = jsonb_build_object('ts', to_char(now() - interval '10 seconds', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"'), 'mrn', '')
where key = 'outbound_clinical_last_synced_at';