
ALTER TABLE public.clinical_safety_alerts
  ADD COLUMN IF NOT EXISTS risk_score integer,
  ADD COLUMN IF NOT EXISTS medication_order_id uuid;

CREATE INDEX IF NOT EXISTS idx_clinical_safety_alerts_med_order
  ON public.clinical_safety_alerts (medication_order_id);
