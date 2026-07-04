## Fix 1 — Expand ACS CDS trigger codes

In `src/lib/cds-order-sets.ts`, add the four symptom SNOMED CT codes to the existing `ACS_CODES` Set on line 76:

- `425677008` — Pain radiating to left arm  
- `4568003` — Retrosternal pain  
- `59139008` — Crushing chest pain  
- `29857009` — Chest pain  

No other code changes. The `matchTriggers` logic already checks `ACS_CODES.has(c)` alongside `highAcuity.has(c)` for the `acs` trigger, so these new codes will fire the ACS protocol when they appear in an approved NLP result.

## Fix 2 — Deferred
Critical lab result trigger (troponin) is noted as a separate future build; out of scope for this plan.

## Validation
- Build/typecheck after the edit to confirm the Set syntax is valid.
- Quick code review: verify only `ACS_CODES` line changed.