-- Incident: vitals-simulation-tick-1min has failed on EVERY run since
-- 2026-09-25 15:46 UTC ("permission denied to set parameter
-- 'session_replication_role'"), when 20260925153917_fix_outbound_poller_
-- starvation_and_cadence.sql started wrapping the per-patient vitals UPDATE
-- with `PERFORM set_config('session_replication_role', 'replica'/'origin', true)`.
--
-- Root cause: session_replication_role is a superuser-only GUC (PGC_SUSET) --
-- set_config(..., true) being transaction-local does not relax that. In this
-- Supabase project `postgres` (the role that owns simulate_vitals_tick() AND
-- the role pg_cron's vitals-simulation-tick-1min job runs as -- see
-- cron.job.username) is NOT a superuser; only supabase_admin is
-- (`SELECT rolsuper FROM pg_roles` confirms rolsuper=false for postgres,
-- true for supabase_admin). So the previous fix only ever "worked" by
-- accident of never having been exercised before 15:46 UTC on this role --
-- every invocation since was guaranteed to hit permission denied. Making the
-- function SECURITY DEFINER would not help unless it were also re-owned to
-- supabase_admin, which would needlessly run an entire vitals-simulation
-- loop (including inserts/dynamic SQL over patient data) as the platform
-- superuser -- broad, fragile, and one Supabase platform change away from
-- breaking again.
--
-- Fix: drop session_replication_role entirely. Use an ordinary session-local
-- custom GUC (`app.skip_patient_triggers`, settable by any role, no
-- privilege required) that the two triggers touched by vitals jitter check
-- for themselves and skip their body on. This reproduces the original
-- intent -- vitals jitter must not bump patients.updated_at (the FHIR
-- outbound poller's staleness cursor) and must not run the auto-coding
-- trigger -- without disabling ALL triggers session-wide and without
-- depending on any elevated role/privilege.

-- 1. touch_updated_at: skip bumping updated_at when the flag is set.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('app.skip_patient_triggers', true) = 'true' THEN
    RETURN NEW;
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

-- 2. trg_patients_auto_code: skip auto-coding when the flag is set. Belt and
-- suspenders -- the UPDATE trigger already only fires WHEN chief_complaint
-- changes, which vitals jitter never touches, but this keeps the guard
-- explicit and matches the original fix's stated intent.
CREATE OR REPLACE FUNCTION public.trg_patients_auto_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('app.skip_patient_triggers', true) = 'true' THEN
    RETURN NEW;
  END IF;
  PERFORM public.auto_code_patient_complaint(NEW.mrn, NEW.name, NEW.chief_complaint);
  RETURN NEW;
END;
$function$;

-- 3. simulate_vitals_tick: replace session_replication_role with the
-- session-local flag. Everything else is unchanged from the previous
-- migration.
CREATE OR REPLACE FUNCTION public.simulate_vitals_tick()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  r RECORD;
  base_hr numeric; base_sys numeric; base_dia numeric; base_spo2 numeric; base_rr numeric; base_temp numeric;
  new_hr int; new_sys int; new_dia int; new_spo2 int; new_rr int; new_temp numeric;
  dx text;
  event_roll numeric;
  temp_c numeric;
  s_rr int; s_spo2 int; s_sys int; s_hr int; s_temp int; news2 int;
  reasons text[];
  recent_alert_count int;
BEGIN
  -- Transaction-local (third arg = true): reverts automatically at commit.
  -- Ordinary custom GUC, no elevated privilege required -- unlike
  -- session_replication_role, any role can set this. Vitals jitter must not
  -- touch patients.updated_at (the outbound poller's staleness cursor) or
  -- run trg_patients_auto_code (real-diagnosis-change coding, not relevant
  -- to a numeric wobble); both triggers check this flag themselves.
  PERFORM set_config('app.skip_patient_triggers', 'true', true);

  FOR r IN
    SELECT mrn, first_name, last_name, facility_name, hr, bp_systolic, bp_diastolic, spo2, rr, temp::numeric AS temp,
           coalesce(diagnosis, chief_complaint) AS dx
    FROM patients
    WHERE status = 'Admitted'
  LOOP
    dx := lower(coalesce(r.dx, ''));

    IF dx LIKE '%sepsis%' OR dx LIKE '%septic%' THEN
      base_hr := 112; base_sys := 88; base_dia := 55; base_spo2 := 95; base_rr := 21; base_temp := 101.4;
    ELSIF dx LIKE '%dka%' OR dx LIKE '%diabetic ketoacidosis%' THEN
      base_hr := 105; base_sys := 100; base_dia := 65; base_spo2 := 97; base_rr := 22; base_temp := 99.0;
    ELSIF dx LIKE '%stemi%' OR dx LIKE '%myocardial%' OR dx LIKE '%chest pain%' OR dx LIKE '%cardiac%' THEN
      base_hr := 98; base_sys := 138; base_dia := 88; base_spo2 := 96; base_rr := 19; base_temp := 98.4;
    ELSIF dx LIKE '%stroke%' OR dx LIKE '%slurred speech%' OR dx LIKE '%facial droop%' THEN
      base_hr := 92; base_sys := 165; base_dia := 95; base_spo2 := 96; base_rr := 18; base_temp := 98.6;
    ELSIF dx LIKE '%pneumonia%' OR dx LIKE '%respiratory%' OR dx LIKE '%dyspnea%' OR dx LIKE '%shortness of breath%' THEN
      base_hr := 94; base_sys := 126; base_dia := 80; base_spo2 := 94; base_rr := 20; base_temp := 99.6;
    ELSE
      base_hr := 78; base_sys := 122; base_dia := 80; base_spo2 := 98; base_rr := 16; base_temp := 98.6;
    END IF;

    new_hr   := round(coalesce(r.hr, base_hr) * 0.90 + base_hr * 0.10 + (random() - 0.5) * 5)::int;
    new_sys  := round(coalesce(r.bp_systolic, base_sys) * 0.90 + base_sys * 0.10 + (random() - 0.5) * 7)::int;
    new_dia  := round(coalesce(r.bp_diastolic, base_dia) * 0.90 + base_dia * 0.10 + (random() - 0.5) * 5)::int;
    new_spo2 := round(coalesce(r.spo2, base_spo2) * 0.94 + base_spo2 * 0.06 + (random() - 0.5) * 1.4)::int;
    new_rr   := round(coalesce(r.rr, base_rr) * 0.92 + base_rr * 0.08 + (random() - 0.5) * 2)::int;
    new_temp := round((coalesce(r.temp, base_temp) * 0.93 + base_temp * 0.07 + (random() - 0.5) * 0.3)::numeric, 1);

    event_roll := random();
    IF event_roll < 0.007 THEN
      new_hr := new_hr + (10 + floor(random() * 12))::int;
      new_spo2 := new_spo2 - (2 + floor(random() * 3))::int;
    ELSIF event_roll < 0.015 THEN
      new_sys := new_sys + (12 + floor(random() * 18))::int;
      new_dia := new_dia + (6 + floor(random() * 8))::int;
    END IF;

    new_hr := greatest(40, least(180, new_hr));
    new_sys := greatest(70, least(220, new_sys));
    new_dia := greatest(40, least(140, new_dia));
    new_spo2 := greatest(82, least(100, new_spo2));
    new_rr := greatest(8, least(36, new_rr));
    new_temp := greatest(94.0, least(104.0, new_temp));

    UPDATE patients
    SET hr = new_hr,
        bp_systolic = new_sys,
        bp_diastolic = new_dia,
        bp = new_sys || '/' || new_dia,
        spo2 = new_spo2,
        rr = new_rr,
        temp = new_temp
    WHERE mrn = r.mrn;

    temp_c := round(((new_temp - 32) / 1.8)::numeric, 1);

    INSERT INTO vitals (mrn, hr, bp_systolic, bp_diastolic, spo2, temp_c, rr, recorded_at, source)
    VALUES (r.mrn, new_hr, new_sys, new_dia, new_spo2, temp_c, new_rr, now(), 'simulation');

    s_rr := CASE
      WHEN new_rr <= 8 THEN 3 WHEN new_rr <= 11 THEN 1 WHEN new_rr <= 20 THEN 0
      WHEN new_rr <= 24 THEN 2 ELSE 3 END;
    s_spo2 := CASE
      WHEN new_spo2 <= 91 THEN 3 WHEN new_spo2 <= 93 THEN 2 WHEN new_spo2 <= 95 THEN 1 ELSE 0 END;
    s_sys := CASE
      WHEN new_sys <= 90 THEN 3 WHEN new_sys <= 100 THEN 2 WHEN new_sys <= 110 THEN 1
      WHEN new_sys <= 219 THEN 0 ELSE 3 END;
    s_hr := CASE
      WHEN new_hr <= 40 THEN 3 WHEN new_hr <= 50 THEN 1 WHEN new_hr <= 90 THEN 0
      WHEN new_hr <= 110 THEN 1 WHEN new_hr <= 130 THEN 2 ELSE 3 END;
    s_temp := CASE
      WHEN temp_c <= 35.0 THEN 3 WHEN temp_c <= 36.0 THEN 1 WHEN temp_c <= 38.0 THEN 0
      WHEN temp_c <= 39.0 THEN 1 ELSE 2 END;
    news2 := s_rr + s_spo2 + s_sys + s_hr + s_temp;

    IF news2 >= 7 OR s_rr = 3 OR s_spo2 = 3 OR s_sys = 3 OR s_hr = 3 THEN
      reasons := ARRAY[]::text[];
      IF s_rr >= 2 THEN reasons := reasons || (('RR ' || new_rr || '/min')::text); END IF;
      IF s_spo2 >= 2 THEN reasons := reasons || (('SpO2 ' || new_spo2 || '%')::text); END IF;
      IF s_sys >= 2 THEN reasons := reasons || (('SBP ' || new_sys || ' mmHg')::text); END IF;
      IF s_hr >= 2 THEN reasons := reasons || (('HR ' || new_hr || ' bpm')::text); END IF;
      IF s_temp >= 2 THEN reasons := reasons || (('Temp ' || temp_c || '°C')::text); END IF;
      IF array_length(reasons, 1) IS NULL THEN
        reasons := ARRAY[('NEWS2 ' || news2)::text];
      END IF;

      SELECT count(*) INTO recent_alert_count
      FROM rapid_response_alerts
      WHERE mrn = r.mrn AND status = 'Pending' AND created_at > now() - interval '15 minutes';

      IF recent_alert_count = 0 THEN
        INSERT INTO rapid_response_alerts (
          mrn, patient_name, facility_name, news2_score, trigger_reason, vitals_snapshot, status
        ) VALUES (
          r.mrn,
          trim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')),
          r.facility_name,
          news2,
          array_to_string(reasons, ', '),
          jsonb_build_object('hr', new_hr, 'sys', new_sys, 'dia', new_dia, 'spo2', new_spo2, 'rr', new_rr, 'temp_c', temp_c),
          'Pending'
        );
      END IF;
    END IF;
  END LOOP;

  PERFORM set_config('app.skip_patient_triggers', 'false', true);
END;
$function$;
