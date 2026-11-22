-- L12: Command Center -> Users (UserDirectory in system-admin.tsx) reads
-- the staff directory straight from `hospital_staff`. Live data had only
-- 10 rows, scattered near-randomly across facilities/roles and mostly NOT
-- matching the 40-persona roster (STAFF_BY_FACILITY in
-- src/lib/facility-context.tsx) that every other board in this app uses
-- as "who's logged in" for that role/facility — e.g. "Daniel Whitfield,
-- CPA" existed but filed under County Health Pavilion's Finance seat
-- instead of Memorial's (his actual seat per STAFF_BY_FACILITY), "Sarah
-- Jenkins, RN" was filed under St. Jude instead of Memorial, and most of
-- the other 7 facility/role combinations traced to persona entries never
-- made it into the table at all, while several unrelated names (Marcus
-- Lin MD, Hannah O'Connor RN, Evelyn Park MD, Brian Yamamoto MD, ...)
-- that don't correspond to any STAFF_BY_FACILITY entry were present
-- instead. That's the QA-reported "demo personas don't match actual
-- workspace staff."
--
-- Separately, hourly_rate was NULL on every single row (confirmed via a
-- live query before writing this migration), so the Rate column always
-- rendered "—" — not a display bug, a real data gap. Role-appropriate
-- rates are a legitimately static HR attribute (unlike `assigned_patients`
-- / `max_capacity` below), so they're seeded directly rather than
-- computed.
--
-- `assigned_patients` and `max_capacity` ("Workload") are deliberately
-- left NULL here: there is no FK-based link between `patients` and
-- `hospital_staff` anywhere in the schema (checked live:
-- `patients.primary_care_physician` is a free-text name, not a foreign
-- key) to compute a REAL current caseload per staff member, and seeding
-- static numbers for a column that's supposed to represent live
-- workload would be fabricating data the same way earlier fixes in this
-- repo's history explicitly avoided (see "Fix fabricated cache-hit
-- metric..."). The app-side fix instead relabels the empty state
-- honestly instead of inventing numbers — see the accompanying code
-- change in src/routes/system-admin.tsx.
--
-- No foreign keys reference hospital_staff.id (checked live via
-- pg_constraint), so replacing its rows outright is safe.

delete from public.hospital_staff;

insert into public.hospital_staff (name, role, facility_name, status, hourly_rate, created_at)
values
  -- Memorial Hospital
  ('Sarah Jenkins, RN', 'Registered Nurse', 'Memorial Hospital', 'Active', 42.00, now() - interval '210 days'),
  ('Dr. Robert Patel', 'Attending Physician', 'Memorial Hospital', 'Active', 145.00, now() - interval '640 days'),
  ('Elena Rostova, PharmD', 'Clinical Pharmacist', 'Memorial Hospital', 'Active', 58.00, now() - interval '365 days'),
  ('Daniel Whitfield, CPA', 'Corporate Finance & Accounts', 'Memorial Hospital', 'Active', 38.00, now() - interval '520 days'),
  ('Diane Whitaker', 'System Administrator', 'Memorial Hospital', 'Active', 50.00, now() - interval '900 days'),
  ('Sarah Collins, CLT', 'Clinical Lab Tech', 'Memorial Hospital', 'Active', 28.00, now() - interval '150 days'),
  ('Hannah Brooks', 'Admissions / Reception', 'Memorial Hospital', 'Active', 22.00, now() - interval '95 days'),
  ('Dr. Priya Iyer, MD', 'Radiologist', 'Memorial Hospital', 'Active', 150.00, now() - interval '430 days'),
  -- St. Jude Medical Center
  ('Michael Chang, RN', 'Registered Nurse', 'St. Jude Medical Center', 'Active', 44.00, now() - interval '260 days'),
  ('Dr. Jonathan Vance', 'Attending Physician', 'St. Jude Medical Center', 'Active', 150.00, now() - interval '710 days'),
  ('Amina Diop, PharmD', 'Clinical Pharmacist', 'St. Jude Medical Center', 'Active', 60.00, now() - interval '300 days'),
  ('Rachel Bergman, CFO', 'Corporate Finance & Accounts', 'St. Jude Medical Center', 'Active', 65.00, now() - interval '980 days'),
  ('Harold Pierce', 'System Administrator', 'St. Jude Medical Center', 'Active', 52.00, now() - interval '540 days'),
  ('Alex Wong, CLT', 'Clinical Lab Tech', 'St. Jude Medical Center', 'Active', 29.00, now() - interval '180 days'),
  ('Marisol Vega', 'Admissions / Reception', 'St. Jude Medical Center', 'Active', 23.00, now() - interval '70 days'),
  ('Dr. Nathaniel Cho, MD', 'Radiologist', 'St. Jude Medical Center', 'Active', 155.00, now() - interval '460 days'),
  -- City General Infirmary
  ('Amanda Ross, RN', 'Registered Nurse', 'City General Infirmary', 'Active', 43.00, now() - interval '190 days'),
  ('Dr. Carlos Mendez', 'Attending Physician', 'City General Infirmary', 'Active', 142.00, now() - interval '600 days'),
  ('Chloe Kim, PharmD', 'Clinical Pharmacist', 'City General Infirmary', 'Active', 57.00, now() - interval '340 days'),
  ('Andre Lacroix, CPA', 'Corporate Finance & Accounts', 'City General Infirmary', 'Active', 39.00, now() - interval '480 days'),
  ('Renee Cabrera', 'System Administrator', 'City General Infirmary', 'Active', 49.00, now() - interval '820 days'),
  ('Maya Lin, CLT', 'Clinical Lab Tech', 'City General Infirmary', 'Active', 27.00, now() - interval '130 days'),
  ('Devon Carter', 'Admissions / Reception', 'City General Infirmary', 'Active', 22.00, now() - interval '60 days'),
  ('Dr. Elena Marquez, MD', 'Radiologist', 'City General Infirmary', 'Active', 148.00, now() - interval '400 days'),
  -- County Health Pavilion
  ('Jordan Lee, RN', 'Registered Nurse', 'County Health Pavilion', 'Active', 41.00, now() - interval '220 days'),
  ('Dr. Arjun Mehta', 'Attending Physician', 'County Health Pavilion', 'Active', 140.00, now() - interval '560 days'),
  ('Fatima Al-Sayed, PharmD', 'Clinical Pharmacist', 'County Health Pavilion', 'Active', 56.00, now() - interval '310 days'),
  ('Monica Schaeffer, MBA', 'Corporate Finance & Accounts', 'County Health Pavilion', 'Active', 40.00, now() - interval '500 days'),
  ('Marcus Hadley', 'System Administrator', 'County Health Pavilion', 'Active', 48.00, now() - interval '780 days'),
  ('James Carter, CLT', 'Clinical Lab Tech', 'County Health Pavilion', 'Active', 27.00, now() - interval '140 days'),
  ('Aisha Bennett', 'Admissions / Reception', 'County Health Pavilion', 'Active', 21.00, now() - interval '80 days'),
  ('Dr. Samuel Okafor, MD', 'Radiologist', 'County Health Pavilion', 'Active', 146.00, now() - interval '390 days'),
  -- Srik Health Clinic
  ('Priya Shah, RN', 'Registered Nurse', 'Srik Health Clinic', 'Active', 40.00, now() - interval '160 days'),
  ('Dr. William Bradshaw', 'Attending Physician', 'Srik Health Clinic', 'Active', 138.00, now() - interval '520 days'),
  ('Xavier Dupont, PharmD', 'Clinical Pharmacist', 'Srik Health Clinic', 'Active', 55.00, now() - interval '280 days'),
  ('Kenji Aoyama, CPA', 'Corporate Finance & Accounts', 'Srik Health Clinic', 'Active', 37.00, now() - interval '350 days'),
  ('Olivia Sterling', 'System Administrator', 'Srik Health Clinic', 'Active', 47.00, now() - interval '620 days'),
  ('Nisha Patel, CLT', 'Clinical Lab Tech', 'Srik Health Clinic', 'Active', 26.00, now() - interval '110 days'),
  ('Theo Nakamura', 'Admissions / Reception', 'Srik Health Clinic', 'Active', 21.00, now() - interval '50 days'),
  ('Dr. Hana Suzuki, MD', 'Radiologist', 'Srik Health Clinic', 'Active', 144.00, now() - interval '370 days');
