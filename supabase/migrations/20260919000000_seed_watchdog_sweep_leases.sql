-- ============================================================================
-- Seed automation_leases rows for the watchdog and coding-pipeline-sweep
-- engines, extending the atomic DB-backed lease introduced in
-- 20260918000000_automation_leases.sql (see docs/leader-election-fix-design.md)
-- from useAutoTerminologist.ts to useAutomationWatchdog.ts and
-- useCodingPipelineSweep.ts.
--
-- claim_automation_lease() only ever UPDATEs an existing row (it never
-- INSERTs), so each engine name a hook calls with must have a seed row here
-- before that hook's code ships, or every claim silently returns zero rows
-- forever (fails safe — the engine just never runs — but never runs).
--
-- Three engines, matching the three independent lease-guarded loops being
-- migrated off localStorage:
--   automation_watchdog        — useAutomationWatchdog.ts's tick() heartbeat
--   automation_watchdog_ghost  — useAutomationWatchdog.ts's ghostTick()
--                                 (separate engine because it has its own,
--                                 much longer, cadence)
--   coding_pipeline_sweep      — useCodingPipelineSweep.ts's tick()
-- ============================================================================

INSERT INTO public.automation_leases (engine, holder, leased_until, last_run_at)
VALUES
  ('automation_watchdog',       NULL, '-infinity'::timestamptz, '-infinity'::timestamptz),
  ('automation_watchdog_ghost', NULL, '-infinity'::timestamptz, '-infinity'::timestamptz),
  ('coding_pipeline_sweep',     NULL, '-infinity'::timestamptz, '-infinity'::timestamptz)
ON CONFLICT (engine) DO NOTHING;
