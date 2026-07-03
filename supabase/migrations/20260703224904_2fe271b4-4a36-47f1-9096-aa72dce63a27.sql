-- Retire cascade_clinical_automation: client-side useAIAutomation now advances
-- medication_orders and lab_orders through their lifecycle. The pg_cron job
-- was also failing every minute because the function referenced
-- `ordered_at`, which does not exist on medication_orders (the timestamp
-- column is `created_at`). Unschedule the cron and neutralise the function.

SELECT cron.unschedule('ghost_cascading_automation');

CREATE OR REPLACE FUNCTION public.cascade_clinical_automation()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- Retired. Medication and lab order progression is handled client-side by
  -- src/hooks/useAIAutomation.ts (cascadeMed / cascadeLab). Kept as a no-op
  -- so any lingering references do not error.
  RETURN;
END;
$function$;