-- Phase D: hospital-wide recall/follow-up appointment settings.
--
-- Confirmed no naming collision with Phase A's `autopay_after_minutes` or
-- Phase C's `patients.admission_source` -- system_settings is a single-row
-- (id = 1) table, and these are new columns.
--
-- recall_offset_min_hours/_max_hours default to 26/32h (compressed from an
-- unrealistic "7 days" so a recall lands inside the 36h data-retention
-- window per the confirmed decision).

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS recall_enabled          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recall_rate             numeric NOT NULL DEFAULT 0.3,
  ADD COLUMN IF NOT EXISTS recall_offset_min_hours int     NOT NULL DEFAULT 26,
  ADD COLUMN IF NOT EXISTS recall_offset_max_hours int     NOT NULL DEFAULT 32;
