-- Backfill rule_id from family text where possible
UPDATE public.clinical_safety_alerts
SET rule_id = substring(family from '\[([a-z0-9\-]+):')
WHERE rule_id IS NULL AND family ~ '\[[a-z0-9\-]+:';

-- Dedupe existing rows on (medication_order_id, rule_id), keep earliest
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY medication_order_id, rule_id ORDER BY created_at ASC, id ASC) AS rn
    FROM public.clinical_safety_alerts
   WHERE medication_order_id IS NOT NULL AND rule_id IS NOT NULL
)
DELETE FROM public.clinical_safety_alerts a
 USING ranked r
 WHERE a.id = r.id AND r.rn > 1;

-- Enforce uniqueness so concurrent inserts cannot create duplicate alerts
CREATE UNIQUE INDEX IF NOT EXISTS clinical_safety_alerts_med_order_rule_uniq
  ON public.clinical_safety_alerts (medication_order_id, rule_id)
  WHERE medication_order_id IS NOT NULL AND rule_id IS NOT NULL;