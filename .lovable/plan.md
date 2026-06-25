# AUTO API Agent + Terminology Intelligence Suite

Build all 6 parts in one coordinated pass, verifying each layer (DB → server → UI) before moving to the next. UMLS-backed where the spec says, mock where it's clinical confidence/CHV.

## Sequence (each step is verified before the next)

### Step 1 — Foundation: AUTO API engine registration
- Add `AUTO_API` to the agent registry in `useAutomationWatchdog.ts` with 6 loops: `UMLS_LIVE_QUERY`, `NLP_PIPELINE`, `PRE_PUSH_STANDARDISATION`, `DRUG_SAFETY_RXNORM`, `FHIR_SERVER_SYNC`, `NLP_CONFIDENCE_GATE`.
- Update Watchdog widget: "Monitoring 23 loops" grouped by agent (7/4/6/6).
- `useAutomationEnabled` gains a per-engine selector so AUTO API can be toggled independently of the global kill-switch.
- **Verify**: Watchdog widget renders 23 loops, AUTO API card shows in AI Engines list.

### Step 2 — DB: 3 new tables + audit log category
Migration (single file, with GRANTs + RLS):
- `nlp_qa_queue` (mrn, patient_name, complaint_snippet, confidence, proposed_codes jsonb, status, sla_expires_at)
- `custom_value_sets` (name, system, codes jsonb, description, status, published_at)
- `cds_overrides` (mrn, drug_rxnorm, condition_snomed, severity, reason, physician_id, fired_at)
- `auto_api_events` (event_type enum, mrn, actor, facility, payload jsonb)
- Seed 3 sample QA queue rows so the UI is non-empty on first paint.
- **Verify**: tables visible in supabase types regen.

### Step 3 — Server functions / routes
- Extend `src/routes/api/public/umls-search.ts` (already exists) — confirm response shape supports the autocomplete dropdown (canonical term, system, code, typed alias).
- New `src/lib/auto-api.functions.ts`:
  - `getQaQueue`, `approveQaItem`, `editQaItem`, `rejectQaItem` (also writes to `auto_api_events` + on approve, updates `patients.standardized_output`).
  - `publishValueSet`, `listValueSets`.
  - `logCdsOverride`, `getDrugDiseaseContraindications` (hardcoded contraindication table for NSAID/K92.2, BB/J45, ACE/hyperK + extensible).
  - `runPopulationQuery({condition, loinc, facilities, window})`.
  - `getAutoApiLoopStatus` (derives loop health from recent events / fhir sync timestamps).

### Step 4 — Command Center UI
- `src/routes/system-admin.tsx` UI & Feature Controls tab: add **AUTO API** card matching Auto Doc/Auto Admin/Auto IT style, with 6 loop rows, Force Sync button (triggers `useBackgroundFhirSync` manual run), Flush NLP Queue button.
- Header bar: new **AUTO API · ACTIVE/DEGRADED/ERROR** pill next to AI ENGINES, popover with 6 loop statuses.
- Medical Dictionary → **NLP Audit Logs** tab: add QA Governance Queue section + counter badge on tab label. Pending Review badges now show `<confidence>%` and live SLA countdown.
- Medical Dictionary → **Catalog** tab: append "Custom Value Set Builder" collapsible (name, system dropdown, UMLS-backed code search, staging area, publish/draft/clear).
- Medical Dictionary → **Safety Alerts** tab: rewire counters to live data, add "Powered by AUTO API · RxNorm Safety Loop" footer.
- Medical Dictionary → **Live Terminology Matrix**: SNOMED column populates from approved QA items.
- **Audit Log** tab: add AUTO API event source filter + render the 10 new event types with their badges.

