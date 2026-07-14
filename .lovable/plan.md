# Fix duplicate safety alerts for a single drug order

## Root cause (verified against live data)

The engine is already value-set-driven — it iterates `value_set_dependencies` (consumer `Safety Alerts Engine · Drug-Allergy`) and fires an alert per matching pair. For the amoxicillin order in the screenshot, **two pairs both matched** because the seeded value sets overlap:

- `Penicillin Class Drugs`, `Cephalosporin Drugs`, `Penicillin Allergy RXNORM(optum)` all contain amoxicillin's RxNorm code.
- `Penicillin/Beta-Lactam Allergens` and `Cephalosporin Allergens` both contain SNOMED `764146007` (mislabeled in `Cephalosporin Allergens` as "Cefazolin / beta-lactam cross-reactive allergen").

So the patient's single "Penicillin" allergy row satisfies both the penicillin pair and the cephalosporin pair → two alerts. The engine isn't guessing; it's dutifully firing once per registered pair, which is not what the user wants.

## Fix (engine only — no seed edits)

Change Rule 1 in `src/lib/safety-alerts-engine.ts` so it fires **at most one Drug-Allergy alert per medication order**, and cite the specific value set that produced the match.

1. **One-alert-per-order guarantee.** In `runMedicationOrderRules`, collect every matching pair first (drug value set + allergen value set + allergy row), then pick the single best match using this deterministic priority:
   1. Prefer a match where the drug and allergen value sets are declared under the *same* `purpose` (already true for the pair loop today).
   2. Break ties by the most specific published drug value set — i.e. the one with the **smallest** `codes.length` that contains the ordered drug (a narrow "Penicillin Allergy RXNORM(optum)"-style list beats a broad umbrella).
   3. Break further ties by pair id alphabetical order for determinism.
   Fire once. Skip the other pairs entirely for this order.

2. **Cite the actual matched value sets in the alert.** Keep the existing `valueSetNames: [drugVs.name, allergenVs.name]` payload — after step 1 it will already be the specific published value set (e.g. `Penicillin Allergy RXNORM(optum)`, `Penicillin/Beta-Lactam Allergens`) instead of two conflicting families. The chip rows in `SafetyAlertBanner`, `PatientSafetyAlertQueue`, and `Step8Surfacing` already render these names — no UI changes needed.

3. **Belt-and-suspenders DB dedupe.** The existing unique index on `(medication_order_id, rule_id)` prevents true duplicates only when `rule_id` matches. Today `rule_id` is `rule1-drug-allergy:<pairId>`, so two different pairs produce two different `rule_id`s and both insert. Change the stored `rule_id` for Rule 1 to the constant `rule1-drug-allergy` (drop the `:pairId` suffix) so the unique index catches any race that slipped past the in-process dedupe. The `family` string still embeds `[rule1-drug-allergy:<triggerCode>]` for the existing `alreadyFired()` marker, so historical dedupe behavior is preserved.

4. **No changes** to Rules 2/3/4, to CDS suggestions, to the pair registry table, or to any value set contents. The seeded overlap in `Cephalosporin Allergens` is a data-curation issue for the terminologist and is out of scope for this fix — the engine will simply no longer amplify it into a duplicate alert.

## Verification

- Typecheck.
- SQL sanity check: for a fresh amoxicillin order on a patient with SNOMED `373270004` documented, confirm exactly one row lands in `clinical_safety_alerts` and its `family` contains `· Value Sets: Penicillin Allergy RXNORM(optum), Penicillin/Beta-Lactam Allergens` (or the narrowest matching drug VS after the priority sort).
- Re-check the physician board banner and the patient banner render the single alert with the correct value set chips.
