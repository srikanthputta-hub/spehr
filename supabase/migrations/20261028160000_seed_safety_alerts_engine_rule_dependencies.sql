
-- Rules 2-4 of src/lib/safety-alerts-engine.ts (Anticoagulant Bleeding Risk,
-- High-Acuity Triage, Sepsis Bundle) resolve their reference value sets via
-- `loadPublishedValueSetsForConsumer({ consumer: "Safety Alerts Engine" })`,
-- which joins through `value_set_dependencies`. No row with
-- consumer = 'Safety Alerts Engine' existed at all (only the unrelated
-- 'Safety Alerts Engine · Drug-Allergy' sub-registry from the
-- 20260707184338 migration, which only Rule 1's coverage-gap tooling reads),
-- so the lookup always returned zero rows and the in-memory `vsCache` Map
-- was permanently empty — Rules 2-4 have never been able to fire.
--
-- None of "Anticoagulants" / "NSAIDs" / "High-Acuity ED Presentations" /
-- "Sepsis Indicators" exist yet as published `custom_value_sets` rows
-- either, so this migration cannot make the rules fire today — that still
-- needs a terminologist to author + publish each value set under the exact
-- name below in the Value Set Library, then update this row's
-- `value_set_id`. What this migration does fix: once that happens, the
-- dependency is now DECLARED, so (a) the Safety Alerts Engine's lookup has
-- a row to resolve, and (b) ValueSetLibrary's delete-safety check (added in
-- PR #45, `countValueSetDependents`) will correctly block deleting that
-- value set out from under Rules 2-4, the same protection every other
-- registered consumer already gets.
--
-- consumer      = 'Safety Alerts Engine'
-- consumer_file = 'src/lib/safety-alerts-engine.ts'
-- purpose       = rule key the value set feeds
-- lookup_mode   = 'by_name' (resolved by custom_value_sets.name, like the
--                 Auto Admin / Auto Doc consumers already registered here)
-- value_set_id  = NULL = not yet authored/published (terminologist gap)

INSERT INTO public.value_set_dependencies
  (consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required, notes)
SELECT v.consumer, v.consumer_file, v.purpose, v.lookup_mode, v.value_set_id, v.value_set_name, v.required, v.notes
FROM (VALUES
  ('Safety Alerts Engine','src/lib/safety-alerts-engine.ts','rule2-anticoag-bleed','by_name',
    NULL::uuid,'Anticoagulants', false,
    'Awaiting published value set — Rule 2 (anticoagulant co-therapy check) is dormant until this exists and is published under this exact name.'),
  ('Safety Alerts Engine','src/lib/safety-alerts-engine.ts','rule2-anticoag-bleed','by_name',
    NULL::uuid,'NSAIDs', false,
    'Awaiting published value set — Rule 2 (anticoagulant + NSAID check) is dormant until this exists and is published under this exact name.'),
  ('Safety Alerts Engine','src/lib/safety-alerts-engine.ts','rule3-high-acuity','by_name',
    NULL::uuid,'High-Acuity ED Presentations', false,
    'Awaiting published value set — Rule 3 (high-acuity triage alert) is dormant until this exists and is published under this exact name.'),
  ('Safety Alerts Engine','src/lib/safety-alerts-engine.ts','rule4-sepsis','by_name',
    NULL::uuid,'Sepsis Indicators', false,
    'Awaiting published value set — Rule 4 (sepsis bundle alert) is dormant until this exists and is published under this exact name. Note: a "Sepsis & Septic Shock" value set already exists but is status=review and named differently, so it does not satisfy this dependency as-is.')
) AS v(consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.value_set_dependencies d
   WHERE d.consumer = v.consumer
     AND d.purpose  = v.purpose
     AND d.lookup_mode = v.lookup_mode
     AND d.value_set_name = v.value_set_name
);
