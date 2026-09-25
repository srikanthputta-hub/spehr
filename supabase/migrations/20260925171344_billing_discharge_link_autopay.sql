-- Phase A: link fhir_invoices to the discharge event that produced them,
-- distinguish real patient-portal payments from the 3h-timeout auto-pay,
-- and give the finance dashboard/FHIR feed a durable payment_origin.
--
-- Live-schema notes (checked via mcp__Supabase__execute_sql /
-- list_tables on qxyvmvtecnnwqeqaouzh before writing this):
--  * fhir_invoices / fhir_payment_notices / system_settings / patients /
--    fhir_sync_state columns match what this migration assumes.
--  * fhir_payment_notices already carries a BEFORE INSERT trigger named
--    `trg_payment_notice_balance_invoice` wired to
--    apply_payment_notice_to_invoice() — CREATE OR REPLACE-ing the
--    function body below is enough; the existing trigger picks it up,
--    no need to re-create/rename the trigger.
--  * apply_payment_notice_to_invoice()'s live body (pulled via
--    pg_get_functiondef) is reproduced below with ONLY the
--    payment_origin propagation added — everything else (is_paid
--    detection via NEW.status or payload.paymentStatus.coding,
--    paid_at coalesce, status <> 'balanced' guard) is preserved as-is.
--  * fhir_sync_state already has a `paymentnotice_last_polled_at` key
--    (written by the existing PaymentNotice inbound poller), so
--    auto_pay_overdue_invoices() reading it below is safe.
--  * Cron re-scheduling convention in this repo (see
--    20260925153917_fix_outbound_poller_starvation_and_cadence.sql) is a
--    plain `cron.unschedule(name)` + `cron.schedule(...)` pair. Since
--    'auto-pay-overdue-invoices-5min' is a brand-new job name that won't
--    exist yet, and cron.unschedule() raises if the job is absent, this
--    is wrapped in a DO block that unschedules only if a same-named job
--    already exists (idempotent / re-runnable, per the plan).

ALTER TABLE public.fhir_invoices
  ADD COLUMN IF NOT EXISTS discharged_at  timestamptz,
  ADD COLUMN IF NOT EXISTS payment_origin text
    CHECK (payment_origin IS NULL OR payment_origin IN
      ('patient-portal','auto-pay-timeout','staff','billing-pophealth'));

ALTER TABLE public.fhir_payment_notices
  ADD COLUMN IF NOT EXISTS payment_origin text,
  ADD COLUMN IF NOT EXISTS fhir_pushed_at timestamptz;

-- Backfill discharged_at from patients.discharge_time for existing invoices.
UPDATE public.fhir_invoices i SET discharged_at = p.discharge_time
  FROM public.patients p
 WHERE p.mrn = i.mrn AND i.discharged_at IS NULL AND p.discharge_time IS NOT NULL;

-- Backfill payment_origin on existing payment notices from their FHIR tag.
UPDATE public.fhir_payment_notices SET payment_origin = CASE
    WHEN payload->'meta'->'tag' @> '[{"code":"myspehr"}]'           THEN 'patient-portal'
    WHEN payload->'meta'->'tag' @> '[{"code":"billing-pophealth"}]' THEN 'billing-pophealth'
    ELSE 'staff' END
 WHERE payment_origin IS NULL;

-- Propagate onto already-balanced invoices.
UPDATE public.fhir_invoices i SET payment_origin = n.payment_origin
  FROM public.fhir_payment_notices n
 WHERE n.invoice_id = i.id AND i.status = 'balanced' AND i.payment_origin IS NULL;

CREATE INDEX IF NOT EXISTS idx_fhir_invoices_autopay        ON public.fhir_invoices (discharged_at) WHERE status = 'issued';
CREATE INDEX IF NOT EXISTS idx_fhir_invoices_mrn_discharged ON public.fhir_invoices (mrn, discharged_at);
CREATE INDEX IF NOT EXISTS idx_fhir_payment_notices_invoice ON public.fhir_payment_notices (invoice_id);

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS autopay_after_minutes int NOT NULL DEFAULT 180;

-- Auto-tag any payment notice inserted without an explicit payment_origin
-- (covers direct SQL/manual inserts; the normal code paths set it themselves).
CREATE OR REPLACE FUNCTION public.set_payment_notice_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.payment_origin IS NULL THEN
    NEW.payment_origin := CASE
      WHEN NEW.payload->'meta'->'tag' @> '[{"code":"myspehr"}]'           THEN 'patient-portal'
      WHEN NEW.payload->'meta'->'tag' @> '[{"code":"billing-pophealth"}]' THEN 'billing-pophealth'
      ELSE 'staff' END;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payment_notice_origin ON public.fhir_payment_notices;
CREATE TRIGGER trg_payment_notice_origin BEFORE INSERT ON public.fhir_payment_notices
  FOR EACH ROW EXECUTE FUNCTION public.set_payment_notice_origin();

-- CREATE OR REPLACE of the live apply_payment_notice_to_invoice() body
-- (pulled via pg_get_functiondef before writing this migration), with only
-- payment_origin propagation added. All existing behavior preserved:
-- is_paid detection via NEW.status OR payload.paymentStatus.coding, the
-- paid_at COALESCE, and the `status <> 'balanced'` guard.
CREATE OR REPLACE FUNCTION public.apply_payment_notice_to_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  is_paid boolean := false;
  coded_status text;
