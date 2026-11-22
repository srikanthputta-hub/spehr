-- L13: same class of bug as the earlier `role_permissions.feature_name`
-- double-encoding fix (20261112214525_fix_role_permissions_feature_name_
-- double_encoding.sql) — a handful of seed rows went through a UTF-8 ->
-- read-as-Latin-1 -> re-encoded-as-UTF-8 round trip somewhere between the
-- migration file (which already has the correct text, e.g. migration
-- 20260706113423_409015a3-...sql literally contains
-- 'Auto IT — Discharge Dual-Coding') and what actually landed in the
-- database. The em dash's 3-byte UTF-8 sequence (E2 80 94) got reinterpreted
-- as three Latin-1 codepoints and re-encoded, which renders as "â" followed
-- by two unprintable control characters — visually "Auto IT â [blank]
-- Discharge Dual-Coding" in the Medical Dictionary admin UI (QA's "garbled"
-- report).
--
-- Unlike the feature_name case (an unrecoverable emoji prefix that was
-- stripped), this corruption IS cleanly recoverable: reading the corrupted
-- text's codepoints back as Latin-1 bytes and decoding those as UTF-8
-- reconstructs the exact original string (verified against all 6 affected
-- rows via a live SELECT before writing this migration — every one round-
-- trips to the clean, correctly-punctuated original with no loss).
--
-- Confirmed via a live query across every free-text column in
-- value_set_dependencies and custom_value_sets: exactly 5 rows in
-- value_set_dependencies.consumer and 1 row in custom_value_sets.description
-- contain the "â" mojibake marker. Every other value_set_dependencies row
-- (e.g. "Safety Alerts Engine · Drug-Allergy", "Auto Admin — Invoice
-- Risk-Adjustment Coding") already uses correct Unicode punctuation and is
-- untouched by the `LIKE '%â%'` filter below.
update public.value_set_dependencies
set consumer = convert_from(convert_to(consumer, 'LATIN1'), 'UTF8')
where consumer like '%â%';

update public.custom_value_sets
set description = convert_from(convert_to(description, 'LATIN1'), 'UTF8')
where description like '%â%';
