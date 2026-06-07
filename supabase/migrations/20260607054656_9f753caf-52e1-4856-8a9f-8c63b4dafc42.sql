
-- One-time cleanup: collapse duplicate in-flight orders created within the same minute.
WITH dupes AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY patient_mrn, COALESCE(medication_name, drug_name),
                        date_trunc('minute', created_at)
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM public.medication_orders
  WHERE patient_mrn IS NOT NULL
)
DELETE FROM public.medication_orders m
USING dupes d
WHERE m.id = d.id AND d.rn > 1;

WITH dupes AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY patient_mrn, test_type, date_trunc('minute', created_at)
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM public.lab_orders
  WHERE patient_mrn IS NOT NULL
)
DELETE FROM public.lab_orders l
USING dupes d
WHERE l.id = d.id AND d.rn > 1;

-- Partial unique indexes: prevent two concurrent tabs from seeding the same
-- (patient, drug) combination while an order for that combination is still
-- in flight. Once the order reaches the terminal state ("Administered" for
-- meds, "Reported"/"Resulted"/"Completed" for labs) the row drops out of
-- the index and a fresh re-order of the same drug becomes legal again.
CREATE UNIQUE INDEX IF NOT EXISTS medication_orders_inflight_unique
  ON public.medication_orders (patient_mrn, COALESCE(medication_name, drug_name))
  WHERE patient_mrn IS NOT NULL
    AND status IS DISTINCT FROM 'Administered';

CREATE UNIQUE INDEX IF NOT EXISTS lab_orders_inflight_unique
  ON public.lab_orders (patient_mrn, test_type)
  WHERE patient_mrn IS NOT NULL
    AND status NOT IN ('Reported', 'Resulted', 'Completed');
