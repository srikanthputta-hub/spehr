
-- 1. Restore the global automation toggle
INSERT INTO public.system_settings (id, automation_enabled, created_by_type, author_id)
VALUES (1, true, 'system', 'reseed')
ON CONFLICT (id) DO UPDATE SET automation_enabled = true, updated_at = now();

-- 2. Reseed beds for every facility (15 rooms x 2 beds = 30 beds each)
INSERT INTO public.bed_management (facility_name, room_number, bed_letter, status, created_by_type, author_id)
SELECT f.facility_name, r.room_number::text, b.bed_letter, 'Available', 'system', 'reseed'
FROM (VALUES
  ('Memorial Hospital'),
  ('St. Jude Medical Center'),
  ('City General Infirmary'),
  ('County Health Pavilion'),
  ('Srik Health Clinic')
) AS f(facility_name)
CROSS JOIN generate_series(101, 115) AS r(room_number)
CROSS JOIN (VALUES ('A'), ('B')) AS b(bed_letter)
ON CONFLICT DO NOTHING;

-- 3. Prime the pump so charts populate immediately
SELECT public.auto_admit_ghost_patient();
SELECT public.auto_admit_ghost_patient();
SELECT public.auto_admit_ghost_patient();
