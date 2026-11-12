-- Gap 1 + Gap 2 support for Auto Terminologist (terminology_requests):
--
--  - known_vsac_candidates: jsonb array of {oid, name, title, publisher} —
--    recommendDefinitionType()'s findKnownVsacCandidates() output (Gap 1,
--    searches VSAC's own catalog via the new `vsacSearch` umls-proxy action
--    for an already-published value set from a recognized national
--    steward), surfaced to the human reviewer in the Suggestion Brief
--    panel's "Found in VSAC — Consider Importing" callout.
--  - linked_vsac_oid: the real NLM VSAC OID a human steward pastes in via
--    "Link VSAC OID" (AutoTerminologistActivity.tsx) once they've started
--    authoring the recommended value set in real VSAC (Gap 2).
--  - last_vsac_check_at: when the background cycle
--    (src/hooks/useAutoTerminologist.ts) last polled linked_vsac_oid via
--    the umls-proxy vsacExpand action, so it checks at most roughly
--    once/day (matching VSAC's own daily publish/expansion cadence)
--    instead of every 10-minute tick. Cleared back to null whenever
--    linked_vsac_oid is set/changed so the next cycle checks it promptly.
--  - vsac_expansion_preview: jsonb {oid, name, title, type, codes, total} —
--    the vsacExpand result once linked_vsac_oid is confirmed published
--    (status flips to 'ready_to_import'). Preview only: the background
--    cycle that populates this NEVER writes to custom_value_sets itself —
--    importing always requires an explicit human click on "Import Now" in
--    AutoTerminologistActivity.tsx (see buildVsacImportInsert() in
--    src/lib/value-set-registry.ts, shared with the Value Set Library's
--    existing "Import from VSAC" dialog).
--
-- All four columns are additive and nullable: existing rows, and any
-- caller that doesn't pass them, are completely unaffected. No CHECK
-- constraints exist on this table today, so none are added here either.
alter table public.terminology_requests
  add column if not exists known_vsac_candidates jsonb,
  add column if not exists linked_vsac_oid text,
  add column if not exists last_vsac_check_at timestamptz,
  add column if not exists vsac_expansion_preview jsonb;

comment on column public.terminology_requests.known_vsac_candidates is
  'jsonb array of {oid, name, title, publisher} -- actively-published VSAC ValueSets from a recognized steward that recommendDefinitionType()''s findKnownVsacCandidates() (Gap 1) found via the vsacSearch umls-proxy action for this request''s requested_name. Informational only, never blocks filing. Null/empty when no candidates were found.';
comment on column public.terminology_requests.linked_vsac_oid is
  'The real NLM VSAC OID a human steward has pasted in via "Link VSAC OID" once they have started authoring this request''s recommended value set in real VSAC (Gap 2). Null until linked. Setting/changing this clears last_vsac_check_at so the background cycle checks it on its next pass.';
comment on column public.terminology_requests.last_vsac_check_at is
  'When useAutoTerminologist.ts''s background cycle last polled linked_vsac_oid via the umls-proxy vsacExpand action, to cap polling at roughly once/day (matching VSAC''s own daily publish cadence) instead of every 10-minute tick. Null until the first check.';
comment on column public.terminology_requests.vsac_expansion_preview is
  'jsonb {oid, name, title, type, codes, total} -- the vsacExpand result once linked_vsac_oid is confirmed published (status flips to ready_to_import). Preview only: the background detection cycle that populates this NEVER writes to custom_value_sets -- importing always requires an explicit human click on "Import Now" in AutoTerminologistActivity.tsx.';
