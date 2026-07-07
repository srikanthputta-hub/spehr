
-- Seed the Drug-Allergy pair registry into value_set_dependencies.
-- consumer      = 'Safety Alerts Engine · Drug-Allergy'
-- purpose       = pair id (e.g. 'penicillin', 'sulfa', ...)
-- lookup_mode   = 'allergen' | 'drug'
-- value_set_id  = resolved custom_value_sets.id (NULL = terminologist gap)

INSERT INTO public.value_set_dependencies
  (consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required, notes)
SELECT v.consumer, v.consumer_file, v.purpose, v.lookup_mode, v.value_set_id, v.value_set_name, v.required, v.notes
FROM (VALUES
  -- Penicillin pair
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','penicillin','allergen',
    '1c97c543-4179-4d00-acbf-52dd0c32725b'::uuid,'Penicillin/Beta-Lactam Allergens', true, 'SNOMED allergen substances for beta-lactam class'),
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','penicillin','drug',
    'c053e92e-dba9-47db-8c4a-af8cbd41ec7d'::uuid,'Penicillin Class Drugs', true, 'Legacy in-house penicillin drug class'),
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','penicillin','drug',
    'bf6c0ee4-d540-4db9-9e6c-f8f3c472c1ea'::uuid,'Penicillin Allergy RXNORM(optum)', true, 'Optum 177-code RxNorm penicillin list'),
  -- Placeholder pairs (unresolved -> terminologist demand)
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','sulfa','allergen',
    NULL,'Sulfa Allergens', false, 'Awaiting published SNOMED value set'),
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','sulfa','drug',
    NULL,'Sulfonamide Drugs', false, 'Awaiting published RxNorm value set'),
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','cephalosporin','allergen',
    NULL,'Cephalosporin Allergens', false, 'Awaiting published SNOMED value set'),
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','cephalosporin','drug',
    NULL,'Cephalosporin Drugs', false, 'Awaiting published RxNorm value set'),
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','nsaid-hypersensitivity','allergen',
    NULL,'NSAID Hypersensitivity Allergens', false, 'Awaiting published SNOMED value set'),
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','nsaid-hypersensitivity','drug',
    NULL,'NSAIDs', false, 'Reuses existing NSAIDs value set when wired'),
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','iodine-contrast','allergen',
    NULL,'Iodine/Contrast Allergens', false, 'Awaiting published SNOMED value set'),
  ('Safety Alerts Engine · Drug-Allergy','src/lib/safety-alerts-engine.ts','iodine-contrast','drug',
    NULL,'Iodinated Contrast Agents', false, 'Awaiting published RxNorm value set')
) AS v(consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required, notes)
WHERE NOT EXISTS (
  SELECT 1 FROM public.value_set_dependencies d
   WHERE d.consumer = v.consumer
     AND d.purpose  = v.purpose
     AND d.lookup_mode = v.lookup_mode
     AND d.value_set_name = v.value_set_name
);
