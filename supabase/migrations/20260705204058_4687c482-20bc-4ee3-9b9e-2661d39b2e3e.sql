-- Add fhir_id to appointments + payment_notices for inbound upsert matching
ALTER TABLE public.fhir_appointments ADD COLUMN IF NOT EXISTS fhir_id text;
CREATE UNIQUE INDEX IF NOT EXISTS fhir_appointments_fhir_id_key
  ON public.fhir_appointments(fhir_id) WHERE fhir_id IS NOT NULL;

ALTER TABLE public.fhir_payment_notices ADD COLUMN IF NOT EXISTS fhir_id text;
CREATE UNIQUE INDEX IF NOT EXISTS fhir_payment_notices_fhir_id_key
  ON public.fhir_payment_notices(fhir_id) WHERE fhir_id IS NOT NULL;

-- Auto-balance invoice when a paid PaymentNotice lands
CREATE OR REPLACE FUNCTION public.apply_payment_notice_to_invoice()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
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
           updated_at = now()
     WHERE id = NEW.invoice_id
       AND status <> 'balanced';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_notice_balance_invoice ON public.fhir_payment_notices;
CREATE TRIGGER trg_payment_notice_balance_invoice
  AFTER INSERT ON public.fhir_payment_notices
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_payment_notice_to_invoice();