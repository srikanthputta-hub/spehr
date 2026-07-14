## Root cause (recap in one line)

The engine requires TWO published value sets to co-match (a SNOMED allergen VS + an RxNorm drug VS). For penicillin only the drug VS `Penicillin Allergy RXNORM(optum)` is published — so nothing fires, even though that one value set already contains everything we need.

## New matching model — value-set-only, no pair registry, no synthetic value sets

Rule 1 (Drug-Allergy) becomes a single-pass scan over **all published value sets** in `custom_value_sets`:

For each published value set `vs`:
1. **Drug side present?** — does `vs.codes` contain the ordered drug's `rxnorm_code`?
2. **Allergy side named by this value set?** — does the patient have any active allergy whose `substance` text word-overlaps with `vs.name` (case-insensitive; ignore stopwords like `allergy`, `allergen`, `rxnorm`, `optum`, `class`, `drugs`, parenthetical tokens; match on any remaining token ≥ 4 chars, e.g. `penicillin`, `sulfa`, `cephalosporin`, `codeine`, `iodine`, `nsaid`)?

If both are true → candidate match. Fire **one** alert (existing dedupe / narrowest-VS tie-break already in the engine), citing that value set name in the `valueSetNames` chip and the matched allergy substance in `allergy_name`.

This is exactly the user's mental model:
- Ordered `amoxicillin` (RxNorm 133008)
- Patient allergy substance `Penicillin`
- Published VS `Penicillin Allergy RXNORM(optum)` contains 133008 AND its name contains `penicillin`
- → fire, chip shows `Penicillin Allergy RXNORM(optum)`.

It generalizes automatically to any future value set the terminologist publishes whose name encodes the allergy class (e.g. `Sulfa Allergens`, `Codeine/Opioid Allergens`).

## Scope of code changes

### `src/lib/safety-alerts-engine.ts`
- **Delete** the `loadDrugAllergyPairs` code path and the `pair.allergenSets` / `pair.drugSets` traversal in Rule 1.
- **Replace** with `loadPublishedValueSets()` (single query, cached with the existing TTL) and the two-check scan above.
- Keep the deterministic tie-break: narrowest `vs.codes.length` wins, then `vs.name` alphabetical.
- Keep `rule_id = 'rule1-drug-allergy'` and the unique-index race guard from the previous turn.
- Keep the coverage-gap `requestTerminologyUpdate` call for the case where the patient has an allergy but no published value set names it.
- Rules 2/3/4 untouched.

### `src/lib/coding-pipeline.ts` (Stream D)
- Also parse `patients.allergies` free text (pattern `Substance (Reaction), Substance2, …` — same parser style as `parseDrugAllergy` in `src/routes/patient.$mrn.tsx`) and upsert an `allergies` row per substance so the engine sees drug allergies from the chart, not just environmental ones. Reuse `lookupAllergenSnomed` when it maps; else store the free-text substance alone (the new matcher works off `substance` text, `substance_rxcui`, or `substance_snomed`).

### One-shot data fix (via insert tool, not migration)
- Insert an `allergies` row for `MRN-795713`: substance `Penicillin`, reaction `Nausea`, status `active`, `coding_source = 'backfill-chart-allergy'` (idempotent — skip if it already exists).
- Insert one `clinical_safety_alerts` row for the existing amoxicillin order `08f6be27-5538-4e7c-9178-aa9ed888c2ac`, `rule_id = 'rule1-drug-allergy'`, `valueSetNames = ['Penicillin Allergy RXNORM(optum)']` so the current chart shows the alert immediately (the DB unique index prevents a duplicate if the engine re-fires).

### Cleanup (not a functional change, but keeps the registry honest)
- The `value_set_dependencies` rows for `Safety Alerts Engine · Drug-Allergy` are no longer read by the engine. Leave the table intact (other consumers may use it) — just stop reading it from Rule 1.

## Verification

1. `bunx tsgo --noEmit` clean.
2. SQL: after the one-shot inserts, `clinical_safety_alerts` shows one `rule1-drug-allergy` row for Mary Jones with `Penicillin Allergy RXNORM(optum)` in `family`.
3. UI: Physician board / patient chart shows the Penicillin conflict banner with the value-set chip; the amoxicillin order flips to `HELD_SAFETY_REVIEW` on any subsequent re-fire path (already `Administered` for this one — expected, since the alert was missed at order-time).
4. Order a fresh amoxicillin for another Penicillin-allergic patient → exactly one alert fires, chip cites `Penicillin Allergy RXNORM(optum)`.
5. Order a drug NOT in any allergy-named value set → no false positives (regression check for the earlier Losartan/Acetaminophen-vs-iodine bug, which came from the now-deleted pair path).

## Out of scope

Rules 2 (anticoag bleed), 3 (high-acuity), 4 (sepsis) — they already consume single published value sets and are unaffected.
