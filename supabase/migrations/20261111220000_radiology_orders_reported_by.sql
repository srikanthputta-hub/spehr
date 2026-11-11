-- radiology_orders had no column recording WHO actually signed/submitted a
-- report -- only resulted_at (a timestamp) and status. The auto-finalize
-- cron (auto_report_pending_radiology_orders(), see
-- 20260929000100_radiology_auto_report_respect_automation_flag.sql) and a
-- radiologist's manual "Submit Official Report" action (radiology-board.tsx)
-- both wrote the exact same columns, so the UI had no way to tell a real
-- radiologist read apart from an auto-generated boilerplate one -- it just
-- rendered the currently-active radiologist's name on every single reported
-- row, including ones the cron had fabricated (108/108 "Reported" studies
-- live, at time of writing, carried this fabricated-looking attribution).
--
-- Add reported_by so the manual path can stamp the locally-selected
-- radiologist identity (useActiveStaff("Rad").name), the same device-local
-- attribution convention already used for medication_orders.administered_by
-- (PR #50) and author_id elsewhere (PR #47). This migration is purely
-- additive and does not touch auto_report_pending_radiology_orders() --
-- the cron keeps leaving this column NULL, which the UI now uses to render
-- "Auto-Generated" instead of a fabricated-looking named attribution.
ALTER TABLE public.radiology_orders ADD COLUMN IF NOT EXISTS reported_by text;

COMMENT ON COLUMN public.radiology_orders.reported_by IS
  'Locally-selected staff identity (useActiveStaff("Rad").name) that submitted this study''s official report via radiology-board.tsx. NULL for every row the auto_report_pending_radiology_orders() cron finalized (the cron never sets this column) -- the UI renders those as "Auto-Generated" rather than attributing them to whichever radiologist happens to be the active device identity. No real auth in this app, so even a non-null value is device-local attribution, not a verified identity -- same convention as medication_orders.administered_by and system_settings.author_id.';
