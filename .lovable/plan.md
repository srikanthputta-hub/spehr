
## What to build

Insert a validation gate between each stream's coding and the `nlp_audit_logs` write. Every coded concept is validated against its stream's published value set. Invalid concepts flip the audit row to `needs_review`, block auto-approve, and render with a yellow warning badge. Proxy failures fail open and log to `auto_doc_logs`.

## Stream → value set map

| Stream | Value set name (in `custom_value_sets`) | Vocab | Type |
|---|---|---|---|
| A · Chief Complaint | ED Chief Complaints | SNOMED CT | intensional `<<404684003` |
| B · PMH | Chronic Conditions | SNOMED CT | intensional `<<27624003` |
| C · Meds | Medicinal Products | SNOMED CT | intensional `<<763158003` |
| D · Allergies | Allergy Substances | SNOMED CT | intensional `<<105590001` |
| E · Vitals | Vital Signs Observations | LOINC | extensional |
| F · Labs | ED Lab Panels | LOINC | extensional |

Streams A–D SNOMED intensional roots are those in the existing rows (no schema change; the ECL/root is implied by the value set name — validator reads it from `intensional_rule` when present or from a hardcoded fallback map keyed by value set name for the four that ship with a NULL `intensional_rule`).

## Files to add / change

### 1. New server route: `src/routes/api/public/umls-validate-code.ts`

Public POST endpoint. Body:
```json
{ "code": "267036007", "system": "SNOMED CT", "valueSetOid": "2.16..." }
```
Response: `{ ok: true, valid: boolean, reason?: string }` or `{ ok: false, error: string }` (502 on upstream failure).

Logic:
- Load the value set from `custom_value_sets` by `oid` using a server publishable Supabase client (already-permissive RLS).
- Extensional: `valid = codes[].code.includes(code)` (string compare, normalised).
- Intensional SNOMED with ECL `<<root`: `valid = (code === root) || (root ∈ ancestors(code))`. Call UMLS `https://uts-ws.nlm.nih.gov/rest/content/current/source/SNOMEDCT_US/{code}/ancestors?apiKey=…&pageSize=200` and scan for the root. Cache by `code` in a module-level `Map` for the process lifetime.
- Non-SNOMED intensional / unknown type → return `{ ok: true, valid: true }` (nothing to check).

### 2. New helper: `src/lib/nlp-validate.ts`

- Loads and caches the 6 value set `{name, oid, type, vocabulary, intensional_rule|fallback root}` on first call (single `SELECT` from `custom_value_sets`).
- Exports `validateStreamCodes(streamKey, codes: Array<{system, code}>)`:
  - Calls `/api/public/umls-validate-code` per unique code.
  - Returns `{ perCode: Map<code, {valid, reason}>, gateStatus: "ok" | "needs_review" | "unavailable" }`.
  - `unavailable` = every call errored → fail open (caller treats as valid) and logs one row to `auto_doc_logs` with `level='error'`, `stage='nlp-validate'`, `mrn`.

### 3. Wire into `src/lib/coding-pipeline.ts` (around line 760, just before writing the audit row)

- For each stream, project its coded items to `{system, code}` pairs (SNOMED/ICD-10/RxNorm/LOINC as appropriate — validate only against the stream's designated vocabulary: A/B → SNOMED codes, C → RxNorm→SNOMED not needed; C's value set is SNOMED Medicinal Products so validate items' `snomed_code` when present, else skip that item since RxNorm-only meds can't be validated against a SNOMED VS — treat as `valid: true` so we don't over-flag, D → substance_snomed only, E → LOINC map values, F → loinc_code).
- Run all six `validateStreamCodes` calls in parallel.
- Decorate each stream's `items` with `validated: boolean` and optional `validation_reason` per item.
- If ANY stream returns `gateStatus === "needs_review"`, set `auditPayload.status = "needs_review"` instead of `"pending"`. Otherwise keep `"pending"`.
- Add `auditPayload.validation = { a: gateStatus, b: …, …, f: … }` inside `extraction_mapping` so the UI can render badges.
- Adjust the existing "existing pending row" lookup to match `.in("status", ["pending","needs_review"])` so re-code updates in place.

### 4. `src/components/admin/dictionary/NlpAuditLogsPanel.tsx`

- Fetch query: change `.eq("status","pending")` to `.in("status", ["pending","needs_review"])`. All other behaviour unchanged.

### 5. `src/components/admin/dictionary/AuditCard.tsx`

- Extend `AuditRow.status` union to include `"needs_review"`.
- Header badge: when `status === "needs_review"` show yellow `⚠ Needs Review` pill instead of `Pending`.
- `autoApprove` gate: block firing when `status === "needs_review"` — countdown bar hidden, timer never scheduled. Manual Approve button remains enabled (explicit human approval required).
- `StreamCard`: read `mapping.validation?.[k]` and, when `needs_review`, show a small yellow warning chip next to the stream StatusPill. Per-pill: if an item has `validated === false`, wrap the `CodePill` in a yellow ring (`ring-1 ring-amber-400`) and add title="Not in value set".

### 6. `NlpApprovalTrail.tsx`

No change. It only reads `status === "approved"` rows, which are unaffected.

## Behaviour summary

- Valid concepts → identical to today (row status `pending`, 3-min auto-approve, then Approval Trail).
- Invalid concepts → row status `needs_review`, yellow warning, no auto-approve, waits for human Approve click (which flips to `approved` as today).
- Proxy total failure for a stream → treated as valid (fail-open), one `auto_doc_logs` error row per pipeline run per stream.

## Technical notes

- No DB migration: `nlp_audit_logs.status` is `text`, accepts new value directly.
- No new secrets: reuses `UMLS_API_KEY` already present.
- Value set OIDs are read from DB at runtime, so future OID rotations don't require code changes; only value set *names* are hardcoded in the stream map.
- Approval Trail hard cap of 50 and non-reorder invariants unchanged.
- Auto Terminologist gap-detector behaviour unchanged.
