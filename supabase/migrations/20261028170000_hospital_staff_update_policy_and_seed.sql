-- The System Admin "User Directory" tab was wired to a hardcoded client-side
-- array (STAFF_DIRECTORY) with no backing table. hospital_staff already
-- exists with a matching shape (name/role/facility_name/status) but had
-- only anon INSERT + SELECT RLS policies -- no UPDATE policy, so the
-- "Edit Access" dialog's Save would have silently no-opped against anon
-- writes. Add the matching permissive UPDATE policy (same "Anyone can ..."
-- style as the existing policies -- this app has no real auth, see
-- system-admin.tsx's isAdmin comment) and seed the table with the same
-- directory members that were previously only in React state, so wiring
-- the UI to this table doesn't start it out empty.

create policy "Anyone can update hospital staff"
  on public.hospital_staff
  for update
  using (true)
  with check (true);

insert into public.hospital_staff (name, role, facility_name, status, created_by_type)
values
  ('Diane Whitaker', 'System Administrator', 'Memorial Hospital', 'Active', 'human'),
  ('Marcus Lin, MD', 'Attending Physician', 'Memorial Hospital', 'Active', 'human'),
  ('Sarah Jenkins, RN', 'Registered Nurse', 'St. Jude Medical Center', 'Active', 'human'),
  ('Priya Raman, PharmD', 'Clinical Pharmacist', 'City General Infirmary', 'Active', 'human'),
  ('Jordan Alvarez, CLT', 'Clinical Lab Tech', 'Memorial Hospital', 'Active', 'human'),
  ('Evelyn Park, MD', 'Attending Physician', 'Srik Health Clinic', 'Suspended', 'human'),
  ('Daniel Whitfield, CPA', 'Corporate Finance & Accounts', 'County Health Pavilion', 'Active', 'human'),
  ('Hannah O''Connor, RN', 'Registered Nurse', 'Memorial Hospital', 'Active', 'human'),
  ('Brian Yamamoto, MD', 'Attending Physician', 'St. Jude Medical Center', 'Active', 'human'),
  ('Lena Kowalski, CLT', 'Clinical Lab Tech', 'City General Infirmary', 'Suspended', 'human')
on conflict do nothing;