BEGIN
  IF lower(coalesce(NEW.status, '')) = 'paid' THEN
    is_paid := true;
  END IF;

  IF NOT is_paid AND NEW.payload IS NOT NULL THEN
    SELECT lower(c->>'code') INTO coded_status
    FROM jsonb_array_elements(
      coalesce(NEW.payload->'paymentStatus'->'coding', '[]'::jsonb)
    ) AS c
    WHERE lower(c->>'code') = 'paid'
    LIMIT 1;
    IF coded_status = 'paid' THEN is_paid := true; END IF;
  END IF;

  IF is_paid AND NEW.invoice_id IS NOT NULL THEN
    UPDATE public.fhir_invoices
       SET status = 'balanced',
           paid_at = COALESCE(paid_at, NEW.payment_date, now()),
           payment_origin = COALESCE(payment_origin, NEW.payment_origin),
           updated_at = now()
     WHERE id = NEW.invoice_id
       AND status <> 'balanced';
  END IF;

  RETURN NEW;
END;
$function$;

-- Auto-pay any `issued` invoice whose discharge (or fallback: issued_at)
-- is older than autopay_after_minutes and that has no existing paid
-- payment notice. Runs every 5 minutes via pg_cron.
CREATE OR REPLACE FUNCTION public.auto_pay_overdue_invoices(p_limit int DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  grace   interval := make_interval(mins => COALESCE(
             (SELECT autopay_after_minutes FROM system_settings WHERE id = 1), 180));
  poll_ts timestamptz;
  r record; n int := 0; pn_id text;
BEGIN
  IF (SELECT automation_enabled FROM system_settings WHERE id = 1) = false THEN
    RETURN jsonb_build_object('skipped','automation_disabled');
  END IF;
  SELECT (value->>'ts')::timestamptz INTO poll_ts
    FROM fhir_sync_state WHERE key = 'paymentnotice_last_polled_at';

  FOR r IN
    SELECT i.id, i.invoice_no, i.mrn, i.total, i.currency, i.facility_name,
           COALESCE(i.discharged_at, p.discharge_time, i.issued_at) AS d_at
      FROM fhir_invoices i
      LEFT JOIN patients p ON p.mrn = i.mrn
     WHERE i.status = 'issued'
       AND COALESCE(i.discharged_at, p.discharge_time, i.issued_at) + grace <= now()
       AND ( poll_ts >= COALESCE(i.discharged_at, p.discharge_time, i.issued_at) + grace
             OR COALESCE(i.discharged_at, p.discharge_time, i.issued_at) + grace
                + interval '30 minutes' <= now() )
       AND NOT EXISTS (SELECT 1 FROM fhir_payment_notices n
                        WHERE n.invoice_id = i.id AND lower(n.status) = 'paid')
     ORDER BY 7
     LIMIT p_limit
     FOR UPDATE OF i SKIP LOCKED
  LOOP
    pn_id := 'spehr-autopay-' || r.invoice_no;
    INSERT INTO fhir_payment_notices
      (fhir_id, invoice_id, mrn, amount, currency, status, payment_date,
       payment_method, payment_origin, payload)
    VALUES (pn_id, r.id, r.mrn, r.total, r.currency, 'paid', now(),
      'Auto-pay on file (no portal payment within 3h of discharge)', 'auto-pay-timeout',
      jsonb_build_object(
        'resourceType','PaymentNotice','id',pn_id,'status','active',
        'meta', jsonb_build_object('tag', jsonb_build_array(
            jsonb_build_object('system','urn:spehr:source','code','spehr'),
            jsonb_build_object('system','urn:spehr:payment-origin','code','auto-pay-timeout'))),
        'extension', jsonb_build_array(jsonb_build_object(
            'url','urn:spehr:payment-origin','valueCode','auto-pay-timeout')),
        'request', jsonb_build_object('reference','Invoice/' || r.invoice_no),
        'created', to_char(now() AT TIME ZONE 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'payment', jsonb_build_object('display','Auto-pay after 3h portal timeout'),
        'recipient', jsonb_build_object('display', coalesce(r.facility_name,'S.P.E.H.R.')),
        'amount', jsonb_build_object('value', r.total, 'currency', r.currency),
        'paymentStatus', jsonb_build_object('coding', jsonb_build_array(jsonb_build_object(
            'system','http://terminology.hl7.org/CodeSystem/paymentstatus',
            'code','paid','display','Paid')))))
    ON CONFLICT (fhir_id) DO NOTHING;
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('autopaid', n, 'poll_ts', poll_ts);
END $$;
REVOKE EXECUTE ON FUNCTION public.auto_pay_overdue_invoices(int) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.discharges_missing_invoice(p_limit int DEFAULT 200)
RETURNS TABLE(mrn text, discharge_time timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.mrn, p.discharge_time FROM patients p
   WHERE lower(p.status) = 'discharged' AND p.discharge_time IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM fhir_invoices i
                      WHERE i.mrn = p.mrn
                        AND (i.discharged_at = p.discharge_time
                             OR (i.discharged_at IS NULL AND i.issued_at >= p.discharge_time)))
   ORDER BY p.discharge_time ASC
   LIMIT p_limit
$$;
REVOKE EXECUTE ON FUNCTION public.discharges_missing_invoice(int) FROM PUBLIC, anon, authenticated;

-- Idempotent (re-runnable) cron scheduling: unschedule only if a
-- same-named job already exists, matching this repo's re-scheduling
-- convention (see 20260925153917_fix_outbound_poller_starvation_and_cadence.sql)
-- while tolerating the fact that this specific job name is brand new.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-pay-overdue-invoices-5min') THEN
    PERFORM cron.unschedule('auto-pay-overdue-invoices-5min');
  END IF;
END $$;

SELECT cron.schedule('auto-pay-overdue-invoices-5min', '*/5 * * * *',
  $$SELECT public.auto_pay_overdue_invoices();$$);
