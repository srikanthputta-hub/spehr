-- Bug 1 (CRITICAL, patient-safety), follow-up to #26
-- (20260928120000_sweep_respect_automation_flag.sql):
--
-- PR #26 wrapped the medication_orders force-advance blocks of
-- sweep_stalled_clinical_orders() in `IF automation_on THEN ... END IF;`,
-- but the guard's END IF closed BEFORE the two lab_orders blocks in the
-- same function:
--   1. UPDATE lab_orders SET status='Processing' ... (elapsed >= 30s)
--   2. A loop over PROCESSING lab_orders (elapsed >= 90s) that calls
--      resolve_simulated_lab_result() and force-sets status='Reported'
--      with fabricated result data.
-- Both ran unconditionally every minute (cron `* * * * *`) regardless of
-- system_settings.automation_enabled, contradicting lab-board.tsx's own
-- "MANUAL APPROVAL MODE — AI engines are OFF ... A tech must manually
-- collect, run, and result every order" banner (rendered whenever
-- !automationEnabled). Labs were being auto-processed and auto-resulted
-- with fabricated data even while the UI told techs the AI engines were
-- off.
--
-- Fix: extend the same `automation_on` guard already read at the top of
-- the function to also wrap these two lab_orders blocks, mirroring
-- exactly how the medication_orders blocks are guarded.
--
-- Second, smaller fix bundled here: when the sweep auto-finalizes a lab
-- order (now only possible when automation is ON), it never set
-- patients.unread_labs_alert = true, unlike the tech's own manual
-- submitReport() path in lab-board.tsx, which does set that flag on every
-- official report. That meant automation-driven lab results silently
-- skipped the RN/physician notification. This migration sets that same
-- flag from both auto-finalize branches of the sweep.

CREATE OR REPLACE FUNCTION public.sweep_stalled_clinical_orders()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  alert_row RECORD;
  decision text;
  physician_name text;
  orig_order RECORD;
  now_iso timestamptz := now();
  score int;
  reason_text text;
  alt_drug_name text;
  alt_dose text;
  alt_route text;
  alt_freq text;
  alt_rxnorm text;
  alt_rxnorm_display text;
  src_drug text;
  lab_row RECORD;
  lr RECORD;
  automation_on boolean;
