## Goal

Automation must only order medications that carry an RxNorm code, and the code has to be present on the row **at insert time** — never resolved later. This closes the last window where a med can slip past the Safety Alerts Engine because `rxnorm_code` is still `null` on the initial `INSERT`.

## Root cause today

`useAIAutomation.seedAdmission` inserts each protocol medication with only free-text `medication_name` / `drug_name`. `autoCodeMedication` resolves the RxNorm code via UMLS **after** the insert. Even with the previous fix that awaits coding before the cascade, the row spends a brief window in `medication_orders` without `rxnorm_code`, and any med the resolver can't map ends up ordered without a code at all.

## Fix

### 1. `src/lib/complaint-protocols.ts`
- Extend `ProtocolMed` with required fields: `rxnorm_code: string; rxnorm_display: string;`.
- Fill in verified RxCUIs for every medication in every protocol (Aspirin 1191, Nitroglycerin 4917, Morphine 7052, Albuterol 435, Methylprednisolone 6902, Furosemide 4603, Atorvastatin 83367, Labetalol 6185, Ondansetron 26225, Ketorolac 35827, Piperacillin-Tazobactam 33533, Vancomycin 11124, Acetaminophen 161, Pantoprazole 40790, Ceftriaxone 2193, Ibuprofen 5640, Regular Insulin 253182, Sodium Chloride 313002, Potassium Chloride 8591, Thiamine 10454, Dextrose 4850, Lisinopril 29046, Famotidine 4278, plus the DEFAULT set).

### 2. `src/hooks/useAIAutomation.ts` (`seedAdmission`)
- Filter `finalMeds` to drop any entry without `rxnorm_code` (defensive — the type change already enforces it, but skip anything falsy so a future protocol edit can't regress).
- Include `rxnorm_code`, `rxnorm_display`, `ingredient_rxcui`, and `coding_source: "protocol"` in the initial `medication_orders` insert.
- Immediately after the insert, fire `runMedicationOrderRules(...)` with the seeded code so Rule 1 evaluates on this insert path even before `autoCodeMedication` re-runs.
- Keep the existing `await autoCodeMedication(...)` call: it now becomes a no-op patch (values already match) plus a redundant safety re-check, which is cheap and stays consistent with manual CPOE.

### 3. Non-goals
- No changes to manual CPOE flow, physician board UI, or the Safety Alerts Engine rules.
- No new tables or schema changes.
- No changes to lab orders.
- No change to `drug-rxnorm-map.ts` (protocol codes are declared inline; the map still serves other resolvers).

## Verification
- Admit a penicillin-allergic patient whose complaint routes to the "fever" protocol (Ceftriaxone is a cephalosporin, not penicillin, so this is a regression check) → cascade completes normally.
- Admit a patient whose complaint routes to a protocol where you temporarily swap in Amoxicillin (RxCUI 723) for testing, with a penicillin allergy on file → the alert fires immediately on the `INSERT` (not after coding) and the order is held.
- Inspect a freshly seeded `medication_orders` row: `rxnorm_code`, `rxnorm_display`, and `coding_source = 'protocol'` are all populated at insert time.
- `tsgo` clean.