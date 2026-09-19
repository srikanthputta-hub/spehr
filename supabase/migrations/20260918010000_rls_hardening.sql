-- ============================================================================
-- RLS hardening — qxyvmvtecnnwqeqaouzh (migration target), pre-cutover
-- ----------------------------------------------------------------------------
-- Consolidates docs/rls-remediation-plan.md into one applyable migration.
-- Confirmed by the user (2026-09-18) before writing this file:
--   1. The 12 SECURITY DEFINER admission/automation functions stay
--      anon/authenticated-callable as-is. RPC calls, not table access — no
--      RLS change addresses or is needed for that surface. Not touched here.
--   2. Harden qxyvmvtecnnwqeqaouzh fully before any production cutover; this
--      migration is one part of that hardening.
--
-- Order: dead tables are DROPped first (Section 1) so that (a) we never
-- spend effort writing RLS policies for a table about to disappear, and
-- (b) CASCADE on any of these surfaces a hidden FK dependency immediately,
-- before Section 2's policy work. Section 2 then enables RLS + policies on
-- the 17 remaining tables with a real query path, per the plan's
-- "highest-risk 5" + "remaining 11" draft SQL, plus clinical_keyword_mappings
-- (reference data, anon SELECT-only per the plan's summary table — drafted
-- here because it was missing from both of the plan's SQL blocks).
--
-- All statements are idempotent / safe to re-run:
--   - DROP TABLE ... IF EXISTS ... CASCADE
--   - ALTER TABLE ... ENABLE ROW LEVEL SECURITY (naturally idempotent — a
--     no-op if RLS is already enabled on the table)
--   - DROP POLICY IF EXISTS <name> ON <table>; immediately before every
--     CREATE POLICY
--
-- Does NOT touch supabase/migrations/20260918000000_automation_leases.sql or
-- its automation_leases table/functions — that migration is separate and
-- already handles its own RLS (deny-all via zero policies).
-- ============================================================================


-- ============================================================================
-- SECTION 1 — drop confirmed-dead tables (9)
-- ----------------------------------------------------------------------------
-- Evidence: docs/rls-remediation-plan.md, "Production evidence check
-- (2026-09-18) — pg_stat_user_tables on fjncfbqwyrenoavhkvdr" section. All 9
-- show n_tup_ins/n_tup_upd/n_tup_del = 0 and n_live_tup = 0 on production —
-- the project that has served every consumer (this repo, spehrancillary.live,
-- spehranalytics.live, MySpehr) for the project's entire life — with
-- seq_scan/last_seq_scan timestamps clustering around a single 2026-09-17
-- introspection batch, not application traffic. Verdict: genuinely dead.
-- NOTE: clinical_keyword_mappings was originally flagged alongside these 9 by
-- grep but was reclassified LIVE by the same production evidence check
-- (seq_scan = 60,792, recent/recurring last_seq_scan) — it is deliberately
-- NOT in this list; see Section 2 for its RLS policy instead.
-- ============================================================================

-- nurse_assignments: zero writes ever in production; no query anywhere in
-- src/, supabase/functions/, or any migration.
DROP TABLE IF EXISTS public.nurse_assignments CASCADE;

-- patient_assignments: zero writes ever in production; only a bootstrap
-- GRANT statement, no application query.
DROP TABLE IF EXISTS public.patient_assignments CASCADE;

-- clinical_alerts: zero writes ever in production; only a bootstrap GRANT,
-- long superseded by clinical_safety_alerts (RLS-on already).
DROP TABLE IF EXISTS public.clinical_alerts CASCADE;

-- safety_alerts: zero writes ever in production; only a bootstrap GRANT and
-- a one-time demo-data DELETE cleanup migration, superseded by
-- clinical_safety_alerts.
DROP TABLE IF EXISTS public.safety_alerts CASCADE;

-- patient_notes: zero writes ever in production; only old one-off
-- data-fixup migrations, superseded by clinical_notes (RLS-on already).
DROP TABLE IF EXISTS public.patient_notes CASCADE;

-- api_health_pings: zero writes ever in production; no query anywhere.
DROP TABLE IF EXISTS public.api_health_pings CASCADE;

-- simulation_chief_complaints: zero writes ever in production; only
-- incidental mention in a migration's system-catalog exclusion list, not a
-- read/write of the table's data.
DROP TABLE IF EXISTS public.simulation_chief_complaints CASCADE;

-- fhir_patients: zero writes ever in production; no query anywhere, distinct
-- from the RLS-on, actively-used patients and fhir_resources tables.
DROP TABLE IF EXISTS public.fhir_patients CASCADE;

-- fhir_medication_requests: zero writes ever in production; no query
-- anywhere, distinct from the RLS-on medication_requests/medication_orders
-- tables actually used by the app.
DROP TABLE IF EXISTS public.fhir_medication_requests CASCADE;


-- ============================================================================
-- SECTION 2 — enable RLS + policies on remaining 17 tables
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 2.1 Highest-risk 5 (docs/rls-remediation-plan.md, "Draft SQL — highest-risk 5")
-- ----------------------------------------------------------------------------

-- bed_management: board views + ghost-tick admit/discharge write status/occupant
ALTER TABLE public.bed_management ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bed_mgmt_anon_select ON public.bed_management;
CREATE POLICY bed_mgmt_anon_select ON public.bed_management FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS bed_mgmt_anon_update ON public.bed_management;
CREATE POLICY bed_mgmt_anon_update ON public.bed_management FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- system_settings: single global automation toggle — read is fine, write is high blast-radius
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sys_settings_anon_select ON public.system_settings;
CREATE POLICY sys_settings_anon_select ON public.system_settings FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS sys_settings_auth_update ON public.system_settings;
CREATE POLICY sys_settings_auth_update ON public.system_settings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
-- NOTE: current AutoApiCard.tsx / system-admin.tsx upsert from anon-key
-- client — this policy requires moving those writes behind staff auth
-- (profiles/user_roles already RLS-on). Flagged in the plan, not resolved
-- by this migration.

-- vitals: ghost-tick + coding pipeline read/write; no legitimate delete path
ALTER TABLE public.vitals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vitals_anon_rw ON public.vitals;
CREATE POLICY vitals_anon_rw ON public.vitals FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS vitals_anon_insert ON public.vitals;
CREATE POLICY vitals_anon_insert ON public.vitals FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS vitals_anon_update ON public.vitals;
CREATE POLICY vitals_anon_update ON public.vitals FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- lab_orders: boards + ghost labs read/write; no legitimate delete path
ALTER TABLE public.lab_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lab_orders_anon_select ON public.lab_orders;
CREATE POLICY lab_orders_anon_select ON public.lab_orders FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS lab_orders_anon_insert ON public.lab_orders;
CREATE POLICY lab_orders_anon_insert ON public.lab_orders FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS lab_orders_anon_update ON public.lab_orders;
CREATE POLICY lab_orders_anon_update ON public.lab_orders FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- provider_notes: physician/chart UI inserts notes; append-only, no client update/delete path today
ALTER TABLE public.provider_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS provider_notes_anon_select ON public.provider_notes;
CREATE POLICY provider_notes_anon_select ON public.provider_notes FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS provider_notes_anon_insert ON public.provider_notes;
CREATE POLICY provider_notes_anon_insert ON public.provider_notes FOR INSERT TO anon, authenticated WITH CHECK (true);


-- ----------------------------------------------------------------------------
-- 2.2 Remaining 11 (docs/rls-remediation-plan.md, "Draft SQL — remaining 11 tables")
-- ----------------------------------------------------------------------------

-- radiology_orders: same shape as lab_orders — boards/chart/patient views read+write via anon,
-- auto-doc.server.ts (service_role) also inserts ghost-ordered studies; no legitimate delete path
ALTER TABLE public.radiology_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS radiology_orders_anon_select ON public.radiology_orders;
CREATE POLICY radiology_orders_anon_select ON public.radiology_orders FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS radiology_orders_anon_insert ON public.radiology_orders;
CREATE POLICY radiology_orders_anon_insert ON public.radiology_orders FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS radiology_orders_anon_update ON public.radiology_orders;
CREATE POLICY radiology_orders_anon_update ON public.radiology_orders FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- allergies: chart UI + safety-conflicts engine read/write directly via anon client; no delete path
ALTER TABLE public.allergies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allergies_anon_select ON public.allergies;
CREATE POLICY allergies_anon_select ON public.allergies FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS allergies_anon_insert ON public.allergies;
CREATE POLICY allergies_anon_insert ON public.allergies FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS allergies_anon_update ON public.allergies;
CREATE POLICY allergies_anon_update ON public.allergies FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- patient_transfers: physician-board.tsx inserts requests; admin-dashboard.tsx approves/denies
-- (UPDATE status only) — both anon client; no delete path
ALTER TABLE public.patient_transfers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS patient_transfers_anon_select ON public.patient_transfers;
CREATE POLICY patient_transfers_anon_select ON public.patient_transfers FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS patient_transfers_anon_insert ON public.patient_transfers;
CREATE POLICY patient_transfers_anon_insert ON public.patient_transfers FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS patient_transfers_anon_update ON public.patient_transfers;
CREATE POLICY patient_transfers_anon_update ON public.patient_transfers FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- staff_roster: routes/api/public/directory.ts reads it exclusively via supabaseAdmin
-- (service_role) — no anon-client hit anywhere. RLS on, deliberately NO anon/authenticated
-- policy; service_role bypasses RLS and is the only caller.
ALTER TABLE public.staff_roster ENABLE ROW LEVEL SECURITY;
-- Deliberately no CREATE POLICY statements for this table.

-- terminology_requests: anon-key demand queue both inserts requests and updates them
-- (status/quality_gate_notes/resolved_at) as processPendingTerminologyRequests() runs — see
-- plan's "Corrections found during this pass"; no delete path
ALTER TABLE public.terminology_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS term_requests_anon_select ON public.terminology_requests;
CREATE POLICY term_requests_anon_select ON public.terminology_requests FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS term_requests_anon_insert ON public.terminology_requests;
CREATE POLICY term_requests_anon_insert ON public.terminology_requests FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS term_requests_anon_update ON public.terminology_requests;
CREATE POLICY term_requests_anon_update ON public.terminology_requests FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- nlp_audit_logs: coding-pipeline.ts upserts (update-if-exists else insert) and bulk-approves
-- from the anon client — see plan's corrections section; no delete path
ALTER TABLE public.nlp_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nlp_audit_anon_select ON public.nlp_audit_logs;
CREATE POLICY nlp_audit_anon_select ON public.nlp_audit_logs FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS nlp_audit_anon_insert ON public.nlp_audit_logs;
CREATE POLICY nlp_audit_anon_insert ON public.nlp_audit_logs FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS nlp_audit_anon_update ON public.nlp_audit_logs;
CREATE POLICY nlp_audit_anon_update ON public.nlp_audit_logs FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- automation_watchdog_logs: append-only cycle log, insert-only from anon client
-- (useAutomationWatchdog.ts / useAutoTerminologist.ts) — no update/delete observed
ALTER TABLE public.automation_watchdog_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS watchdog_logs_anon_select ON public.automation_watchdog_logs;
CREATE POLICY watchdog_logs_anon_select ON public.automation_watchdog_logs FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS watchdog_logs_anon_insert ON public.automation_watchdog_logs;
CREATE POLICY watchdog_logs_anon_insert ON public.automation_watchdog_logs FOR INSERT TO anon, authenticated WITH CHECK (true);

-- value_set_dependencies: admin UI + runPairAutoLinkPass() read/update from anon client (only
-- value_set_id/updated_at) — see plan's corrections section; no anon insert/delete path found,
-- leave those to authenticated/admin or service_role (auto-doc.server.ts already uses service_role)
ALTER TABLE public.value_set_dependencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vsd_anon_select ON public.value_set_dependencies;
CREATE POLICY vsd_anon_select ON public.value_set_dependencies FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS vsd_anon_update ON public.value_set_dependencies;
CREATE POLICY vsd_anon_update ON public.value_set_dependencies FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- cross_reactivity_rules: governed reference data read by safety-conflicts.ts via anon client;
-- no write path in this codebase (authored via admin UI elsewhere / value_set publish flow)
ALTER TABLE public.cross_reactivity_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cross_reactivity_anon_select ON public.cross_reactivity_rules;
CREATE POLICY cross_reactivity_anon_select ON public.cross_reactivity_rules FOR SELECT TO anon, authenticated USING (true);

-- drug_interaction_rules: same pattern as cross_reactivity_rules
ALTER TABLE public.drug_interaction_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS drug_interaction_anon_select ON public.drug_interaction_rules;
CREATE POLICY drug_interaction_anon_select ON public.drug_interaction_rules FOR SELECT TO anon, authenticated USING (true);

-- fhir_observations: PatientReportedVitals.tsx SELECTs + realtime-subscribes via the anon
-- client; NO writer found anywhere in src/ or supabase/functions/ (0 rows on
-- qxyvmvtecnnwqeqaouzh today) — population path is presumably external (MySpehr or a
-- not-yet-built sync) or this feature is simply dormant pending real data. SELECT-only is safe
-- either way; add INSERT/UPDATE only once a concrete writer shows up.
ALTER TABLE public.fhir_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fhir_observations_anon_select ON public.fhir_observations;
CREATE POLICY fhir_observations_anon_select ON public.fhir_observations FOR SELECT TO anon, authenticated USING (true);


-- ----------------------------------------------------------------------------
-- 2.3 clinical_keyword_mappings — reference data, live in production
-- ----------------------------------------------------------------------------
-- Per docs/rls-remediation-plan.md summary table ("clinical_keyword_mappings |
-- reference data | anon: SELECT only") and the "Production evidence check"
-- section: this table was initially flagged as a grep-dead candidate but
-- reclassified LIVE (seq_scan = 60,792, recent/recurring last_seq_scan,
-- decoupled from the one-time introspection batch that touched the 9 tables
-- actually dropped in Section 1) — almost certainly queried by one of the
-- other three consumers (spehrancillary.live, spehranalytics.live, MySpehr)
-- with no code in this repo. Zero writes ever recorded, so SELECT-only is
-- correct. This table's policy was present in the plan's summary table but
-- missing from both of its "Draft SQL" code blocks — added here.
ALTER TABLE public.clinical_keyword_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ckm_anon_select ON public.clinical_keyword_mappings;
CREATE POLICY ckm_anon_select ON public.clinical_keyword_mappings FOR SELECT TO anon, authenticated USING (true);
