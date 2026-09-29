-- Bug (CRITICAL, patient-safety), discovered while verifying #31
-- (20260929000000_sweep_lab_orders_respect_automation_flag.sql):
--
-- sweep_stalled_clinical_orders() calls
-- `SELECT * INTO lr FROM resolve_simulated_lab_result(lab_row.test_type)`
-- inside its lab-orders auto-finalize loop (PROCESSING for >90s, automation
-- ON), but `resolve_simulated_lab_result` was never created anywhere in the
-- database — `grep -rl resolve_simulated_lab_result supabase/migrations/`
-- shows only call sites (this file's included), never a matching
-- `CREATE FUNCTION`, and
-- `SELECT proname FROM pg_proc WHERE proname ILIKE '%resolve_simulated_lab%'`
-- returns zero rows across every schema. This has been a day-one gap: the
-- call has been present since 20260713142723 and was simply never noticed
-- because it only fires once a lab_orders row is actually stuck in
-- PROCESSING for 90+ seconds with automation on.
--
-- Effect: whenever that condition is met, the missing function raises
-- `42883 function resolve_simulated_lab_result(text) does not exist`,
-- which is unhandled inside sweep_stalled_clinical_orders() and aborts the
-- whole call. Because the medication_orders auto-advance blocks and the
-- clinical_safety_alerts SLA auto-resolution loop live in the very same
-- function/transaction, one stuck lab order silently blocks all three
-- automation pipelines for that cron tick (`* * * * *`), not just labs.
--
-- Fix: implement `resolve_simulated_lab_result(text)` as the server-side
-- counterpart to lab-board.tsx's `generateMockResults()` / the tech's own
-- "Run Sample (AI Autogen)" button — same test-type-keyed simulated normal
-- values (CBC Pack / Metabolic Panel CMP / Arterial Blood Gas / Cardiac
-- Troponin / Serum Lactate), LOINC-coded via the same codes used by
-- src/lib/lab-loinc-map.ts. The sweep only ever needs the deterministic
-- "not urgently abnormal" case (it is finalizing an order nobody addressed
-- in 90s, not simulating a crisis), so this returns the normal-range value
-- for the matched test_type, and an all-NULL row for anything unrecognized
-- so the caller's existing `IF lr.loinc_code IS NOT NULL` branch falls
-- through to its generic "structured value pending terminology mapping"
-- fallback exactly as it already does today for other edge cases.
--
-- Return shape matches the call site's field usage exactly:
--   lr.loinc_code, lr.loinc_display, lr.analyte, lr.value_num, lr.unit,
--   lr.flag, lr.reference_range.

CREATE OR REPLACE FUNCTION public.resolve_simulated_lab_result(p_test_type text)
 RETURNS TABLE (
   loinc_code text,
   loinc_display text,
   analyte text,
   value_num numeric,
   unit text,
   flag text,
   reference_range text
 )
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
  IF p_test_type = 'CBC Pack' THEN
    RETURN QUERY SELECT '6690-2', 'WBC count', 'WBC', 7.2::numeric, 'k/uL', 'NORMAL', '4.5–11.0';
  ELSIF p_test_type = 'Metabolic Panel CMP' THEN
    RETURN QUERY SELECT '2345-7', 'Glucose', 'Glucose', 98::numeric, 'mg/dL', 'NORMAL', '70–110';
  ELSIF p_test_type = 'Arterial Blood Gas' THEN
    RETURN QUERY SELECT '11558-4', 'pH of Arterial blood', 'pH', 7.40::numeric, '', 'NORMAL', '7.35–7.45';
  ELSIF p_test_type = 'Cardiac Troponin' THEN
    RETURN QUERY SELECT '10839-9', 'Troponin I cardiac', 'Troponin I', 0.02::numeric, 'ng/mL', 'NORMAL', '<0.04';
  ELSIF p_test_type = 'Serum Lactate' THEN
    RETURN QUERY SELECT '2519-9', 'Lactate', 'Lactate', 1.4::numeric, 'mmol/L', 'NORMAL', '0.5–2.2';
  ELSE
    RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, NULL::numeric, NULL::text, NULL::text, NULL::text;
  END IF;
END;
$function$
;
