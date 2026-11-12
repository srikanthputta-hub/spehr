-- Richer Auto Terminologist suggestion-brief fields on terminology_requests,
-- populated by the extended recommendDefinitionType() in
-- src/lib/value-set-registry.ts:
--   - recommended_binding_strength: FHIR ValueSet binding-strength
--     recommendation ("required" | "extensible" | "preferred" | "example"),
--     derived from requesting_consumer / clinical_application.
--   - possible_existing_match: jsonb {value_set_id, name, oid, match_reason}
--     when a published custom_value_sets row might already cover this
--     request's gap (strong seed-code overlap or a strongly matching
--     name) — informational for the human reviewer, never used to skip
--     filing the request.
--   - clinical_focus / data_element_scope / inclusion_criteria /
--     exclusion_criteria: prose matching the exact 4-field "Purpose"
--     taxonomy NLM VSAC's own Metadata tab uses (in that order), so a
--     human steward can paste each straight into the matching VSAC field
--     with minimal editing. For a "grouping" recommendation,
--     inclusion_criteria and exclusion_criteria are left blank — a real
--     VSAC grouping value set inherits its criteria from its component
--     value sets rather than restating them.
--
-- Additive and nullable: existing rows and any caller that doesn't pass
-- these fields are completely unaffected.
alter table public.terminology_requests
  add column if not exists recommended_binding_strength text,
  add column if not exists possible_existing_match jsonb,
  add column if not exists clinical_focus text,
  add column if not exists data_element_scope text,
  add column if not exists inclusion_criteria text,
  add column if not exists exclusion_criteria text;

comment on column public.terminology_requests.recommended_binding_strength is
  'Advisory only: recommendDefinitionType()''s suggested FHIR ValueSet binding strength (required/extensible/preferred/example) for this request, derived from requesting_consumer/clinical_application. The human steward decides the real binding strength when authoring in VSAC.';
comment on column public.terminology_requests.possible_existing_match is
  'Informational only, never blocks filing: {value_set_id, name, oid, match_reason} when a published custom_value_sets row already contains a strong majority of this request''s seed codes, or has a strongly matching name. Null when no such match was found.';
comment on column public.terminology_requests.clinical_focus is
  'Draft prose for VSAC''s own "Clinical Focus" Purpose field (what this value set identifies and why) — a paste-ready starting point for a human steward, not a finished description.';
comment on column public.terminology_requests.data_element_scope is
  'Draft value for VSAC''s own "Data Element Scope" Purpose field: a QDM/FHIR category phrase (e.g. "Medication, Administered or Medication, Order").';
comment on column public.terminology_requests.inclusion_criteria is
  'Draft prose for VSAC''s own "Inclusion Criteria" Purpose field. Left blank for a "grouping" recommendation, matching real VSAC behavior (a grouping value set inherits criteria from its component value sets).';
comment on column public.terminology_requests.exclusion_criteria is
  'Draft prose for VSAC''s own "Exclusion Criteria" Purpose field. Left blank for a "grouping" recommendation, matching real VSAC behavior.';

-- `recommended_type` previously only allowed intensional/extensional;
-- the new conservative "grouping" recommendation (composing already-
-- published value sets instead of drafting a new code list — see
-- maybeRecommendGrouping() in src/lib/value-set-registry.ts) needs the
-- check constraint relaxed to allow it too.
alter table public.terminology_requests
  drop constraint terminology_requests_recommended_type_check;
alter table public.terminology_requests
  add constraint terminology_requests_recommended_type_check
  check (recommended_type is null or recommended_type in ('intensional', 'extensional', 'grouping'));
