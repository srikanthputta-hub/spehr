# Coder Recommendations — Forward-Looking Engineering Work

Author: coder subagent, 2026-09-18. Scope: beyond `docs/backlog.md` (which already covers the
security P0s, leader-election fix, a11y, and the CRLF lint plan). This is about what makes the
codebase sustainable to keep building on.

## 1. Close the CI gap the lint/test cleanup will otherwise leave open
`.github/workflows/ci.yml` only runs `tsc --noEmit` and `npm run build` — no `eslint`, no
`vitest`, despite `vitest.config.ts` and a test file existing (untracked) in the repo. Backlog
item #6 fixes the ~67k CRLF errors so `eslint` *can* pass, but nothing currently wires it into CI,
so the gate stays theoretical even after that cleanup lands. Add two steps (`npm run lint`,
`npm run test`) to `ci.yml` in the same PR that lands the CRLF fix, not later.
**Rationale:** a lint/test fix nobody enforces decays back to ~67k errors within a few PRs.
**Effort:** S (once backlog #6 is merged).

## 2. Add a validation boundary (zod) around external/jsonb data instead of `as any`
717 occurrences of `as any` across 72 files, concentrated around Supabase `jsonb` columns
(`standardized_output`, `seed_codes`, `quality_gate_notes`) and raw UMLS/FHIR fetch responses in
the edge functions (`fhir-proxy`, `umls-proxy`) and `useAutoTerminologist.ts`. These are exactly
the boundaries where the two-Supabase-project migration and the Gemini swap can silently change
shape without a compile or runtime error surfacing. Introduce zod schemas at the I/O edges (edge
function request/response, UMLS API responses, jsonb reads) and parse-then-narrow instead of
casting.
**Rationale:** turns silent shape-drift (the most likely failure mode of an in-flight DB
migration) into a loud, caught error at the boundary instead of a downstream `undefined` bug.
**Effort:** M — start with `fhir-proxy` and `umls-proxy` (highest blast radius), then
`useAutoTerminologist.ts`.

## 3. Give the generated Supabase types a narrow, hand-maintained domain layer
`src/integrations/supabase/types.ts` (raw generated types) is consumed directly across all UI
domains (physician/finance/admissions/admin/patient) — there is no intermediate `src/types/`
layer that expresses what a `TerminologyRequest`, `ValueSet`, or `Patient` *means* once its jsonb
columns are decoded. Every consumer re-derives that shape ad hoc, which is a second source of the
`as any` pattern (distinct from #2's external-boundary problem — this one is internal, DB-shape
duplication). Add a thin `src/types/domain/*.ts` module that wraps the generated types with the
narrowed/decoded shapes, and have the 5 board domains import from there instead of the raw
generated file.
**Rationale:** one place to update when a column's real shape changes, instead of N call sites;
directly shrinks the `as any` count.
**Effort:** M.

## 4. Write down the actual cross-repo data contract between S.P.E.H.R., MySpehr, and the FHIR server
The three domains share data (same FHIR server, same terminology conventions, same DB shape
during the migration) but the only contract today is prose in this repo's `CLAUDE.md` — MySpehr's
repo has no visibility into it, and there's no schema/type artifact either side can diff against.
A silent break (e.g., a FHIR field rename during the Supabase migration, or a `custom_value_sets`
status enum change) would show up as a runtime mismatch in MySpehr with no compile-time signal.
Publish a minimal shared contract: either a small versioned npm package (types + zod schemas from
#2/#3) both repos import, or at minimum a `docs/fhir-contract.md` enumerating the FHIR resource
shapes and terminology fields both sides depend on, updated as part of any schema-changing PR.
**Rationale:** the migration currently in progress is the highest-risk moment for exactly this
kind of undetected drift, and it affects a second codebase this one doesn't test against.
**Effort:** M (docs-only start) to L (actual shared package).

## 5. Grow test coverage starting at the two highest-blast-radius seams, not evenly
Only one test file exists repo-wide. Rather than a broad "add tests" effort (already flagged in
backlog #4 as L/not started), prioritize order: (a) the `fhir-proxy` DELETE guard (the P0 vuln
fix in backlog #1 — deserves a regression test so it can never silently regress on redeploy), and
(b) the automation engine's gating logic (`runQualityGate`, `tryUmlsSuggestion` thresholds in
`useAutoTerminologist.ts`) since it runs unattended every ~10 min against production-shaped data
with no human review before a `pending` row either drafts or gets held.
**Rationale:** these two are the least observable, highest-consequence code paths in the repo —
worth testing before broad coverage that would dilute effort across low-risk UI code.
**Effort:** S for (a), M for (b).
