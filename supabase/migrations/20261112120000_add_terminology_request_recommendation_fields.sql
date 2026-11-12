-- Add structured intensional/extensional recommendation fields to
-- terminology_requests, populated by the new recommendDefinitionType()
-- helper (src/lib/value-set-registry.ts) at request-filing time.
--
-- Part of the new value-set lifecycle: Auto Terminologist now only ever
-- produces a "suggestion brief" on this row (requested_name,
-- justification, recommended_type, reasoning, candidate codes/root
-- concept) for a human to review and author the real value set in VSAC —
-- it never self-drafts a custom_value_sets row with a fabricated OID.
--
-- Additive and nullable: existing rows and any caller that doesn't pass
-- these fields are completely unaffected.
alter table public.terminology_requests
  add column if not exists recommended_type text,
  add column if not exists reasoning text,
  add column if not exists suggested_root_concept jsonb;

alter table public.terminology_requests
  add constraint terminology_requests_recommended_type_check
  check (recommended_type is null or recommended_type in ('intensional', 'extensional'));

comment on column public.terminology_requests.recommended_type is
  'Advisory only: Auto Terminologist''s suggested VSAC authoring approach (intensional vs. extensional) for this request''s candidate codes, from recommendDefinitionType() in src/lib/value-set-registry.ts. The human steward decides and authors the real value set in VSAC.';
comment on column public.terminology_requests.reasoning is
  'Specific justification for recommended_type, derived from a real UMLS hierarchy lookup (hierarchyExpand / resolveAndValidate via the umls-proxy edge function) rather than a hardcoded guess.';
comment on column public.terminology_requests.suggested_root_concept is
  'When recommended_type = intensional: the {code, display} UMLS hierarchy anchor a human could use as the VSAC rule root concept. Null for extensional recommendations or when no clean hierarchy fit was found.';
