# Terminology / FHIR Content Roadmap — Clinical Informaticist Recommendations

Author: clinical informaticist pass, 2026-09-18. Read-only recommendation — no code or data changed.

## Context

- Crosswalk logic, working demo codes (38341003→I10, 44054006→E11, 59282003→I26, 22298006 `$lookup`), and the
  known non-bug UMLS gaps (stroke/pneumonia SNOMED→ICD-10-CM) have already been verified as solid — this doc does
  not revisit them.
- Migration-target `qxyvmvtecnnwqeqaouzh` has 15 starter `custom_value_sets` covering "the key safety-alert
  categories" vs. production's 53. That gap (38 sets) is the primary content backlog.
- The Auto Terminologist is demand-mode only: it drafts a value set (or flags UMLS-suggested matches) *only* when
  a consumer engine (Safety Alerts, Auto Doc, Auto Admin) hits a coverage gap and files a `terminology_requests`
  row. It cannot pre-populate breadth — it will only ever backfill what the simulation happens to trip over.
- `runQualityGate()` (`src/hooks/useAutoTerminologist.ts`) is purely structural: missing code/display/vocabulary,
  unsupported vocabulary, too-short display text, duplicate codes, and `codeShapeMatches()` (regex shape check,
  e.g. SNOMED 6–18 digits). It has no clinical-plausibility check — a request with correctly-shaped but wrong or
  mismatched codes passes cleanly.
- Interoperability: `fhir-proxy`'s write contract (PUT-with-deterministic-stable-id upsert, `src/lib/fhir-bundle.ts`
  around the "FHIR UPSERT contract" comment) is enforced only by this codebase's own `validateBundleEntries()` and
  documented only in an inline code comment. MySpehr reads the same Medblocks FHIR server independently and does
  not talk to S.P.E.H.R. directly, so it has no access to that comment or to any published schema/ID convention —
  it can only infer the shape of what it reads. There is no shared IG, no versioned resource-shape contract, and
  no compatibility test that would catch either side drifting (e.g. a new stable-ID scheme, a new required
  extension, a Composition structure change) before it silently breaks the other consumer.

## Recommendations (prioritized)

1. **Prioritize the next value-set batch by consumer-engine coverage gaps, not by copying production's 53 wholesale.**
   Before authoring anything, pull `terminology_requests` (all statuses, not just `pending`) and
   `auto_terminologist_log` action=`gated` rows to see which categories the simulation itself is actually asking
   for and repeatedly failing quality on — that is real, demand-validated demand, cheaper to close than guessing
   from production's list. Where production's 53 do outrank the current 15 with no matching request history yet
   (e.g., likely gaps: medication-class-level allergy cross-reactivity sets, problem-list "chronic condition"
   groupers beyond the safety-alert set, and encounter/visit-reason value sets feeding Auto Admin), seed those
   deliberately as human-authored drafts through the Authoring Workbench rather than waiting for the demand queue
   to eventually notice — a startup population with only 15 sets will otherwise take many simulation cycles to
   organically discover categories production already knows it needs.

2. **Add a lightweight clinical-plausibility check to the quality gate, separate from `runQualityGate()`'s
   structural checks.** Today a request can have a perfectly-shaped SNOMED code (right digit count, non-empty
   display) that is simply the wrong concept for the stated `clinical_application` (e.g., a procedure code seeded
   into a diagnosis-only value set), and nothing catches it before a draft is created. Add one more gate call —
   crosswalk-and-compare: run the seed code through the existing UMLS crosswalk/lookup (already wired for
   Cross-Map Studio) and flag (not block) drafts where the returned UMLS preferred term has low string overlap
   with the request's own `display`/`justification` text, surfacing it as a `quality_gate_notes` warning for the
   human reviewer in the Value Set Library rather than silently auto-drafting. Keep human-in-the-loop intact — this
   is a warning annotation, not a new blocking gate, consistent with "never auto-publish."

3. **Close the interoperability gap with a versioned, published FHIR resource-shape contract — an IG-lite doc plus
   a schema-diff CI check — rather than leaving the stable-ID/upsert convention as a code comment only S.P.E.H.R.
   can see.** Concretely: (a) extract the resource shapes S.P.E.H.R. actually writes (Condition, AllergyIntolerance,
   MedicationRequest, MedicationAdministration, Observation, Composition, ServiceRequest, DiagnosticReport — the
   same list already enumerated in `fhir-proxy/index.ts`'s `PASSTHROUGH_RESOURCE_TYPES`) into a short markdown IG
   documenting the stable-ID derivation rule per resource type, required extensions/codes, and the PUT-upsert
   invariant; (b) publish it somewhere MySpehr's maintainers (even if that's future-you) can read without spelunking
   S.P.E.H.R.'s source; (c) add a CI smoke test that POSTs a sample bundle to a test FHIR server and asserts the
   resulting resource shape matches the documented contract, so a future change to `fhir-bundle.ts` that alters IDs
   or structure fails CI instead of silently breaking MySpehr's read path. This is the direct, low-cost fix for the
   "no shared contract" risk the earlier audit flagged — it doesn't require coordinating a joint release, just
   making the existing implicit contract explicit and machine-checked on the S.P.E.H.R. side.

4. **Instrument and report on `umls-suggested` staged requests specifically — they're the cheapest content-growth
   lever and are currently invisible outside the log.** When `tryUmlsSuggestion()` finds ≥3 plausible existing UMLS
   value sets, it stages them and skips self-authoring, but nothing in the Medical Dictionary UI currently
   highlights "N value sets are one human click away from import" as a distinct, actionable queue separate from
   drafted/gated requests. Surfacing this as its own filter/tab in the Auto Terminologist Activity panel would let
   a reviewer clear real content-breadth backlog in minutes instead of it aging silently as `status:
   "umls-suggested"` rows nobody looks at.

5. **Do not expand `custom_value_sets` by bulk-importing production's 53 verbatim.** Per the migration section of
   CLAUDE.md, production's data is deliberately not being migrated, and production's value-set list was built up
   organically alongside ~400K rows of simulation history it isn't inheriting either — some of those 53 may exist
   only because of long-since-superseded chief-complaint phrasing or a consumer engine that no longer runs the way
   it did when they were drafted. Treat production's list as a *hint list to triage*, not a manifest to copy;
   recommendation #1's request-log-driven approach is the safer path to parity.
