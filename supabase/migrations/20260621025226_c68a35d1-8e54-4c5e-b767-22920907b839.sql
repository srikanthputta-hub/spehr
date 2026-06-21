
-- FHIR R4 Billing resources: ChargeItem, Invoice, PaymentNotice
CREATE TABLE IF NOT EXISTS public.fhir_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no text NOT NULL UNIQUE,
  mrn text NOT NULL,
  patient_name text,
  encounter_id text,
  facility_name text,
  status text NOT NULL DEFAULT 'issued', -- issued | balanced | cancelled
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  tax numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  issued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, -- full FHIR Invoice resource
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fhir_invoices_mrn ON public.fhir_invoices (mrn);
CREATE INDEX IF NOT EXISTS idx_fhir_invoices_status ON public.fhir_invoices (status);
CREATE INDEX IF NOT EXISTS idx_fhir_invoices_facility ON public.fhir_invoices (facility_name);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fhir_invoices TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.fhir_invoices TO anon;
GRANT ALL ON public.fhir_invoices TO service_role;
ALTER TABLE public.fhir_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fhir_invoices read all" ON public.fhir_invoices FOR SELECT USING (true);
CREATE POLICY "fhir_invoices write all" ON public.fhir_invoices FOR INSERT WITH CHECK (true);
CREATE POLICY "fhir_invoices update all" ON public.fhir_invoices FOR UPDATE USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.fhir_charge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.fhir_invoices(id) ON DELETE CASCADE,
  mrn text NOT NULL,
  encounter_id text,
  charge_code text NOT NULL,
  code_system text NOT NULL DEFAULT 'internal', -- internal | LOINC | RxNorm | CPT
  description text NOT NULL,
  category text NOT NULL, -- room | nursing | consultation | medication | lab | admin
  quantity numeric(10,2) NOT NULL DEFAULT 1,
  unit_price numeric(10,2) NOT NULL DEFAULT 0,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  service_date timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, -- full FHIR ChargeItem resource
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fhir_charge_items_invoice ON public.fhir_charge_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_fhir_charge_items_mrn ON public.fhir_charge_items (mrn);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fhir_charge_items TO authenticated;
GRANT SELECT ON public.fhir_charge_items TO anon;
GRANT ALL ON public.fhir_charge_items TO service_role;
ALTER TABLE public.fhir_charge_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fhir_charge_items read all" ON public.fhir_charge_items FOR SELECT USING (true);
CREATE POLICY "fhir_charge_items write all" ON public.fhir_charge_items FOR INSERT WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.fhir_payment_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.fhir_invoices(id) ON DELETE CASCADE,
  mrn text NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'active',
  payment_date timestamptz NOT NULL DEFAULT now(),
  payment_method text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, -- full FHIR PaymentNotice resource
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.fhir_payment_notices TO authenticated;
GRANT SELECT, INSERT ON public.fhir_payment_notices TO anon;
GRANT ALL ON public.fhir_payment_notices TO service_role;
ALTER TABLE public.fhir_payment_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fhir_payment_notices read all" ON public.fhir_payment_notices FOR SELECT USING (true);
CREATE POLICY "fhir_payment_notices write all" ON public.fhir_payment_notices FOR INSERT WITH CHECK (true);

-- updated_at trigger for invoices
CREATE TRIGGER fhir_invoices_touch_updated_at
  BEFORE UPDATE ON public.fhir_invoices
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.fhir_invoices;
ALTER PUBLICATION supabase_realtime ADD TABLE public.fhir_charge_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.fhir_payment_notices;
