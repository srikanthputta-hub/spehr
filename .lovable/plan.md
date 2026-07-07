## Goal

Make **every** Drug-Allergy safety check data-driven: for any medication order, the engine cross-references the patient's chart (allergies + active problems) against **all** published allergen⇄drug value-set pairs registered in `value_set_dependencies` — not just the hardcoded `Penicillin Class Drugs` × `Penicillin/Beta-Lactam Allergens` pair. Adding a new pair (e.g. Sulfa, Cephalosporin, NSAID-hypersensitivity, Iodine-contrast) becomes a data change in the Value Set Library, not a code change.

## Today's gap

`src/lib/safety-alerts-engine.ts` Rule 1 is hardwired:

```
const penicillins = vs.get("Penicillin Class Drugs");
const penicillinAllergens = vs.get("Penicillin/Beta-Lactam Allergens");
```

Consequences seen on MRN-693833:
- Allergy `764146007 · Product containing penicillin` is recognized (it IS in the allergens set).
- But `Penicillin Class Drugs` is still `draft` with 3 codes, so `vs.get()` returns `undefined` and the rule never fires — even though the `Penicillin Allergy RXNORM(optum)` value set (published, 177 RxNorm codes) covers ampicillin, amoxicillin, dicloxacillin, etc.
- No mechanism today to add "Sulfa allergy → sulfonamides", "Cephalosporin allergy → cephalosporins", etc. without editing engine source.

## Design — Allergen⇄Drug pair registry (data, not code)

Reuse the existing `value_set_dependencies` table (no schema change). A pair is expressed by two rows sharing a `consumer_file` marker:

```
consumer = 'Safety Alerts Engine · Drug-Allergy'
consumer_file = 'pair:penicillin'        -- arbitrary stable pair id
role (stored in `notes` column or the existing `role` col if present) = 'allergen' | 'drug'
value_set_id → custom_value_sets.id
```

The engine loads every `Safety Alerts Engine · Drug-Allergy` row, groups by `consumer_file`, resolves each group into `{ allergenSets: VsRow[], drugSets: VsRow[] }`, and for a given medication order fires if:
- the drug code is in the union of `drugSets` for any pair, AND
- the patient has an allergy whose SNOMED code is in the union of that pair's `allergenSets`.

Multiple published value sets per side are allowed (union semantics) — that solves the Optum-vs-in-house duplication cleanly. Draft/retired sets are ignored automatically by `loadPublishedValueSetsForConsumer`.

Seeded pairs (migration inserts, existing tables only):
1. **Penicillin** — allergens `Penicillin/Beta-Lactam Allergens` × drugs `Penicillin Class Drugs` + `Penicillin Allergy RXNORM(optum)`.
2. Placeholder rows for **Sulfa**, **Cephalosporin**, **NSAID-hypersensitivity**, **Iodine-contrast** — inserted with `value_set_id = NULL` so terminologists see the demand in the Value Set Library and can wire up published sets later (mirrors the existing null-id pattern already used for `Penicillin Class Drugs`).

## Fix

1. **`src/lib/safety-alerts-engine.ts`** — replace the hardcoded penicillin lookup with a generic pair loader:
   - New helper `loadDrugAllergyPairs()` — one query against `value_set_dependencies` joined to `custom_value_sets`, grouped by `consumer_file`, cached with the same 5-minute TTL as `ensureValueSetsLoaded`.
   - Rule 1 iterates pairs; for each pair, checks drug-code membership across `drugSets` union and allergy-SNOMED membership across `allergenSets` union.
   - Coverage-gap `requestTerminologyUpdate` fires per pair: the justification names the pair id and lists which value sets in the pair are currently published, so the terminologist sees exactly which side needs codes.
   - Keep Rules 2/3/4 untouched.

2. **Migration (existing tables only)** — insert dependency rows for the seeded pairs above. `Penicillin Allergy RXNORM(optum)` gets its real `value_set_id`; the other pairs are placeholder rows with null ids. `ON CONFLICT DO NOTHING` on `(consumer, consumer_file, value_set_name)`.

3. **`src/components/admin/dictionary/ValueSetLibrary.tsx`** (UI-only, presentation) — when a value set is referenced by a `Safety Alerts Engine · Drug-Allergy` pair, show a small badge `Drug-Allergy Pair · <pair-id> · allergen|drug` next to the row so terminologists can see at a glance which pairs the set participates in. No business-logic change.

4. **`src/routes/system-admin.tsx`** — Safety Alerts info tooltip: replace the fixed value-set name list with "governed by the Drug-Allergy pair registry — see Value Set Library."

## Non-goals (deliberate)

- No new tables, no changes to `clinical_safety_alerts`, `allergies`, `medication_orders`, or `custom_value_sets` schema.
- No allergen name-based fuzzy fallback (still requires a SNOMED code on the allergy row — existing behavior).
- No change to drug-drug (Rule 2), high-acuity (Rule 3), or sepsis (Rule 4) rules — this ticket is Drug-Allergy only. A follow-up can generalize the drug-drug rule with the same pair pattern.
- No changes to the value-set editor CRUD, publishing workflow, or CDS Hook UI.

## Verification

- Order any RxNorm code from `Penicillin Allergy RXNORM(optum)` (e.g. `1008820`, `10591`, `1151156`) for MRN-693833 → `clinical_safety_alerts` Drug-Allergy row appears within seconds, the medication_orders row flips to `HELD_SAFETY_REVIEW`, and the alert banner shows on the patient chart.
- Order a non-penicillin drug (e.g. metoprolol) → no alert (regression).
- Add a new value set + a new `pair:sulfa` dependency row through SQL → no engine redeploy needed; next 5-minute cache refresh (or hard reload) picks it up and starts firing sulfa alerts.
- Value Set Library shows the new "Drug-Allergy Pair" badge on Penicillin/Beta-Lactam Allergens, Penicillin Class Drugs, and Penicillin Allergy RXNORM(optum).