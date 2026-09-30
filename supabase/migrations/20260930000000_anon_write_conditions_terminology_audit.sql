-- The app runs entirely as the `anon` role (no Supabase Auth session), so
-- any RLS policy scoped to {authenticated} silently blocks the app for
-- every real user. This mirrors the anon-write pattern already applied to
-- medication_orders and lab_orders in prior fixes.

-- conditions: coder "Approve" flow (approveMrnCoding) and the Stream B
-- (Past Medical History) upsert both write to this table as anon and were
-- previously RLS-blocked entirely (conditions_write_auth was {authenticated}
-- only, with no anon policy at all).
drop policy if exists "conditions_write_auth" on public.conditions;

create policy "conditions_anon_insert"
  on public.conditions
  for insert
  to anon, authenticated
  with check (true);

create policy "conditions_anon_update"
  on public.conditions
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "conditions_anon_delete"
  on public.conditions
  for delete
  to anon, authenticated
  using (true);

-- medical_terminology: System Admin > Medical Dictionary add/remove flows
-- and the ensureTerminology() auto-grow helper all write as anon.
drop policy if exists "Authenticated can insert terminology" on public.medical_terminology;
drop policy if exists "Authenticated can update terminology" on public.medical_terminology;
drop policy if exists "Authenticated can delete terminology" on public.medical_terminology;

create policy "medical_terminology_anon_insert"
  on public.medical_terminology
  for insert
  to anon, authenticated
  with check (true);

create policy "medical_terminology_anon_update"
  on public.medical_terminology
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "medical_terminology_anon_delete"
  on public.medical_terminology
  for delete
  to anon, authenticated
  using (true);

-- terminology_audit: resolveConcept() is the single gateway for every
-- coding decision app-wide and writes an audit row for every hit/miss/
-- reject/error as anon. It was previously 100% non-functional because
-- INSERT (and SELECT, read back by Step8Surfacing.tsx) were
-- {authenticated} only with no anon policy.
drop policy if exists "terminology_audit_insert_auth" on public.terminology_audit;
drop policy if exists "terminology_audit_read_auth" on public.terminology_audit;

create policy "terminology_audit_anon_insert"
  on public.terminology_audit
  for insert
  to anon, authenticated
  with check (true);

create policy "terminology_audit_anon_select"
  on public.terminology_audit
  for select
  to anon, authenticated
  using (true);
