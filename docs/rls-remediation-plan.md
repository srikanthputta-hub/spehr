# RLS Remediation Plan — qxyvmvtecnnwqeqaouzh (migration target)

Write-up only. Nothing in this document has been applied. Ground truth pulled live via
`get_advisors`/`list_tables` on 2026-09-18: **26 tables still have RLS disabled** (same 26 named
in the original audit) and **12 SECURITY DEFINER functions** remain anon+authenticated executable
via PostgREST RPC, plus 2 SECURITY DEFINER views (`fhir_export_view`, `unified_patient_view`).

Grepping `src/` and `supabase/functions/` confirms: `src/integrations/supabase/client.ts` ships the
**anon/publishable key to the browser**; `client.server.ts` holds the **service_role key**, used
only in Edge Functions / TanStack server routes. Ghost-tick automation (`useAutomationWatchdog.ts`,
`useAIAutomation.ts`) genuinely runs client-side with the anon key and both reads and writes
`bed_management`, `vitals`, `lab_orders`, `system_settings`, per CLAUDE.md — this is intentional,
not a bug, so policies below preserve anon write access where the simulation depends on it, rather
than blanket-locking to `authenticated`.

## Table-by-table

| Table | Current exposure | Recommended policy |
|---|---|---|
| bed_management | anon SELECT+UPDATE (boards, admit-patient) | anon: SELECT + UPDATE (status/occupant only); block DELETE |
| system_settings | anon SELECT+UPSERT (global automation toggle) | anon: SELECT only; UPDATE via authenticated/admin or edge function |
| vitals | anon SELECT+INSERT+UPDATE (coding pipeline) | anon: SELECT+INSERT+UPDATE; block DELETE |
| lab_orders | anon SELECT+INSERT+UPDATE (boards, ghost labs) | anon: SELECT+INSERT+UPDATE; block DELETE |
| provider_notes | anon SELECT+INSERT (physician/chart UI) | anon: SELECT+INSERT only; no UPDATE/DELETE (append-only) |
| radiology_orders | anon SELECT+INSERT+UPDATE (same pattern as lab_orders) | anon: SELECT+INSERT+UPDATE; block DELETE |
| allergies | anon read/write (chart, safety checks) | anon: SELECT+INSERT+UPDATE; block DELETE |
| patient_transfers | anon write (bed/board flows) | anon: SELECT+INSERT+UPDATE; block DELETE |
| nurse_assignments | anon write (nursing board) | anon: SELECT+INSERT+UPDATE; block DELETE |
| patient_assignments | anon write (assignment boards) | anon: SELECT+INSERT+UPDATE; block DELETE |
| clinical_alerts | anon write (legacy alert path; superseded by `clinical_safety_alerts`, RLS-on) | anon: SELECT only; freeze writes, plan deprecation |
| safety_alerts | 0 rows, no direct code hits — superseded by `clinical_safety_alerts` | anon: SELECT only (effectively dead); revisit deprecation |
| patient_notes | 0 rows, no direct code hits — superseded by `clinical_notes` (RLS-on) | anon: none; lock down, plan deprecation |
| staff_roster | anon SELECT via `routes/api/public/directory.ts` (intentionally public) | anon: SELECT on display columns only; no write |
| terminology_requests | anon insert (auto-terminologist queue) + admin UI read | anon: SELECT+INSERT only; no UPDATE/DELETE |
| nlp_audit_logs | client-inserted audit trail | anon: INSERT+SELECT (append log); no UPDATE/DELETE |
| automation_watchdog_logs | client-inserted cycle logs | anon: INSERT+SELECT (append log); no UPDATE/DELETE |
| api_health_pings | health-check writes | anon: INSERT+SELECT; no UPDATE/DELETE |
| value_set_dependencies | admin UI, low write volume | anon: SELECT only; writes via authenticated/admin |
| clinical_keyword_mappings | reference data | anon: SELECT only |
| cross_reactivity_rules | reference data | anon: SELECT only |
| drug_interaction_rules | reference data | anon: SELECT only |
| simulation_chief_complaints | seed/reference data | anon: SELECT only |
| fhir_patients | written by `fhir-outbound-poll` (service_role) | anon: SELECT only (or none); writes service_role only |
| fhir_observations | written by service_role edge fn | anon: SELECT only; writes service_role only |
| fhir_medication_requests | written by service_role edge fn | anon: SELECT only; writes service_role only |

## SECURITY DEFINER functions (12) — decision, not just RLS

