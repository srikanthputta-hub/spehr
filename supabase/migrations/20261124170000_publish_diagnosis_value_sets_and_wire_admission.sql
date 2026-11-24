-- Publish the five diagnosis value sets the 2026-11 VSAC audit flagged as
-- "strong fit" (each one's code list confirmed to contain the exact
-- ICD-10-CM code spehr's own patient data already uses for that diagnosis),
-- and register them as a dependency of the new "Admission Diagnosis
-- Coding" consumer (diagnosis-value-set-map.ts / admit-patient.ts).
--
-- The status/published_at/change_history update mirrors exactly what
-- ValueSetLibrary.tsx's "Approve & Publish" action sets (see
-- `transitionStatus()` and the publish Dialog's onClick in
-- src/components/admin/dictionary/ValueSetLibrary.tsx) rather than a bare
-- status flip, and is guarded by `status <> 'published'` so re-running this
-- migration (e.g. applying it to another environment that already has
-- these rows published through the UI) is a no-op.

update public.custom_value_sets
set
  status = 'published',
  published_at = coalesce(published_at, now()),
  updated_at = now(),
  change_history = coalesce(change_history, '[]'::jsonb) || jsonb_build_object(
    'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'actor', 'S.P.E.H.R. Terminology Services',
    'change', 'Status: ' || status || ' → published'
  )
where oid in (
  '2.16.840.1.113762.1.4.1264.24',      -- CAP Pneumonia Diagnostic
  '2.16.840.1.113883.3.117.1.7.1.247',  -- Ischemic Stroke
  '2.16.840.1.113762.1.4.1029.330',     -- Hypertension
  '2.16.840.1.113762.1.4.1178.125',     -- AHA GWTG Hyperlipidemia
  '2.16.840.1.113762.1.4.1178.121'      -- AHA GWTG Atrial Fibrillation
)
and status <> 'published';

-- Register the dependency rows following this table's existing
-- "by_name" lookup_mode convention (same as the Isolation Precaution
-- Diagnoses / Specialist Consult Triggers rows already in this table) —
-- loadPublishedValueSetsForConsumer() resolves these at runtime for
-- consumer = 'Admission Diagnosis Coding'. `required = true` because
-- admit-patient.ts's match is a no-op (honest gap, no fabricated code)
-- rather than an error when a row isn't linked, but the five diagnoses are
-- exactly the ones this consumer exists to cover.
insert into public.value_set_dependencies
  (consumer, consumer_file, purpose, lookup_mode, required, value_set_name, value_set_id, notes)
select
  'Admission Diagnosis Coding',
  'src/lib/diagnosis-value-set-map.ts',
  'Match admitting-diagnosis free text to a published diagnosis value set at admission time',
  'by_name',
  true,
  cvs.name,
  cvs.id,
  'Linked at publish time — part of the 2026-11 VSAC diagnosis value set audit (5 of 17 "strong fit" sets).'
from public.custom_value_sets cvs
where cvs.oid in (
  '2.16.840.1.113762.1.4.1264.24',
  '2.16.840.1.113883.3.117.1.7.1.247',
  '2.16.840.1.113762.1.4.1029.330',
  '2.16.840.1.113762.1.4.1178.125',
  '2.16.840.1.113762.1.4.1178.121'
)
and not exists (
  select 1 from public.value_set_dependencies vsd
  where vsd.consumer = 'Admission Diagnosis Coding'
    and vsd.value_set_name = cvs.name
);
