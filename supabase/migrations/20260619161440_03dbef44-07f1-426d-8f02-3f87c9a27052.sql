-- Permanently disable the Auto Doc DB→HTTP dispatch trigger.
-- Reason: the trigger POSTs to the production Auto Doc hook, which (in
-- older deployed builds) bulk-inserts 3 condition meds directly as
-- status='Administered' with administered_at=NOW() at admission time.
-- That bypasses the staged client cascade (Ordered → Pending Verification
-- → Dispensed → Administered at T+20/35/50s with 3s gaps) and is the
-- source of the duplicate "Administered at admission second" rows.
-- The client-side cascade in useAIAutomation.seedAdmission is now the
-- single, authoritative writer for both medication_orders and lab_orders.

DROP TRIGGER IF EXISTS patients_auto_doc_after_insert ON public.patients;
DROP FUNCTION IF EXISTS public.notify_auto_doc();

-- Also retire the legacy bulk auto-administer routine so nothing on the
-- DB side can ever flip pending med rows straight to "Administered".
DROP FUNCTION IF EXISTS public.auto_administer_ghost_meds();