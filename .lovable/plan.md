## Goal

Add a runtime Safety Alerts engine driven by the **published** value sets in `custom_value_sets` (looked up by name, not OID), covering 4 rules. Writes only to `clinical_safety_alerts` + `auto_doc_logs`. Existing SafetyQueue UI, Approval Trail, NLP pipeline are not modified.

## Value-set lookups (by name, cached in memory)

Loaded lazily on first use, refreshed every 5 min:

| Rule | Value set name | Vocabulary | Type |
|---|---|---|---|
| 1 | Penicillin Class Drugs | RxNorm | extensional |
| 1 | Allergy Substances | SNOMED CT | intensional (`<<105590001`) |
| 2 | Anticoagulants | RxNorm | extensional |
| 3 | High-Acuity ED Presentations | SNOMED CT | extensional |
| 4 | Sepsis Indicators | SNOMED CT | extensional |

Extensional match = code equality inside the value set's `codes[]`. Intensional SNOMED match = reuse the existing `/api/public/umls-validate-code` endpoint (subsumption via UMLS ancestors). If the endpoint fails, fail open (skip the rule for that trigger) and log an error to `auto_doc_logs`.

NSAIDs (for Rule 2 "anticoagulant + NSAID") come from a small hard-coded RxNorm SCUI whitelist embedded in the engine (there is no NSAIDs value set among the 13 published sets).

## New module: `src/lib/safety-alerts-engine.ts`

Exports:
- `ensureValueSetsLoaded()` — cached fetch from `custom_value_sets` filtered by name + `status='published'`.
- `runMedicationOrderRules(order)` — Rules 1 & 2. Reads patient allergies (from `allergies` table) and other active meds (`medication_orders`) for same MRN.
- `runNlpApprovalRules(auditRow)` — Rules 3 & 4. Reads each code in `standardized_output` for SNOMED codes and checks membership.
- Shared helpers: `codeInExtensional(vs, system, code)`, `codeInIntensional(vs, system, code)` (calls validate endpoint), `fireAlert(...)`.

Dedup: uses a stable id key `${mrn}|${ruleKey}|${triggerCode}` and does an upsert-style insert guarded by a pre-select on `clinical_safety_alerts` — the composite key uniqueness is enforced in-app (no schema change required). "Once per patient per admission" = per current `patients.admission_time`; if same MRN re-admits (new admission_time), key resets automatically because the check filters `created_at >= admission_time`.

`fireAlert()` writes one row to `clinical_safety_alerts` with:
- `kind`: existing values `Drug-Allergy` / `Drug-Drug` for Rules 1 & 2; a new `Clinical-Acuity` value for Rules 3 & 4 (see migration below).
- `family`: rule-specific message (e.g. `⚠ Bleeding Risk — concurrent anticoagulant therapy detected`).
- `severity`: `HIGH` (Rules 1 & 2) / `CRITICAL` (Rules 3 & 4).
- `drug` field reused as the triggering entity (medication name or SNOMED display).
- `status = 'Pending Review'`, `auto_resolve_at = null` (see below).
- Also inserts an `auto_doc_logs` row: `level='error'`, `stage='safety-alert'`, `mrn`, message and metadata.

## Manual-only dismissal

Existing SafetyQueue auto-resolves every alert after 2 minutes. Because the spec says these alerts must not auto-resolve, `fireAlert` sets `auto_resolve_at = null` and the SafetyQueue tick already skips rows whose `auto_resolve_at` is in the future indefinitely — but the current fallback uses `created_at + 2min`. Small tweak in `SafetyQueue`'s `tick()` (system-admin.tsx line ~1467): only auto-resolve when `auto_resolve_at` is non-null. No other UI change. This preserves auto-resolve for legacy alerts while making new engine-fired alerts stick until a clinician acts.

## Trigger wiring

1. **Medication orders** — new hook `useSafetyAlertsWatcher` mounted once in `src/routes/__root.tsx` (client-only). It subscribes via Supabase realtime to `INSERT` on `medication_orders` and calls `runMedicationOrderRules`. Realtime is already enabled for other tables in this project.
2. **NLP approvals** — same hook listens for the existing `window` `nlp:approved` event dispatched from `NlpAuditLogsPanel`, then re-fetches the just-approved `nlp_audit_logs` row and calls `runNlpApprovalRules`.

Both paths run entirely client-side; no edge function or DB trigger changes.

## Migration

One migration to relax the `kind` CHECK constraint so new rule types can persist:

```sql
ALTER TABLE public.clinical_safety_alerts
  DROP CONSTRAINT clinical_safety_alerts_kind_check;
ALTER TABLE public.clinical_safety_alerts
  ADD CONSTRAINT clinical_safety_alerts_kind_check
  CHECK (kind IN ('Drug-Allergy','Drug-Drug','Clinical-Acuity'));
```

No new tables, no policy changes, no new secrets.

## Files touched

- **new** `src/lib/safety-alerts-engine.ts`
- **new** `src/hooks/useSafetyAlertsWatcher.ts`
- **edit** `src/routes/__root.tsx` — mount watcher (single hook call)
- **edit** `src/routes/system-admin.tsx` — one-line change: gate SafetyQueue auto-resolver on `auto_resolve_at != null`
- **migration** — relax `kind` CHECK constraint

Existing hardcoded `CROSS_REACT` / `DDI_RULES` regexes in `src/lib/safety-conflicts.ts` remain (they power the legacy `loadSafetyQueue` diagnostic helper, not the DB queue) — the spec says "replace hardcoded lists in the Safety Alerts engine", and the engine is the new module writing to `clinical_safety_alerts`.

## Out of scope (unchanged)

- NLP pipeline
- Approval Trail
- Audit Log display
- Existing SafetyQueue UI (aside from the one-line auto-resolve gate)
- Value set library