BEGIN
  SELECT COALESCE(automation_enabled, true) INTO automation_on
  FROM system_settings
  WHERE id = 1;

  IF automation_on IS NULL THEN
    automation_on := true;
  END IF;

  IF automation_on THEN
    UPDATE medication_orders mo
       SET status = 'Pending Verification',
           approved_at = COALESCE(mo.approved_at, now_iso),
           updated_at = now_iso
     WHERE upper(mo.status) IN ('ORDERED')
       AND mo.created_at < now_iso - interval '30 seconds'
       AND NOT EXISTS (
         SELECT 1 FROM clinical_safety_alerts a
          WHERE a.medication_order_id = mo.id
            AND a.status = 'Pending Review'
       );

    UPDATE medication_orders mo
       SET status = 'Dispensed',
           dispensed_at = COALESCE(mo.dispensed_at, now_iso),
           updated_at = now_iso
     WHERE upper(mo.status) IN ('PENDING VERIFICATION', 'PENDING_VERIFICATION', 'PENDING_PHARMACY', 'PENDING')
       AND mo.created_at < now_iso - interval '45 seconds'
       AND NOT EXISTS (
         SELECT 1 FROM clinical_safety_alerts a
          WHERE a.medication_order_id = mo.id
            AND a.status = 'Pending Review'
       );

    UPDATE medication_orders mo
       SET status = 'Administered',
           administered_at = COALESCE(mo.administered_at, now_iso),
           updated_at = now_iso
     WHERE upper(mo.status) IN ('DISPENSED')
       AND mo.created_at < now_iso - interval '90 seconds'
       AND NOT EXISTS (
         SELECT 1 FROM clinical_safety_alerts a
          WHERE a.medication_order_id = mo.id
            AND a.status = 'Pending Review'
       );
  END IF;

  IF automation_on THEN
    UPDATE lab_orders
       SET status = 'Processing',
           collected_at = COALESCE(collected_at, now_iso)
     WHERE upper(status) IN ('ORDERED', 'PENDING COLLECTION')
       AND created_at < now_iso - interval '30 seconds';

    FOR lab_row IN
      SELECT * FROM lab_orders
      WHERE upper(status) = 'PROCESSING'
        AND created_at < now_iso - interval '90 seconds'
    LOOP
      SELECT * INTO lr FROM resolve_simulated_lab_result(lab_row.test_type);
      IF lr.loinc_code IS NOT NULL THEN
        UPDATE lab_orders SET
          status = 'Reported',
          resulted_at = COALESCE(resulted_at, now_iso),
          result_value = COALESCE(result_value, lr.analyte || ': ' || lr.value_num || ' ' || lr.unit || ' [' || lr.flag || ', ref ' || lr.reference_range || '] — auto-finalized by workflow sweep'),
          loinc_code = COALESCE(loinc_code, lr.loinc_code),
          loinc_display = COALESCE(loinc_display, lr.loinc_display),
          coding_source = COALESCE(coding_source, 'protocol'),
          coded_at = COALESCE(coded_at, now_iso),
          results_data = COALESCE(results_data, jsonb_build_array(jsonb_build_object(
            'test', lr.analyte, 'name', lr.analyte, 'analyte', lr.analyte,
            'value', lr.value_num, 'unit', lr.unit, 'flag', lr.flag,
            'reference', lr.reference_range, 'range', lr.reference_range, 'referenceRange', lr.reference_range,
            'loinc', lr.loinc_code
          )))
        WHERE id = lab_row.id;
      ELSE
        UPDATE lab_orders SET
          status = 'Reported',
          resulted_at = now_iso,
          result_value = COALESCE(result_value, lab_row.test_type || ': finalized by workflow sweep — structured value pending terminology mapping')
        WHERE id = lab_row.id;
      END IF;

      -- Match the manual submitReport() path in lab-board.tsx: every
      -- official report (whether posted by a tech or auto-finalized here)
      -- must flip patients.unread_labs_alert so the RN/physician is
      -- notified. Previously only the manual path did this.
      UPDATE patients
         SET unread_labs_alert = true
       WHERE mrn = lab_row.patient_mrn;
    END LOOP;
  END IF;

  FOR alert_row IN
    SELECT * FROM clinical_safety_alerts
    WHERE status = 'Pending Review'
      AND now_iso >= COALESCE(auto_resolve_at, created_at + interval '45 seconds')
    ORDER BY created_at
  LOOP
    score := COALESCE(alert_row.risk_score, 50);
    decision := CASE WHEN score >= 50 THEN 'Rejected' ELSE 'Overridden' END;

    SELECT ordering_physician INTO physician_name
    FROM medication_orders WHERE id = alert_row.medication_order_id;
    physician_name := COALESCE(physician_name, 'Attending Physician');

    reason_text := 'Risk score ' || score || '/100 (threshold: score >= 50 = auto-Reject, < 50 = auto-Override) -> '
      || decision || '. [SLA auto-resolved on behalf of ' || physician_name || ' — 45s review window expired] '
      || COALESCE(alert_row.family, alert_row.kind, 'Safety alert');

    UPDATE clinical_safety_alerts
    SET status = decision,
        decided_by = 'AI Safety Engine (Auto-SLA)',
        decided_at = now_iso,
        rationale = reason_text,
        resolved_by = 'AI Safety Engine (Auto-SLA)',
        resolution_rationale = reason_text,
        updated_at = now_iso
    WHERE id = alert_row.id
      AND status = 'Pending Review';

    IF FOUND AND alert_row.medication_order_id IS NOT NULL THEN
      SELECT * INTO orig_order FROM medication_orders WHERE id = alert_row.medication_order_id;

      IF decision = 'Rejected' THEN
        UPDATE medication_orders SET status = 'REJECTED_SAFETY_ALERT', updated_at = now_iso
        WHERE id = alert_row.medication_order_id;

        IF orig_order.id IS NOT NULL THEN
          src_drug := lower(COALESCE(orig_order.drug_name, orig_order.medication_name, ''));

          IF src_drug ~ 'penicillin|amoxicillin|ampicillin|piperacillin|oxacillin|nafcillin|dicloxacillin' THEN
            alt_drug_name := 'Azithromycin';
            alt_dose := '500 mg'; alt_route := 'PO'; alt_freq := 'Daily';
            alt_rxnorm := '1298839'; alt_rxnorm_display := 'azithromycin monohydrate';
          ELSIF src_drug ~ 'cefazolin|ceftriaxone|cefepime|cephalexin|cefuroxime|cefdinir' THEN
            alt_drug_name := 'Azithromycin';
            alt_dose := '500 mg'; alt_route := 'PO'; alt_freq := 'Daily';
            alt_rxnorm := '1298839'; alt_rxnorm_display := 'azithromycin monohydrate';
          ELSIF src_drug ~ 'sulfamethoxazole|sulfa|trimethoprim' THEN
            alt_drug_name := 'Nitrofurantoin';
            alt_dose := '100 mg'; alt_route := 'PO'; alt_freq := 'BID';
            alt_rxnorm := '7454'; alt_rxnorm_display := 'nitrofurantoin';
          ELSE
            alt_drug_name := COALESCE(orig_order.drug_name, orig_order.medication_name, 'Alternate Agent');
            alt_dose := orig_order.dose; alt_route := orig_order.route; alt_freq := orig_order.frequency;
            alt_rxnorm := orig_order.rxnorm_code; alt_rxnorm_display := orig_order.rxnorm_display;
          END IF;

          -- Wrapped in a sub-block so a unique_violation on the partial
          -- inflight index (patient already has a non-Administered order
          -- for this substitute drug) is caught and skipped instead of
          -- rolling back the entire sweep transaction.
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM medication_orders
              WHERE coding_source = 'safety-substitution-sweep'
                AND patient_mrn = COALESCE(orig_order.patient_mrn, orig_order.mrn, alert_row.mrn)
                AND drug_name = alt_drug_name
                AND created_at > now_iso - interval '2 minutes'
            ) THEN
              INSERT INTO medication_orders (
                patient_mrn, mrn, patient_name, facility_name, drug_name, medication_name,
                dose, route, frequency, status, ordering_physician, coding_source, term_status, created_by_type,
                rxnorm_code, rxnorm_display, rxnorm_tty, coded_at
              ) VALUES (
                COALESCE(orig_order.patient_mrn, orig_order.mrn, alert_row.mrn),
                COALESCE(orig_order.mrn, alert_row.mrn),
                orig_order.patient_name,
                orig_order.facility_name,
                alt_drug_name,
                alt_drug_name,
                alt_dose, alt_route, alt_freq,
                'PENDING_PHARMACY',
                physician_name,
                'safety-substitution-sweep',
                'Auto-substituted ' || alt_drug_name || ' in place of rejected ' || COALESCE(orig_order.drug_name, orig_order.medication_name, 'medication') || ' (allergy/interaction conflict)',
                'automation',
                alt_rxnorm, alt_rxnorm_display,
                CASE WHEN alt_rxnorm IS NOT NULL THEN 'IN' ELSE NULL END,
                CASE WHEN alt_rxnorm IS NOT NULL THEN now_iso ELSE NULL END
              );
            END IF;
          EXCEPTION
            WHEN unique_violation THEN
              -- Substitute order for this patient+drug is already in flight;
              -- nothing to do. Do not abort the rest of the sweep.
              NULL;
          END;
        END IF;
      ELSE
        UPDATE medication_orders SET status = 'PENDING_PHARMACY', updated_at = now_iso
        WHERE id = alert_row.medication_order_id;
      END IF;

      INSERT INTO cds_overrides (mrn, alert_type, severity, drug_name, condition_name, reason, physician_name, fired_at, decision, patient_name, facility_name, risk_score)
      VALUES (
        alert_row.mrn, alert_row.kind, COALESCE(alert_row.severity,'high'), alert_row.drug,
        CASE WHEN alert_row.kind = 'Drug-Drug' THEN alert_row.drug_b ELSE alert_row.allergy_name END,
        reason_text,
        physician_name, now_iso, decision,
        alert_row.patient_name, alert_row.facility_name, score
      );
    END IF;
  END LOOP;
END;
$function$
;