### Step 5 — Physician CPOE (Semantic Autocomplete + CDS Hooks)
- New `src/components/cpoe/SemanticAutocomplete.tsx`: debounced 300ms UMLS query, grouped results (Dx / Procedures / Meds), shows canonical term + typed alias + codes, "≈ Mapped via UMLS" badge on selection.
- New `src/components/cpoe/CdsHookAlert.tsx`: drug-allergy (existing) + drug-disease (new) inline alert card with Accept&Override / Change / Dismiss; overrides log to audit + `cds_overrides`.
- Wire into `src/routes/physician-board.tsx` order entry panel.

### Step 6 — Network Analytics Population Health
- New section in `src/routes/analytics.tsx`: SNOMED condition filter, LOINC observation filter, facility multi-select, date window, Run Query → results table + summary cards + CSV export.

### Step 7 — MySpehr CHV translation layer
- `src/lib/chv-translations.ts`: curated map for the codes appearing in synthetic data (CHV is largely static once mapped; UMLS CHV lookups are slow & spotty — using a curated mapping keyed by code is the production-realistic approach).
- New `<PlainEnglish code={...} system={...} />` component with collapsible toggle.
- Global "Plain English Mode: ON | OFF" toggle in `src/routes/my-spehr.tsx`, persisted to localStorage.
- Apply to Conditions, Medications, Lab Reports, Allergies sections.

### Step 8 — Cascade behaviour
When AUTO API is disabled via the toggle:
- Medical Dictionary shows amber "Manual Mode" banner.
- CPOE Semantic Autocomplete falls back to plain text.
- MySpehr hides CHV sub-lines.
- `useBackgroundFhirSync` pauses (gated on `isAutoApiEnabled`).

### Step 9 — Final cross-check pass
- Run typecheck via build pipeline.
- Hit the 4 main routes with playwright headless, screenshot each, confirm: 23 loops shown, AUTO API pill present, QA queue renders, value set builder collapsible visible, autocomplete dropdown opens on type, CDS alert fires on contraindicated order, population query returns rows, MySpehr plain-English lines render.

## Technical details

- UMLS: `/api/public/umls-search` is already implemented and uses `UMLS_API_KEY` (already in secrets). Autocomplete + Value Set Builder + Population Health condition picker all call it client-side via fetch with 300ms debounce.
- Confidence scoring: the existing `nlp_audit_logs.standardized_output` Pending Review rows already carry a confidence number in the AI's response. New `nlp_qa_queue` rows are *derived* from `nlp_audit_logs` where 80 ≤ confidence < 95.
- SLA countdown: client-side `useEffect` ticking against `sla_expires_at` timestamp.
- CHV: curated dictionary keyed by `{system, code}`. Returns null for unknown codes → no plain-English sub-line shown (cleaner than rendering "translation unavailable").
- Drug-disease contraindications: hardcoded JSON in `src/lib/contraindications.ts` (NSAID×K92.2, BB×J45.x, ACEi×hyperK + ~6 more). Checked at CPOE submit time against the patient's active Condition resources.

## Files touched (~22)

New: 1 migration, `src/lib/auto-api.functions.ts`, `src/lib/contraindications.ts`, `src/lib/chv-translations.ts`, `src/components/cpoe/SemanticAutocomplete.tsx`, `src/components/cpoe/CdsHookAlert.tsx`, `src/components/admin/QaGovernanceQueue.tsx`, `src/components/admin/ValueSetBuilder.tsx`, `src/components/admin/AutoApiCard.tsx`, `src/components/admin/AutoApiStatusPill.tsx`, `src/components/analytics/PopulationHealth.tsx`, `src/components/myspehr/PlainEnglish.tsx`.

Edited: `useAutomationWatchdog.ts`, `useAutomationEnabled.ts`, `useBackgroundFhirSync.ts`, `system-admin.tsx`, `physician-board.tsx`, `analytics.tsx`, `my-spehr.tsx`.

## Out of scope (will not touch)

- Existing FHIR push pipeline behaviour (already working).
- Discharge / admit cron jobs.
- Auth or role gating beyond what's already in place.
- Real-time websocket layer changes.
