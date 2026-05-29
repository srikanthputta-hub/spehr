
INSERT INTO public.role_permissions (target_role, feature_key, feature_name, facility_name, is_active)
SELECT r.target_role, r.feature_key, r.feature_name, f.facility_name, true
FROM (VALUES
  ('RN',     'btn_admit_patient',                '🛏️ Admit Patient'),
  ('RN',     'btn_discharge_patient',            '🏠 Discharge Patient'),
  ('RT',     'btn_chart_respiratory_assessment', '🫁 Chart Respiratory Assessment'),
  ('RT',     'btn_administer_treatment',         '💨 Administer Treatment'),
  ('Admin',  'btn_approve_transfer',             '✅ Approve Patient Transfer'),
  ('Admin',  'btn_deny_transfer',                '❌ Deny Patient Transfer'),
  ('MD',     'btn_create_med_order',             '💊 Create Medication Order')
) AS r(target_role, feature_key, feature_name)
CROSS JOIN (VALUES
  ('Memorial Hospital'),
  ('St. Jude Medical Center'),
  ('City General Infirmary'),
  ('County Health Pavilion'),
  ('Srik Health Clinic')
) AS f(facility_name)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions p
  WHERE p.target_role = r.target_role
    AND p.feature_key = r.feature_key
    AND p.facility_name = f.facility_name
);

GRANT SELECT, UPDATE ON public.role_permissions TO anon, authenticated;
GRANT ALL ON public.role_permissions TO service_role;

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='role_permissions' AND policyname='Anyone can view role permissions') THEN
    CREATE POLICY "Anyone can view role permissions" ON public.role_permissions FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='role_permissions' AND policyname='Anyone can update role permissions') THEN
    CREATE POLICY "Anyone can update role permissions" ON public.role_permissions FOR UPDATE USING (true) WITH CHECK (true);
  END IF;
END $$;

ALTER PUBLICATION supabase_realtime ADD TABLE public.role_permissions;
