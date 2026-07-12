-- Auto-report pending radiology orders (mirrors ghost/lab auto-result cadence).
-- Flips radiology_orders.status from 'ordered'/'pending' to 'Reported' with a
-- deterministic impression + report_text if none exists, so the new Radiology
-- Workspace's completed feed populates from real CPOE activity.

CREATE OR REPLACE FUNCTION public.auto_report_pending_radiology_orders()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_impression TEXT;
  v_report TEXT;
BEGIN
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
$$;

GRANT EXECUTE ON FUNCTION public.auto_report_pending_radiology_orders() TO anon, authenticated, service_role;

-- Schedule (idempotent)
DO $$
BEGIN
  PERFORM cron.unschedule('auto_report_radiology_job');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule('auto_report_radiology_job', '* * * * *', $$SELECT public.auto_report_pending_radiology_orders();$$);