
INSERT INTO public.role_permissions (target_role, feature_key, feature_name, facility_name, is_active)
SELECT r.target_role, r.feature_key, r.feature_name, f.facility_name, true
FROM (
  VALUES
    ('MD',     'btn_esign_note',       '✍️ E-Sign & Lock Note'),
    ('MD',     'btn_order_labs',       '🧪 Order Laboratory Evaluation'),
    ('MD',     'btn_refer_patient',    '🔄 Refer / Transfer Patient'),
    ('MD',     'btn_discharge_patient','🏠 Discharge Patient'),
    ('RN',     'btn_esign_note',       '✍️ E-Sign & Lock Note'),
    ('RN',     'btn_administer_med',   '💊 Administer Medication'),
    ('RN',     'btn_triage_patient',   '🩺 Triage Patient'),
    ('CLT',    'btn_run_lab_sample',   '🧫 Run Lab Sample'),
    ('CLT',    'btn_submit_report',    '📤 Submit Official Report'),
    ('PharmD', 'btn_verify_med',       '✅ Verify Medication Order'),
    ('PharmD', 'btn_dispense_med',     '📦 Dispense Medication')
) AS r(target_role, feature_key, feature_name)
CROSS JOIN (
  VALUES
    ('Memorial Hospital'),
    ('St. Jude Medical Center'),
    ('City General Infirmary'),
    ('County Health Pavilion'),
    ('Mercy Childrens Hospital')
) AS f(facility_name)
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions p
  WHERE p.target_role = r.target_role
    AND p.feature_key = r.feature_key
    AND p.facility_name = f.facility_name
);
