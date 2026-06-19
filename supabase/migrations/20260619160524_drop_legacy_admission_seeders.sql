-- Permanently retire the legacy admission seeders. The Auto Doc client
-- cascade in src/hooks/useAIAutomation.ts is now the SOLE writer of
-- medication_orders / lab_orders rows for new admissions, walking each
-- row through Ordered → Pending Verification → Dispensed → Administered
-- (meds) and Ordered → Processing → Reported (labs) on the documented
-- T+20/35/50s timeline. Dropping these functions guarantees no DB
-- trigger can ever short-circuit that flow by inserting rows already
-- marked Administered at admission time.
DROP FUNCTION IF EXISTS public.generate_default_orders_for_new_patient() CASCADE;
DROP FUNCTION IF EXISTS public.seed_orders_for_admitted_patient() CASCADE;
