-- Fix a gap in 20260924210000_office_board_rooms.sql: the status-change
-- trigger's INSERT branch defaulted home_room to 'lobby' for ANY new row,
-- but the role -> room mapping only ever ran as a one-time backfill UPDATE
-- against the 13 rows that already existed at migration time. Any row
-- inserted after that (e.g. by office-task-bridge.cjs, which upserts by an
-- arbitrary --id rather than always targeting an existing role-<role> row)
-- would get home_room='lobby' regardless of its actual role. Apply the same
-- role -> room mapping on insert whenever home_room isn't explicitly passed.

CREATE OR REPLACE FUNCTION public.office_board_on_status_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.home_room IS NULL THEN
      NEW.home_room := CASE NEW.role
        WHEN 'boss'             THEN 'exec_suite'
        WHEN 'security-auditor' THEN 'ops_tech'
        WHEN 'devops'           THEN 'ops_tech'
        WHEN 'coder'            THEN 'open_workspace'
        WHEN 'data-engineer'    THEN 'open_workspace'
        WHEN 'tester'           THEN 'open_workspace'
        WHEN 'reviewer'         THEN 'open_workspace'
        ELSE 'lobby'
      END;
    END IF;
    IF NEW.room IS NULL THEN
      NEW.room := NEW.home_room;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.home_room IS NULL THEN
    NEW.home_room := OLD.home_room;
  END IF;

  -- Task just finished: working -> idle. Send them for coffee.
  IF OLD.status = 'working' AND NEW.status = 'idle' AND NEW.on_break_until IS NULL THEN
    NEW.on_break_until := now() + interval '5 seconds';
    NEW.room := 'breakroom';
  END IF;

  -- New task picked up: clear any break, head back toward home room
  -- (office_room_tick will pull them into 'conference' instead if this
  -- turns out to be a shared-pipeline meeting).
  IF NEW.status = 'working' AND OLD.status IS DISTINCT FROM 'working' THEN
    NEW.on_break_until := NULL;
    IF NEW.room = 'breakroom' THEN
      NEW.room := NEW.home_room;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
