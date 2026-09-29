-- Bug 2 (CRITICAL, patient-safety): auto_report_pending_radiology_orders()
-- (cron `auto_report_radiology_job`, `* * * * *`) unconditionally scanned up
-- to 25 pending radiology_orders every minute and immediately (no
-- elapsed-time delay at all) set status='Reported', resulted_at=now(), and
-- fabricated boilerplate "no acute findings" impression/report_text — with
-- no check on system_settings.automation_enabled whatsoever. This directly
-- contradicts radiology-board.tsx's "VERIFICATION MODE — AI engines are
-- OFF. Studies must be finalized manually by the radiologist" banner: live
-- data showed 88/88 radiology_orders rows already auto-finalized to
-- 'Reported', none ever sitting in an intermediate state for a human to
-- review.
--
-- Fix: gate the whole sweep on the same automation_on flag
-- sweep_stalled_clinical_orders() reads from system_settings.automation_enabled
-- (id = 1, NULL/missing defaults to true) — identical semantics to
-- useAutomationEnabled.ts on the frontend. When automation is off, this
-- function is now a no-op and pending studies stay pending until a
-- radiologist finalizes them manually (see the paired frontend change
-- adding a manual "Submit Report" action to radiology-board.tsx).

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
