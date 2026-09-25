-- Phase B: myspehr<->spehr Appointment sync model.
--
-- Fixes (see architecture review that produced this migration):
--  1. Reception UI PUT'd Appointment/{local-uuid} while the outbound poller
--     separately PUT'd Appointment/appt-{local-uuid} for the SAME row --
--     two FHIR ids for one appointment. Fix: a single durable `fhir_id`
--     column, backfilled for every existing row, that every writer
--     (reception UI trigger insert, outbound poller, background sync hook)
--     is expected to key off from here on.
--  2. The outbound poller only pushed rows where fhir_id IS NULL, so once a
--     myspehr-originated row (which already has a fhir_id) changed status
--     in spehr, that change never reached FHIR. Fix: a `needs_fhir_push`
--     dirty flag, set by trigger on any outbound-relevant column change and
--     cleared only by an explicit ack from the poller after a confirmed
--     push -- so selection is "what changed", not "what has no fhir_id".
--  3. Inbound ingest could regress status (e.g. booked -> proposed) on a
--     stale FHIR read. `last_ingested_status` / `last_ingested_at` give the
--     ingest function a monotonicity check.
--  4. `origin` distinguishes reception/myspehr/recall-originated rows for
--     UI chips and outbound appointmentType coding.

ALTER TABLE public.fhir_appointments
  ADD COLUMN IF NOT EXISTS origin                text,
  ADD COLUMN IF NOT EXISTS needs_fhir_push       boolean,
  ADD COLUMN IF NOT EXISTS last_ingested_status  text,
  ADD COLUMN IF NOT EXISTS last_ingested_at      timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at           timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_by           text,
  ADD COLUMN IF NOT EXISTS admitted_at           timestamptz,
  ADD COLUMN IF NOT EXISTS source_composition_id text;

UPDATE public.fhir_appointments
   SET origin = CASE WHEN fhir_id IS NULL THEN 'reception' ELSE 'myspehr' END
 WHERE origin IS NULL;
UPDATE public.fhir_appointments
   SET last_ingested_status = status, last_ingested_at = updated_at
 WHERE origin = 'myspehr' AND last_ingested_at IS NULL;
UPDATE public.fhir_appointments SET fhir_id = 'appt-' || id::text WHERE fhir_id IS NULL;
UPDATE public.fhir_appointments SET needs_fhir_push = false WHERE needs_fhir_push IS NULL;
ALTER TABLE public.fhir_appointments ALTER COLUMN origin SET DEFAULT 'reception';

CREATE INDEX IF NOT EXISTS idx_fhir_appt_push         ON public.fhir_appointments (updated_at) WHERE needs_fhir_push;
CREATE INDEX IF NOT EXISTS idx_fhir_appt_status_start ON public.fhir_appointments (status, start_time);
CREATE INDEX IF NOT EXISTS idx_fhir_appt_mrn          ON public.fhir_appointments (patient_mrn);

CREATE OR REPLACE FUNCTION public.fhir_appointments_mark_dirty() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.fhir_id IS NULL THEN NEW.fhir_id := 'appt-' || NEW.id::text; END IF;
    IF NEW.needs_fhir_push IS NULL THEN NEW.needs_fhir_push := (NEW.last_ingested_at IS NULL); END IF;
  ELSIF NEW.last_ingested_at IS NOT DISTINCT FROM OLD.last_ingested_at
        AND ( NEW.status        IS DISTINCT FROM OLD.status
           OR NEW.start_time    IS DISTINCT FROM OLD.start_time
           OR NEW.end_time      IS DISTINCT FROM OLD.end_time
           OR NEW.facility_name IS DISTINCT FROM OLD.facility_name
           OR NEW.practitioner_name IS DISTINCT FROM OLD.practitioner_name) THEN
    NEW.needs_fhir_push := true;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_fhir_appointments_mark_dirty ON public.fhir_appointments;
CREATE TRIGGER trg_fhir_appointments_mark_dirty
  BEFORE INSERT OR UPDATE ON public.fhir_appointments
  FOR EACH ROW EXECUTE FUNCTION public.fhir_appointments_mark_dirty();

CREATE OR REPLACE FUNCTION public.ack_fhir_appointment_push(p_ids uuid[], p_updated timestamptz[])
RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH x AS (SELECT unnest(p_ids) id, unnest(p_updated) u)
  UPDATE fhir_appointments a SET needs_fhir_push = false
    FROM x WHERE a.id = x.id AND a.updated_at = x.u
  RETURNING 1
$$;
