UPDATE public.provider_notes SET updated_at = now() WHERE patient_mrn = 'MRN-NETVERIFY01';
UPDATE public.shift_notes SET updated_at = now() WHERE patient_mrn = 'MRN-NETVERIFY01';