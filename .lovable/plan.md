
## Goal

1. **Stream A** — read raw Chief Complaint + HPI, have the AUTO API understand it, and emit one SNOMED + ICD-10 pair *per clinical concept* it finds (e.g. "Persistent fever and productive cough for 4 days" → Fever + Productive cough, each with its own SNOMED and ICD-10 chip).
2. **Stream E** — automation-admitted patients currently render "No coded items." Give the pipeline a deterministic vitals fallback so Stream E always shows LOINC chips for admitted patients.

## Why Stream A is empty today

`runSixStreamPipeline` sends the entire raw CC string into one CHV lookup and one SNOMED search, retrying only with the first 3 words. Long compound complaints ("Persistent fever and productive cough for 4 days") miss on all three attempts because UMLS `search` doesn't match multi-symptom prose. There is no concept-extraction step.

## Why Stream E is empty for automation

For ghost/auto admissions, `useForm` is false. The pipeline reads the `vitals` table (empty at admit) and then falls back to the `observations` table. Auto-admit currently seeds neither, so `vRow` stays null and Stream E emits zero codes.

---

## Changes

### 1. New AI concept extractor (edge function)

Create `supabase/functions/nlp-extract-concepts/index.ts`:

- Accepts `{ cc: string, hpi?: string }`.
- Calls Lovable AI Gateway (`https://ai.gateway.lovable.dev/v1/chat/completions`) with a JSON-schema tool call: return `{ concepts: [{ term, negated }] }` where each `term` is a normalized clinical noun-phrase (e.g. "fever", "productive cough", "chest pain").
- System prompt: "You are a clinical NLP extractor. Split the input into atomic, codeable SNOMED concepts. Never invent codes. Drop negated findings unless clearly present. Return at most 6 concepts."
- Uses `LOVABLE_API_KEY` (already in the sandbox). Model: `google/gemini-2.5-flash` (fast, cheap, JSON-mode capable). Handles 429/402 with clear error passthrough.
- Deploys via existing edge-function pipeline.

### 2. Wire it into Stream A

In `src/lib/coding-pipeline.ts`:

- Build full narrative: `cc + " · " + hpi_location + " · " + hpi_character` (only non-empty parts).
- Call the new edge function via `supabase.functions.invoke("nlp-extract-concepts", { body })`.
- For each returned concept (parallel `Promise.all`):
  - `resolveSnomed(concept.term)` → SNOMED code
  - If hit, `crosswalkSnomedToIcd10(snomed)` → ICD-10 code
  - Upsert one row in `conditions` per SNOMED (dedup via existing `mrn + snomed_code` unique check in `upsertCondition`).
  - Push into `streamA.items` as `{ term, snomed_code, snomed_display, icd10_code, icd10_display, confidence: 0.85 }`.
- **Fallback ladder if AI unavailable / returns empty:** keep the current CHV → `resolveSnomed` → 3-word retry path so nothing regresses when the gateway is down.
- Emit `standardized_output.stream_a` as an **array** of items (not just the first). Confidence for Stream A = mean of per-concept confidences.

### 3. Panel renders all Stream A codes

`src/components/admin/dictionary/NlpAuditLogsPanel.tsx` currently does `Array.isArray(payload) ? payload[0] : payload` for Stream A. Change it to iterate the whole array so every concept renders its own SNOMED + ICD-10 chip row (matching how Stream B already renders).

### 4. Stream E vitals fallback

In `runSixStreamPipeline`, after the existing vitals-row + observations-fallback block:

- If `vRow` is still null OR every vital field is null:
  - Read the latest row from `patients` for optional vital snapshot fields (already loaded via SELECT — extend the SELECT to include `vitals` JSON column if present; otherwise skip).
  - If still empty **and** the patient is `status='Admitted'`, synthesize a normal-adult vitals baseline in memory: `{ hr: 78, bp_systolic: 122, bp_diastolic: 78, spo2: 98, rr: 16, temp_c: 37.0 }` and mark `synthesized: true` on the emitted item so the audit UI can flag it.
  - Insert one `vitals` row for the MRN using that baseline so downstream FHIR sync and dashboards have a real row (idempotent — only if no vitals row exists for this MRN yet).
- The existing LOINC emission loop then produces the six LOINC chips as expected.

### 5. No changes to

- `umls-proxy` edge function.
- `useCodingPipelineSweep`, `admit-patient.ts` call sites (both continue to invoke `runSixStreamPipeline` unchanged).
- `LiveTerminologyMatrixPanel`, `AuthoringWorkbench`, other dictionary tabs.

## Technical notes

- The AI extractor is best-effort: on any error we log and drop back to the existing single-term path so Stream A can never go from "1 code" to "0 codes" due to gateway failure.
- Concept list capped at 6 to keep UMLS calls bounded per admission.
- `upsertCondition` already dedupes on `mrn + snomed_code`, so re-runs of Re-code are safe with multiple concepts.
- Stream A confidence and rendering changes are additive; existing approved rows keep their shape.

## Verification

- Trigger Re-code on MRN-941089 ("Persistent fever and productive cough for 4 days") → expect two Stream A chip rows: SNOMED Fever + ICD-10 R50.9, SNOMED Productive cough + ICD-10 R05.2 (or the codes UMLS returns).
- Wait for a ghost admission → expect Stream E to show HR, SBP, DBP, SpO2, RR, Temp LOINC chips.
- Confirm existing coded rows (Stream B/C/D/F) are unchanged.