`auto_admit_ghost_patient`, `auto_admit_due_appointments`, `admit_patient_from_appointment`,
`auto_order_ghost_labs`, `auto_report_pending_radiology_orders`, `auto_code_patient_complaint`,
`_ghost_insert_med_from_class`, `trg_patients_auto_code`, `notify_auto_doc`, `notify_fhir_sync`,
`notify_push_to_fhir`, `purge_expired_local_cache` are all anon+authenticated callable. This
**matches the documented ghost-tick architecture** (client-side automation with the anon key) and
may be intentional. Flag for explicit sign-off: either (a) keep as-is and accept "anyone with the
anon key can trigger admissions" as an acceptable simulation-only risk, or (b) move admission
triggers behind an authenticated/service-role gate and have ghost-tick call an edge function
instead. RLS alone does not fix this — these are RPC calls, not table access.

## SECURITY DEFINER views (2)

`fhir_export_view`, `unified_patient_view` bypass RLS by design of the creator's privileges.
Once base-table RLS is on, confirm these views still return the intended (not over-broad) rows,
or convert to SECURITY INVOKER if they don't need elevated access.

## Draft SQL — highest-risk 5 (NOT applied)

```sql
-- bed_management: board views + ghost-tick admit/discharge write status/occupant
ALTER TABLE public.bed_management ENABLE ROW LEVEL SECURITY;
CREATE POLICY bed_mgmt_anon_select ON public.bed_management FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY bed_mgmt_anon_update ON public.bed_management FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- system_settings: single global automation toggle — read is fine, write is high blast-radius
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY sys_settings_anon_select ON public.system_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY sys_settings_auth_update ON public.system_settings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
-- NOTE: current AutoApiCard.tsx / system-admin.tsx upsert from anon-key client — this policy
-- would require moving those writes behind staff auth (profiles/user_roles already RLS-on).

-- vitals: ghost-tick + coding pipeline read/write; no legitimate delete path
ALTER TABLE public.vitals ENABLE ROW LEVEL SECURITY;
CREATE POLICY vitals_anon_rw ON public.vitals FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY vitals_anon_insert ON public.vitals FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY vitals_anon_update ON public.vitals FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- lab_orders: boards + ghost labs read/write; no legitimate delete path
ALTER TABLE public.lab_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY lab_orders_anon_select ON public.lab_orders FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY lab_orders_anon_insert ON public.lab_orders FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY lab_orders_anon_update ON public.lab_orders FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- provider_notes: physician/chart UI inserts notes; append-only, no client update/delete path today
ALTER TABLE public.provider_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY provider_notes_anon_select ON public.provider_notes FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY provider_notes_anon_insert ON public.provider_notes FOR INSERT TO anon, authenticated WITH CHECK (true);
```

## Remaining 21 tables — follow-up verification (2026-09-18)

Re-grepped `src/` and `supabase/functions/` (plus `supabase/migrations/*.sql` for anything a
one-shot data-fixup or the initial `CREATE TABLE`/`GRANT` might hide from an app-code-only grep)
per-table before drafting policies below. Three corrections against the summary table above fell
out of that deeper pass — noted inline where the SQL comments contradict the one-liner in the
table on lines 20-45.

### Corrections found during this pass

- **staff_roster** — the summary row says "anon SELECT via `routes/api/public/directory.ts`
  (intentionally public)". Actually false: that route reads via `supabaseAdmin` (service_role,
  imported from `client.server.ts`), not the anon client. Grepped the rest of `src/` for
  `staff_roster` and found zero anon-client hits. Corrected policy: RLS on, **no** anon/authenticated
  policy at all — service_role bypasses RLS anyway, and nothing else touches this table.
