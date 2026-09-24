-- Fixes a real bug in 20260924210000_office_board_rooms.sql, caught by a
-- live smoke test: that migration gave home_room/room a column-level
-- DEFAULT 'lobby'. Postgres applies column defaults before a BEFORE INSERT
-- trigger runs, so NEW.home_room was never actually NULL inside
-- office_board_on_status_change() -- the trigger's role -> room CASE
-- mapping (added in 20260924213000) silently never ran, and every fresh
-- INSERT with home_room/room omitted landed in 'lobby' regardless of role.
-- Dropping the defaults lets the trigger fully own the value; it already
-- sets both to a sane default (role mapping, or 'lobby' for unmapped
-- roles) whenever they're NULL, and the NOT NULL constraint is checked
-- after the trigger runs, not before.

ALTER TABLE public.office_board
  ALTER COLUMN home_room DROP DEFAULT,
  ALTER COLUMN room DROP DEFAULT;
