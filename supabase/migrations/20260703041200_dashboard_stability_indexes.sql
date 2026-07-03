CREATE INDEX IF NOT EXISTS idx_bed_management_current_patient_mrn ON public.bed_management (current_patient_mrn) WHERE current_patient_mrn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bed_management_status_updated_at ON public.bed_management (status, status_updated_at);
CREATE INDEX IF NOT EXISTS idx_patients_mrn_status ON public.patients (mrn, status);
CREATE INDEX IF NOT EXISTS idx_patients_status_mrn_admission ON public.patients (status, mrn, admission_time DESC);
