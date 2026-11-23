-- Fix fake/borrowed OIDs on spehr's own 10 pre-existing custom_value_sets rows.
--
-- An audit against the real VSAC site (vsac.nlm.nih.gov) found that every
-- one of spehr's own 10 custom value sets (9 published, 1 retired) carried
-- an OID that does not actually correspond to their content on VSAC:
--
--   * 4 rows had a non-numeric, syntactically-invalid OID containing the
--     literal substring "spehr" (e.g.
--     "2.16.840.1.113883.3.spehr.p4.isolation") — not valid OID syntax at
--     all, and nested under 1.113883.3, an arc spehr does not control.
--   * 6 rows had a real, syntactically-valid VSAC-looking OID that either
--     resolves to nothing on the real VSAC, or belongs to a completely
--     different, unrelated real VSAC value set (e.g. spehr's 5-code
--     "Type 2 Diabetes Mellitus" carried the OID of VSAC's real 768-code
--     "Diabetes" set).
--
-- The project owner's decision (not revisited here): keep each of these 10
-- value sets' content, name, and status exactly as they are. Only give
-- each one a real, syntactically-valid OID under a root spehr actually
-- controls, instead of a fake or borrowed VSAC-looking one. This migration
-- updates ONLY the `oid` column on exactly these 10 rows (matched by
-- `id` AND their known-bad current `oid`, so it is a no-op if re-run after
-- the OIDs have already changed) — every other column (name, status,
-- codes, description, steward, ...) is left untouched.
--
-- New OID root: 2.25.111443151077358796495519981874781396693
--   `2.25` is the ISO/IEC 9834-8 arc reserved internationally for anyone
--   to self-assign a globally-unique OID from a UUID, with no
--   registration step — i.e. it is a REAL, valid way to mint an OID that
--   is NOT under any external authority's registered arc (not VSAC's, not
--   CMS's, not HL7's, not NCQA's, not anyone else's). The large number
--   after "2.25." is simply a UUID (53d72b90-a211-415e-9414-ef6e29d89ed5)
--   read as a decimal integer, per that standard. See
--   `SPEHR_LOCAL_OID_ROOT` / `isSpehrLocalOid()` in
--   supabase/functions/_shared/value-set-registry.ts, which the app now
--   uses to recognize any OID under this root as spehr's own local
--   authoring, never a real VSAC-published value set (so the UI doesn't
--   offer "Re-sync from VSAC" on these rows, and doesn't claim their
--   steward-of-record came from VSAC's own publisher metadata).
--
-- Old -> new OID mapping (final segment assigned in stable, alphabetical-
-- by-name order; `id` is the authoritative match key, name is included
-- only for human readability of this table):
--
--   id                                   | name                                              | old oid                                                | new oid
--   54b60318-56f7-4a13-9f59-83a17923f26e | Chronic Condition Risk-Adjustment Diagnoses       | 2.16.840.1.113883.3.spehr.billing.chronic-risk-adj     | 2.25.111443151077358796495519981874781396693.1
--   86f36132-aa18-4264-b763-481bb2712c48 | Community-Acquired Pneumonia                      | 2.16.840.1.113883.3.464.1003.102.12.1001               | 2.25.111443151077358796495519981874781396693.2
--   e7c898c3-a9bb-47bf-915b-dfb14a93f4c7 | Drug-Allergy Reactions (MedDRA)                   | 2.16.840.1.113883.3.989.2.1.1.99                       | 2.25.111443151077358796495519981874781396693.3
--   4ce0ee02-1fad-42fe-9e88-9992621be727 | Hemoglobin Lab Panels                             | 2.16.840.1.113883.3.464.1003.198.11.1010               | 2.25.111443151077358796495519981874781396693.4
--   9a74f435-fa5a-453a-997e-6ced27646657 | Inpatient-Only Procedures (Starter Set)           | 2.16.840.1.113883.3.spehr.p4.inpatient                 | 2.25.111443151077358796495519981874781396693.5
--   4a3dbf14-1c4f-4780-84ff-c42456238b4d | Isolation Precaution Diagnoses                    | 2.16.840.1.113883.3.spehr.p4.isolation                 | 2.25.111443151077358796495519981874781396693.6
--   c122c70a-c379-47a5-8739-4902b5d7d903 | Opioid Analgesics                                 | 2.16.840.1.113883.3.464.1003.196.11.1234               | 2.25.111443151077358796495519981874781396693.7
--   7244fed8-13e5-493d-b97e-6a6e0f2c826c | Specialist Consult Triggers                       | 2.16.840.1.113883.3.spehr.p4.consult                   | 2.25.111443151077358796495519981874781396693.8
--   d5e04eea-bc12-456b-967d-e9850f9a4fc9 | Type 2 Diabetes Mellitus                          | 2.16.840.1.113883.3.464.1003.103.12.1001               | 2.25.111443151077358796495519981874781396693.9
--   de2814de-5a10-4a6f-ae73-2cae0b95bc90 | VTE Prophylaxis Medications                       | 2.16.840.1.113883.3.117.1.7.1.211                      | 2.25.111443151077358796495519981874781396693.10
--
-- This is an UPDATE of the `oid` column only, on exactly these 10 rows.
-- No rows are inserted or deleted, and no other column is touched.

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.1', updated_at = now()
where id = '54b60318-56f7-4a13-9f59-83a17923f26e'
  and oid = '2.16.840.1.113883.3.spehr.billing.chronic-risk-adj';

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.2', updated_at = now()
where id = '86f36132-aa18-4264-b763-481bb2712c48'
  and oid = '2.16.840.1.113883.3.464.1003.102.12.1001';

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.3', updated_at = now()
where id = 'e7c898c3-a9bb-47bf-915b-dfb14a93f4c7'
  and oid = '2.16.840.1.113883.3.989.2.1.1.99';

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.4', updated_at = now()
where id = '4ce0ee02-1fad-42fe-9e88-9992621be727'
  and oid = '2.16.840.1.113883.3.464.1003.198.11.1010';

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.5', updated_at = now()
where id = '9a74f435-fa5a-453a-997e-6ced27646657'
  and oid = '2.16.840.1.113883.3.spehr.p4.inpatient';

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.6', updated_at = now()
where id = '4a3dbf14-1c4f-4780-84ff-c42456238b4d'
  and oid = '2.16.840.1.113883.3.spehr.p4.isolation';

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.7', updated_at = now()
where id = 'c122c70a-c379-47a5-8739-4902b5d7d903'
  and oid = '2.16.840.1.113883.3.464.1003.196.11.1234';

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.8', updated_at = now()
where id = '7244fed8-13e5-493d-b97e-6a6e0f2c826c'
  and oid = '2.16.840.1.113883.3.spehr.p4.consult';

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.9', updated_at = now()
where id = 'd5e04eea-bc12-456b-967d-e9850f9a4fc9'
  and oid = '2.16.840.1.113883.3.464.1003.103.12.1001';

update public.custom_value_sets
set oid = '2.25.111443151077358796495519981874781396693.10', updated_at = now()
where id = 'de2814de-5a10-4a6f-ae73-2cae0b95bc90'
  and oid = '2.16.840.1.113883.3.117.1.7.1.211';
