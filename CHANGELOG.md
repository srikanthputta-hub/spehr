# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Earlier project history predates this changelog and is not reconstructed here — entries start from
2026-09-18.

## [Unreleased]

### Fixed

- Discharge summary fabrication (C4): the "Physical Examination on Admission" section no longer
  invents organ-system exam findings ("Pulmonary: Clear to auscultation bilaterally") that were never
  documented — it now cites only the real last-recorded `vitals` row, or says plainly that nothing is
  documented. "Condition at Discharge" and "Hospital Course" no longer assert unobserved claims
  ("afebrile, pain controlled, ambulating independently") when there is no real vitals/data to back
  them. The discharge footer's "Electronically generated and verified by S.P.E.H.R. AI Core" claim
  (nobody verifies it) is replaced with an honest "AI-generated draft — pending clinician verification."
  The signature block now prints the real ordering-physician-of-record and patient name instead of
  being blank. The FHIR Composition pushed to Medblocks (`buildDischargeTransactionBundle`) had the
  exact same fabricated exam/condition hardcoded independently of the markdown narrative — fixed there
  too, and real completed `procedures` are now passed into it (previously omitted entirely). The
  "Clinical Completeness Check" length-of-stay flag is no longer limited to a handful of high-acuity
  chief-complaint regexes — any sub-hour full inpatient stay now raises at least a warning.
- Discharge medication / allergy reconciliation (C3): the discharge medication list is now checked
  against documented allergies using Safety Alerts Engine's own Rule 1 matching helpers
  (`safety-alerts-matching.ts`, reused — not reimplemented). A conflict (e.g. Amoxicillin discharged to
  a documented Penicillin-anaphylaxis patient) raises a hard, visible CRITICAL flag in the "Clinical
  Completeness Check" section and forces that medication's reconciliation decision to `STOP`. Every
  discharge medication now carries an explicit `CONTINUE`/`STOP` decision instead of being
  auto-republished unchanged.
- Discharging clinician's note discarded (H7): the free text typed in the "Confirm Discharge" dialog
  is now woven into the generated discharge summary (and the FHIR Composition) as its own verbatim
  "Clinician's Discharge Note" section — previously it either replaced the entire generated narrative
  wholesale (discarding the real meds/labs/procedures/safety-flag sections) or, in the physician-board
  "View Summary" print view, was read from the database and then explicitly discarded (`void note`)
  in favor of a narrative rebuilt purely from the structured chart.
- Doubled lab label (L19): a `result_value` that already embeds its own test-name prefix (e.g.
  "Hemoglobin: 14.6 g/dL" from a manually-finalized lab row) no longer doubles up against the bolded
  label printed next to it ("Hemoglobin: Hemoglobin: 14.6 g/dL").

### Removed

- Lovable dependency fully removed from the codebase: no `@lovable.dev/*` packages, no `.lovable/`
  directory, no Lovable preview-auth broker, no Lovable-generated MCP routes. The app's own MCP server
  (`/mcp`, 3 tools) now runs on the official `@modelcontextprotocol/sdk`.
- `.env` untracked from git (was previously committed; now removed and covered by an explicit
  `.gitignore` rule, see below).

### Changed

- AI concept extraction (`nlp-extract-concepts` Edge Function) switched from OpenAI to Google Gemini
  (`gemini-3.5-flash-lite`, free tier) via a raw `fetch` call. Env var renamed `OPENAI_API_KEY` →
  `GEMINI_API_KEY`; fallback contract unchanged (429/error → `{concepts: [], error: ...}`, HTTP 200).
- `www.spehr.live` custom domain added alongside `spehr.live`.
- Supabase client error messages (`src/integrations/supabase/client.ts`,
  `client.server.ts`, `auth-middleware.ts`) updated to reference plain environment variables instead of
  "Connect Supabase in Lovable Cloud."
- Site metadata in `src/routes/__root.tsx`: `author` meta tag changed from "Lovable" to "S Group";
  `twitter:site` (`@Lovable`) removed.
- Comment in `src/routes/api/public/umls-search.ts` updated to no longer reference Lovable auth.
- `codeShapeMatches` in `src/hooks/useAutoTerminologist.ts` exported (was module-private); the pending
  `terminology_requests` query now also selects `requested_at`.
- `package.json` gains an explicit `engines` field (`node: "^20.19.0 || >=22.12.0"`).

### Added

- `.gitignore` now explicitly excludes `.env`, `.env.*` (with a `.env.example` exception) to prevent
  secrets from landing in git history.
