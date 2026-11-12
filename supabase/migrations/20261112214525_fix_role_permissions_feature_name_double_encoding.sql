-- role_permissions.feature_name values were seeded with an emoji prefix
-- that was UTF-8 encoded, then re-interpreted as Latin-1 and re-encoded as
-- UTF-8 (classic "double encoding" mojibake), e.g.
--   "â Approve Patient Transfer"  (should read "✅ Approve Patient Transfer")
--   "ð§« Run Lab Sample"           (should read "🧫 Run Lab Sample")
-- Confirmed via a live query against all 5 facilities: 108 rows across 16
-- distinct feature_key values (all feature_key LIKE 'btn_%'), consistent
-- garbling in every row -- a data problem from the original seeding, not a
-- per-render glitch.
--
-- This strips the garbled, unrecoverable emoji-byte prefix entirely and
-- keeps the clean descriptive text. The UI (system-admin.tsx) now renders
-- a real lucide-react icon per row, keyed off feature_key, instead of
-- relying on an emoji embedded in this text field -- so the prefix is
-- removed rather than re-encoded correctly and re-introduced.
--
-- Only rows whose feature_name starts with a non-printable-ASCII byte are
-- touched; e.g. "dictionary.steward_approve" rows ("Steward — approve/
-- publish value sets") are untouched because they already start with a
-- plain ASCII character and were never corrupted.
update public.role_permissions
set feature_name = regexp_replace(feature_name, '^[^ -~]+\s*', '')
where feature_name ~ '^[^ -~]';
