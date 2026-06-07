
-- Finalize orphaned pharmacy and lab orders that got stranded mid-cascade
-- when the browser tab driving them was closed/refreshed.

UPDATE public.medication_orders
SET status = 'Administered',
    approved_at = COALESCE(approved_at, now()),
    dispensed_at = COALESCE(dispensed_at, now()),
    administered_at = COALESCE(administered_at, now())
WHERE status IN ('Ordered','Pending','Pending Verification','Dispensed','DUE',
                 'ORDERED','PENDING','PENDING_PHARMACY','PENDING_VERIFICATION','DISPENSED')
  AND created_at < now() - interval '90 seconds';

UPDATE public.lab_orders
SET status = 'Reported',
    collected_at = COALESCE(collected_at, now()),
    resulted_at = COALESCE(resulted_at, now())
WHERE status IN ('Ordered','Processing','Pending Collection','ORDERED','PROCESSING','Completed')
  AND created_at < now() - interval '90 seconds';
