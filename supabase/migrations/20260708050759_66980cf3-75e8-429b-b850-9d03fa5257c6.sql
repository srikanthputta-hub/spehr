CREATE OR REPLACE FUNCTION public.sweep_stalled_clinical_orders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  src_drug text;
BEGIN
  -- ------------------------------------------------------------------
  -- Short-threshold cascade for server-inserted orders (ghost admits,
  -- pg_cron seeds) that no client tab is driving. The client-side
  -- cascade in useAIAutomation still owns tab-seeded orders (finishes
  -- in ~10s); this block only picks up orphans so they don't sit in
  -- Pending Verification until the 10-min force-finalize below.
  --
  -- Every step excludes rows that have an active safety hold or an
  -- unresolved clinical_safety_alerts row so allergy/interaction
  -- reviews still gate the medication before it advances.
  -- ------------------------------------------------------------------

  -- Ordered → Pending Verification (>= 30s old)
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

  -- Pending Verification / PENDING_PHARMACY → Dispensed (>= 45s old)
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

  -- Dispensed → Administered (>= 90s old)
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

  -- Labs: Ordered → Processing (>= 30s), Processing → Reported (>= 90s)
  UPDATE lab_orders
     SET status = 'Processing',
         collected_at = COALESCE(collected_at, now_iso)
   WHERE upper(status) IN ('ORDERED', 'PENDING COLLECTION')
     AND created_at < now_iso - interval '30 seconds';

  UPDATE lab_orders
     SET status = 'Reported',
         resulted_at = COALESCE(resulted_at, now_iso),
         result_value = COALESCE(result_value, 'WBC: 7.8 k/uL, Hgb: 13.9 g/dL, Plt: 240 k/uL [WNL] — auto-finalized by workflow sweep')
   WHERE upper(status) IN ('PROCESSING')
     AND created_at < now_iso - interval '90 seconds';

  -- ------------------------------------------------------------------
  -- Existing safety-alert SLA loop (unchanged)
  -- ------------------------------------------------------------------
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
          ELSIF src_drug ~ 'cefazolin|ceftriaxone|cefepime|cephalexin|cefuroxime|cefdinir' THEN
            alt_drug_name := 'Azithromycin';
            alt_dose := '500 mg'; alt_route := 'PO'; alt_freq := 'Daily';
          ELSIF src_drug ~ 'sulfamethoxazole|sulfa|trimethoprim' THEN
            alt_drug_name := 'Nitrofurantoin';
            alt_dose := '100 mg'; alt_route := 'PO'; alt_freq := 'BID';
          ELSE
            alt_drug_name := COALESCE(orig_order.drug_name, orig_order.medication_name, 'Alternate Agent');
            alt_dose := orig_order.dose; alt_route := orig_order.route; alt_freq := orig_order.frequency;
          END IF;

          IF NOT EXISTS (
            SELECT 1 FROM medication_orders
            WHERE coding_source = 'safety-substitution-sweep'
              AND patient_mrn = COALESCE(orig_order.patient_mrn, orig_order.mrn, alert_row.mrn)
              AND drug_name = alt_drug_name
              AND created_at > now_iso - interval '2 minutes'
          ) THEN
            INSERT INTO medication_orders (
              patient_mrn, mrn, patient_name, facility_name, drug_name, medication_name,
              dose, route, frequency, status, ordering_physician, coding_source, term_status, created_by_type
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
              'automation'
            );
          END IF;
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

  -- ------------------------------------------------------------------
  -- Final safety net: force-finalize anything still stuck after 10 min
  -- ------------------------------------------------------------------
  UPDATE medication_orders
  SET status = 'Administered', administered_at = now_iso, updated_at = now_iso
  WHERE created_at < now_iso - interval '10 minutes'
    AND upper(status) IN (
      'ORDERED', 'PENDING', 'PENDING VERIFICATION', 'PENDING_VERIFICATION',
      'PENDING_PHARMACY', 'DISPENSED', 'DUE'
    );

  UPDATE medication_orders mo
  SET status = 'PENDING_PHARMACY', updated_at = now_iso
  WHERE mo.status = 'HELD_SAFETY_REVIEW'
    AND mo.created_at < now_iso - interval '5 minutes'
    AND NOT EXISTS (
      SELECT 1 FROM clinical_safety_alerts a
      WHERE a.medication_order_id = mo.id AND a.status = 'Pending Review'
    );

  UPDATE lab_orders
  SET status = 'Reported',
      resulted_at = now_iso,
      result_value = COALESCE(result_value, 'WBC: 7.8 k/uL, Hgb: 13.9 g/dL, Plt: 240 k/uL [WNL] — auto-finalized by workflow sweep')
  WHERE created_at < now_iso - interval '10 minutes'
    AND upper(status) IN ('ORDERED', 'PROCESSING', 'PENDING COLLECTION');
END;
$function$;