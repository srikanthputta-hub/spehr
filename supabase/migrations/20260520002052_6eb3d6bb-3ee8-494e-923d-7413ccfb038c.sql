-- Enable RLS and permissive policies for role_permissions so the admin UI can read/update
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view role permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "Anyone can update role permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "Anyone can insert role permissions" ON public.role_permissions;

CREATE POLICY "Anyone can view role permissions"
  ON public.role_permissions FOR SELECT
  USING (true);

CREATE POLICY "Anyone can update role permissions"
  ON public.role_permissions FOR UPDATE
  USING (true) WITH CHECK (true);

CREATE POLICY "Anyone can insert role permissions"
  ON public.role_permissions FOR INSERT
  WITH CHECK (true);

-- Unique constraint so upserts work cleanly
CREATE UNIQUE INDEX IF NOT EXISTS role_permissions_role_feature_uidx
  ON public.role_permissions (target_role, feature_key);

-- Seed any missing rows for the three gated buttons across all clinical roles
INSERT INTO public.role_permissions (target_role, feature_key, feature_name, is_active) VALUES
  ('RN',     'btn_order_labs',    '🧪 Order Laboratory Evaluation', true),
  ('RN',     'btn_refer_patient', '🔄 Refer / Transfer Patient',    true),
  ('RN',     'btn_esign_note',    '✍️ E-Sign & Lock Note',          true),
  ('MD',     'btn_order_labs',    '🧪 Order Laboratory Evaluation', true),
  ('MD',     'btn_refer_patient', '🔄 Refer / Transfer Patient',    true),
  ('MD',     'btn_esign_note',    '✍️ E-Sign & Lock Note',          true),
  ('PharmD', 'btn_order_labs',    '🧪 Order Laboratory Evaluation', false),
  ('PharmD', 'btn_refer_patient', '🔄 Refer / Transfer Patient',    false),
  ('PharmD', 'btn_esign_note',    '✍️ E-Sign & Lock Note',          true),
  ('RT',     'btn_order_labs',    '🧪 Order Laboratory Evaluation', true),
  ('RT',     'btn_refer_patient', '🔄 Refer / Transfer Patient',    false),
  ('RT',     'btn_esign_note',    '✍️ E-Sign & Lock Note',          true),
  ('Admin',  'btn_order_labs',    '🧪 Order Laboratory Evaluation', false),
  ('Admin',  'btn_refer_patient', '🔄 Refer / Transfer Patient',    true),
  ('Admin',  'btn_esign_note',    '✍️ E-Sign & Lock Note',          false),
  ('Lab',    'btn_order_labs',    '🧪 Order Laboratory Evaluation', true),
  ('Lab',    'btn_refer_patient', '🔄 Refer / Transfer Patient',    false),
  ('Lab',    'btn_esign_note',    '✍️ E-Sign & Lock Note',          false)
ON CONFLICT (target_role, feature_key) DO NOTHING;
