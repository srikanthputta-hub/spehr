-- RuFlo Office room simulation: gives office_board a physical layout to
-- render against instead of a flat "13 rows" list. See src/routes/office.tsx
-- for the visual side and .claude/helpers/office-task-bridge.cjs for the
-- writer contract (unchanged — this migration is additive only, every
-- existing `start`/`complete`/`fail` call still works with no code change).
--
-- Rooms: exec_suite, ops_tech, open_workspace, conference, breakroom, lobby.
-- home_room is a static per-role assignment (below). room is where the
-- agent is rendered right now — it only ever differs from home_room while
-- on a break or in a shared-pipeline meeting.
--
-- Behavior, driven by two pieces:
--   1. trg_office_board_status_change (row trigger, fires instantly): the
--      moment a row flips working -> idle, it's sent on a 5-second coffee
--      break in the breakroom. The moment a row flips into 'working', any
--      stale break is cleared.
--   2. office_room_tick() (statement-level sweep, run on a schedule since
--      "two-or-more people share a pipeline right now" is a property of
--      the whole table, not a single row event): expires finished breaks
--      back to home_room, and moves any >=2 rows currently 'working' with
--      the same non-null pipeline_name into the conference room together.
--      pipeline_name already exists as the "coordinated handoff chain" tag
--      (see the bridge script's --pipeline flag) — reused here as the
--      "working together" signal rather than inventing a second field.

ALTER TABLE public.office_board
  ADD COLUMN IF NOT EXISTS home_room text,
  ADD COLUMN IF NOT EXISTS room text,
  ADD COLUMN IF NOT EXISTS on_break_until timestamptz;

UPDATE public.office_board SET home_room = CASE role
  WHEN 'boss'             THEN 'exec_suite'
  WHEN 'security-auditor' THEN 'ops_tech'
  WHEN 'devops'           THEN 'ops_tech'
  WHEN 'coder'            THEN 'open_workspace'
  WHEN 'data-engineer'    THEN 'open_workspace'
  WHEN 'tester'           THEN 'open_workspace'
  WHEN 'reviewer'         THEN 'open_workspace'
  ELSE 'lobby'
END
WHERE home_room IS NULL;

UPDATE public.office_board SET room = home_room WHERE room IS NULL;

ALTER TABLE public.office_board
  ALTER COLUMN home_room SET NOT NULL,
  ALTER COLUMN room SET NOT NULL,
  ALTER COLUMN home_room SET DEFAULT 'lobby',
  ALTER COLUMN room SET DEFAULT 'lobby';

ALTER TABLE public.office_board
  ADD CONSTRAINT office_board_home_room_check
    CHECK (home_room IN ('exec_suite','ops_tech','open_workspace','conference','breakroom','lobby')),
  ADD CONSTRAINT office_board_room_check
    CHECK (room IN ('exec_suite','ops_tech','open_workspace','conference','breakroom','lobby'));

CREATE OR REPLACE FUNCTION public.office_board_on_status_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.home_room IS NULL THEN
    NEW.home_room := 'lobby';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.room IS NULL THEN
      NEW.room := NEW.home_room;
    END IF;
    RETURN NEW;
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

DROP TRIGGER IF EXISTS trg_office_board_status_change ON public.office_board;
CREATE TRIGGER trg_office_board_status_change
BEFORE INSERT OR UPDATE ON public.office_board
FOR EACH ROW EXECUTE FUNCTION public.office_board_on_status_change();

CREATE OR REPLACE FUNCTION public.office_room_tick()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Expire finished breaks.
  UPDATE public.office_board
    SET on_break_until = NULL, room = home_room
    WHERE on_break_until IS NOT NULL AND on_break_until <= now();

  -- Pull >=2 agents sharing a pipeline into the conference room together.
  WITH grp AS (
    SELECT pipeline_name
    FROM public.office_board
    WHERE status = 'working' AND pipeline_name IS NOT NULL AND on_break_until IS NULL
    GROUP BY pipeline_name
    HAVING count(*) >= 2
  )
  UPDATE public.office_board b
    SET room = 'conference'
    FROM grp g
    WHERE b.pipeline_name = g.pipeline_name
      AND b.status = 'working' AND b.on_break_until IS NULL AND b.room <> 'conference';

  -- Send solo workers (no longer grouped) back to their own desk.
  UPDATE public.office_board b
    SET room = b.home_room
    WHERE b.status = 'working' AND b.on_break_until IS NULL AND b.room = 'conference'
      AND NOT EXISTS (
        SELECT 1 FROM public.office_board o
        WHERE o.status = 'working' AND o.on_break_until IS NULL
          AND o.pipeline_name IS NOT NULL AND o.pipeline_name = b.pipeline_name AND o.id <> b.id
      );

  -- Idle rows always settle at home (covers any manual/out-of-band edit).
  UPDATE public.office_board
    SET room = home_room
    WHERE status = 'idle' AND on_break_until IS NULL AND room <> home_room;
END;
$$;

-- Same "fire faster than pg_cron's 1-minute floor" trick already used by
-- fhir-outbound-poll-45s (see CLAUDE.md gotcha notes): one minutely cron
-- entry that sleeps internally so the room state actually updates ~every
-- 10s instead of once a minute.
CREATE OR REPLACE FUNCTION public.office_room_tick_loop()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE i int;
BEGIN
  FOR i IN 1..6 LOOP
    PERFORM public.office_room_tick();
    IF i < 6 THEN
      PERFORM pg_sleep(10);
    END IF;
  END LOOP;
END;
$$;

SELECT cron.schedule('office-room-tick-60s', '* * * * *', $$SELECT public.office_room_tick_loop();$$);
