-- Hard backstop against duplicate FHIR PaymentNotice rows for the same
-- invoice. payInvoiceById() (auto-doc.server.ts) now CAS-guards its
-- fhir_invoices UPDATE with .eq("status","issued") before inserting a
-- payment notice, which closes the application-level race; this unique
-- constraint additionally guarantees it at the database level against any
-- insert path (including the uncoordinated portal-pay insert in
-- patient.$mrn.tsx), regardless of how the app evolves above it. Verified
-- live via a rolled-back transaction (duplicate insert raised
-- unique_violation as expected) before applying this for real. No
-- existing duplicate (invoice_id, count) rows on qxyvmvtecnnwqeqaouzh, so
-- this applies cleanly.
ALTER TABLE public.fhir_payment_notices
  ADD CONSTRAINT fhir_payment_notices_invoice_id_key UNIQUE (invoice_id);