- **terminology_requests** — summary row says "anon: SELECT+INSERT only; no UPDATE/DELETE".
  Actually `processPendingTerminologyRequests()` in `useAutoTerminologist.ts` (anon-key,
  client-side, per CLAUDE.md's demand-queue architecture) `UPDATE`s `status`,
  `quality_gate_notes`, and `resolved_at` on this table directly (e.g. lines ~571-634). Without
  anon UPDATE the entire quality-gate/deprecation flow silently breaks.
- **nlp_audit_logs** — summary row says "no UPDATE/DELETE". Actually `coding-pipeline.ts` does an
  update-if-exists-else-insert against this table keyed on `patient_mrn`, and separately flips
  `status: 'pending' → 'approved'` in bulk — both from the anon-key client. Anon UPDATE is required.
- **value_set_dependencies** — summary row says "writes via authenticated/admin". Actually
  `runPairAutoLinkPass()` in `useAutoTerminologist.ts` (anon-key, client-side) `UPDATE`s
  `value_set_id`/`updated_at` to wire up Drug-Allergy pairs once a matching value set publishes.
  No anon INSERT/DELETE path was found, so those stay admin/service_role-only.

### Genuinely dead tables — candidates for removal, not RLS policies

These have **zero** references in `src/`, `supabase/functions/`, or any `supabase/migrations/*.sql`
function/trigger body — only the auto-generated `src/integrations/supabase/types.ts`, and in a
couple of cases a one-time bootstrap `GRANT` (`supabase/functions/apply-grants/index.ts`) or a
long-past one-off data-fixup migration. This grep-based evidence can't see whether
spehrancillary.live, spehranalytics.live, or MySpehr — the other three consumers, none of which
have code in this repo — ever touch these tables, so it was flagged as unconfirmed. Recommend
dropping them (or archiving, if there's a reason to keep the schema around) rather than writing RLS
policies for tables nothing queries:

- `nurse_assignments` — no query anywhere, ever (not even in a migration).
- `patient_assignments` — only a bootstrap `GRANT` statement; no application query.
- `clinical_alerts` — only a bootstrap `GRANT`; long superseded by `clinical_safety_alerts`
  (RLS-on already). Confirms the suspicion already noted in the summary table.
- `safety_alerts` — only a bootstrap `GRANT` and a one-time demo-data `DELETE` cleanup migration
  (`20260706064856_...sql`); superseded by `clinical_safety_alerts`.
- `patient_notes` — only two old one-off data-fixup migrations (a facility rename, an exclusion
  list); superseded by `clinical_notes` (RLS-on already).
- `api_health_pings` — no query anywhere.
- `simulation_chief_complaints` — appears once, in a migration's system-catalog exclusion list
  (`... NOT IN ('data_provenance','pending_writes',...,'simulation_chief_complaints',...)`) — that's
  incidental, not a read/write of the table's data.
- `fhir_patients` — no query anywhere (distinct from the RLS-on, actively-used `patients` and
  `fhir_resources` tables).
- `fhir_medication_requests` — no query anywhere (distinct from the RLS-on `medication_requests`
  and `medication_orders` tables actually used by the app).

`fhir_observations` is **not** in this dead list — see its policy below — because it does have a
live reader, just no writer found in this repo.

### Production evidence check (2026-09-18) — `pg_stat_user_tables` on `fjncfbqwyrenoavhkvdr`

Queried `pg_stat_user_tables` (`seq_scan`, `idx_scan`, `n_tup_ins`, `n_tup_upd`, `n_tup_del`,
`n_live_tup`, `last_seq_scan`, `last_idx_scan`) on production — the project that has served all
three external consumers plus MySpehr for the project's entire life — for all 10 originally-flagged
tables. This is the evidence the "Conflict, with PM judgment call" section in the roadmap said
hadn't been run yet.

**Result: 9 of the 10 confirmed dead; 1 (`clinical_keyword_mappings`) confirmed live — reclassified
out of this list.**

- **9 confirmed dead** (`nurse_assignments`, `patient_assignments`, `clinical_alerts`,
  `safety_alerts`, `patient_notes`, `api_health_pings`, `simulation_chief_complaints`,
  `fhir_patients`, `fhir_medication_requests`): all show `n_tup_ins`/`n_tup_upd`/`n_tup_del` = 0
  (never written, ever) and `n_live_tup` = 0 (empty today). Their `seq_scan` counts (4–6 each) and
  `last_seq_scan`/`last_idx_scan` timestamps all cluster within roughly one second of each other on
  2026-09-17 20:35:49–50 — consistent with a single introspection/audit batch (e.g. a `list_tables`
  /`get_advisors` pass enumerating every table in the schema once), not distinct application
  traffic from any consumer. `clinical_alerts` and `patient_assignments`/`api_health_pings` show
  minor extra reads (`idx_tup_fetch`/`seq_tup_read` > 0) consistent with encountering now-vacuumed
  dead tuples from the historical one-off cleanup migrations already noted above, not live queries.
  No consumer — this repo's or any of the other three — has generated a single write against any of
  these 9 tables in production's entire life. Verdict stands: genuinely dead.
- **1 confirmed live — `clinical_keyword_mappings` reclassified, removed from the dead list above.**
  `seq_scan = 60,792`, with `last_seq_scan` on 2026-09-18 21:31:11 — a full day after, and
  completely decoupled from, the 2026-09-17 introspection batch that touched the other 9 tables.
  That volume and recency cannot be explained by a one-time audit pass; something is querying this
  table repeatedly and recently in production, almost certainly one of the three consumers with no
  code in this repo (spehrancillary.live, spehranalytics.live, or MySpehr). This is exactly the
  failure mode the roadmap's "Conflict, with PM judgment call" section warned about — grep-based
  zero-references was wrong for this table. It still has zero writes ever recorded
  (`n_tup_ins`/`upd`/`del` = 0), so it's read-only reference data being consumed live, not something
  actively written to. **Do not drop or archive `clinical_keyword_mappings`.** It already has a
  correct, live-compatible policy drafted in the summary table above (line-item "reference data" →
  `anon: SELECT only`) — keep that RLS policy, just don't touch the table itself.

### Draft SQL — remaining 11 tables with a real query path (NOT applied)

```sql
-- radiology_orders: same shape as lab_orders — boards/chart/patient views read+write via anon,
-- auto-doc.server.ts (service_role) also inserts ghost-ordered studies; no legitimate delete path
ALTER TABLE public.radiology_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY radiology_orders_anon_select ON public.radiology_orders FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY radiology_orders_anon_insert ON public.radiology_orders FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY radiology_orders_anon_update ON public.radiology_orders FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- allergies: chart UI + safety-conflicts engine read/write directly via anon client; no delete path
ALTER TABLE public.allergies ENABLE ROW LEVEL SECURITY;
CREATE POLICY allergies_anon_select ON public.allergies FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY allergies_anon_insert ON public.allergies FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY allergies_anon_update ON public.allergies FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- patient_transfers: physician-board.tsx inserts requests; admin-dashboard.tsx approves/denies
-- (UPDATE status only) — both anon client; no delete path
ALTER TABLE public.patient_transfers ENABLE ROW LEVEL SECURITY;
CREATE POLICY patient_transfers_anon_select ON public.patient_transfers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY patient_transfers_anon_insert ON public.patient_transfers FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY patient_transfers_anon_update ON public.patient_transfers FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- staff_roster: routes/api/public/directory.ts reads it exclusively via supabaseAdmin
-- (service_role) — no anon-client hit anywhere. RLS on, deliberately NO anon/authenticated
-- policy; service_role bypasses RLS and is the only caller.
ALTER TABLE public.staff_roster ENABLE ROW LEVEL SECURITY;

-- terminology_requests: anon-key demand queue both inserts requests and updates them
-- (status/quality_gate_notes/resolved_at) as processPendingTerminologyRequests() runs — see
-- correction above; no delete path
ALTER TABLE public.terminology_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY term_requests_anon_select ON public.terminology_requests FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY term_requests_anon_insert ON public.terminology_requests FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY term_requests_anon_update ON public.terminology_requests FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- nlp_audit_logs: coding-pipeline.ts upserts (update-if-exists else insert) and bulk-approves
-- from the anon client — see correction above; no delete path
ALTER TABLE public.nlp_audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY nlp_audit_anon_select ON public.nlp_audit_logs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY nlp_audit_anon_insert ON public.nlp_audit_logs FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY nlp_audit_anon_update ON public.nlp_audit_logs FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- automation_watchdog_logs: append-only cycle log, insert-only from anon client
-- (useAutomationWatchdog.ts / useAutoTerminologist.ts) — no update/delete observed
ALTER TABLE public.automation_watchdog_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY watchdog_logs_anon_select ON public.automation_watchdog_logs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY watchdog_logs_anon_insert ON public.automation_watchdog_logs FOR INSERT TO anon, authenticated WITH CHECK (true);

-- value_set_dependencies: admin UI + runPairAutoLinkPass() read/update from anon client (only
-- value_set_id/updated_at) — see correction above; no anon insert/delete path found, leave those
-- to authenticated/admin or service_role (auto-doc.server.ts already uses service_role)
ALTER TABLE public.value_set_dependencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY vsd_anon_select ON public.value_set_dependencies FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY vsd_anon_update ON public.value_set_dependencies FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- cross_reactivity_rules: governed reference data read by safety-conflicts.ts via anon client;
-- no write path in this codebase (authored via admin UI elsewhere / value_set publish flow)
ALTER TABLE public.cross_reactivity_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY cross_reactivity_anon_select ON public.cross_reactivity_rules FOR SELECT TO anon, authenticated USING (true);

-- drug_interaction_rules: same pattern as cross_reactivity_rules
ALTER TABLE public.drug_interaction_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY drug_interaction_anon_select ON public.drug_interaction_rules FOR SELECT TO anon, authenticated USING (true);

-- fhir_observations: PatientReportedVitals.tsx SELECTs + realtime-subscribes via the anon
-- client; NO writer found anywhere in src/ or supabase/functions/ (0 rows on
-- qxyvmvtecnnwqeqaouzh today) — population path is presumably external (MySpehr or a
-- not-yet-built sync) or this feature is simply dormant pending real data. SELECT-only is safe
-- either way; add INSERT/UPDATE only once a concrete writer shows up.
ALTER TABLE public.fhir_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fhir_observations_anon_select ON public.fhir_observations FOR SELECT TO anon, authenticated USING (true);
```
