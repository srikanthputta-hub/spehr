-- auto_report_pending_radiology_orders() (cron `auto_report_radiology_job`,
-- `* * * * *`) scans up to 25 ordered/pending radiology_orders rows every
-- minute and auto-finalizes them (status='Reported', resulted_at=now(),
-- fabricated boilerplate impression/report_text) with NO minimum-age check
-- at all -- a study can be auto-reported within the same second it was
-- ordered. Verified live (rolled-back transaction, qxyvmvtecnnwqeqaouzh):
-- a freshly-inserted 0-second-old 'ordered' row was finalized by the very
-- next call.
--
-- This is inconsistent with sweep_stalled_clinical_orders()'s lab-order
-- block, which requires a lab_orders row be stuck in 'PROCESSING' for
-- > 90 seconds before auto-finalizing it, giving a human a real window to
-- intervene first. Give radiology the same kind of guard: require the
-- order's ordered_at (the column the function already orders its queue
-- by, and the one that represents when the study was actually ordered --
-- not row-insert time) to be at least 2 minutes old before the cron
-- touches it.
--
-- Verified in a second rolled-back transaction before applying this for
-- real: with the guard added, a 0-second-old row is left untouched while a
-- 5-minutes-old row is still auto-finalized once it crosses the threshold.
-- No table/column changes, no RLS changes -- purely the timing predicate
-- on the existing WHERE clause.
CREATE OR REPLACE FUNCTION public.auto_report_pending_radiology_orders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_impression TEXT;
  v_report TEXT;
  automation_on boolean;
BEGIN
  SELECT COALESCE(automation_enabled, true) INTO automation_on
  FROM public.system_settings
  WHERE id = 1;

  IF automation_on IS NULL THEN
    automation_on := true;
  END IF;

  IF NOT automation_on THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT id, exam_type, modality, body_part
    FROM public.radiology_orders
    WHERE status IN ('ordered', 'Ordered', 'ORDERED', 'pending', 'Pending', 'PENDING')
      AND resulted_at IS NULL
      AND ordered_at < now() - interval '2 minutes'
    ORDER BY ordered_at ASC
    LIMIT 25
  LOOP
    v_impression := COALESCE(
      NULLIF('No acute ' || LOWER(COALESCE(r.body_part, 'imaging')) || ' abnormality identified. Correlate clinically.', ''),
      'No acute findings. Correlate clinically.'
    );
    v_report := 'AUTOMATED PRELIMINARY READ' || E'\n\n'
      || 'Study: ' || COALESCE(r.exam_type, 'Imaging study') || E'\n'
      || 'Modality: ' || COALESCE(r.modality, 'Unspecified') || E'\n'
      || 'Body site: ' || COALESCE(r.body_part, 'Unspecified') || E'\n\n'
      || 'FINDINGS: Technically adequate examination. No acute abnormality identified within the imaged field of view. '
      || 'No fracture, mass effect, or acute inflammatory change. Osseous and soft-tissue structures are unremarkable for age.' || E'\n\n'
      || 'IMPRESSION: ' || v_impression;

    UPDATE public.radiology_orders
    SET status = 'Reported',
        resulted_at = now(),
        impression = COALESCE(NULLIF(impression, ''), v_impression),
        report_text = COALESCE(NULLIF(report_text, ''), v_report),
        updated_at = now()
    WHERE id = r.id;
  END LOOP;
END;
$function$
;
