-- tasks.tsx's administer() does a correct CAS (compare-and-swap) update when
-- marking a medication order Administered, but medication_orders had no
-- column recording WHO administered the dose -- only administered_at (a
-- timestamp). Add administered_by so the app can attribute the action to
-- the locally-selected staff identity (useActiveStaff("RN")), the same
-- device-local attribution convention already used for author_id elsewhere
-- (system_settings/role_permissions via useActiveStaff("Admin"), see PR #47).
ALTER TABLE public.medication_orders ADD COLUMN IF NOT EXISTS administered_by text;

COMMENT ON COLUMN public.medication_orders.administered_by IS
  'Locally-selected staff identity (useActiveStaff("RN").name) that marked this order Administered. No real auth in this app, so this is device-local attribution, not a verified identity -- same convention as medication_orders.ordering_physician and system_settings.author_id.';
