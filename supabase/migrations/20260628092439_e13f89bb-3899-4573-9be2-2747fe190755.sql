
-- Reconcile beds with admitted patients: for any admitted patient whose
-- bed_management row is not marked Occupied, claim the bed matching their
-- room/bed_letter (when free), or assign the first Available bed at the
-- facility. This recovers from prior data wipes that left patients
-- bedless and made the floor census show 0.

DO $$
DECLARE
  pat RECORD;
  bed_id UUID;
  rn TEXT;
  bl TEXT;
BEGIN
  FOR pat IN
    SELECT p.mrn, p.facility_name, p.room
    FROM public.patients p
    WHERE p.status = 'Admitted'
      AND NOT EXISTS (
        SELECT 1 FROM public.bed_management b
        WHERE b.current_patient_mrn = p.mrn
      )
  LOOP
    rn := NULL; bl := NULL; bed_id := NULL;
    IF pat.room IS NOT NULL AND position('-' in pat.room) > 0 THEN
      rn := split_part(pat.room, '-', 1);
      bl := split_part(pat.room, '-', 2);
      SELECT id INTO bed_id FROM public.bed_management
      WHERE facility_name = pat.facility_name
        AND room_number = rn AND bed_letter = bl
        AND (current_patient_mrn IS NULL OR current_patient_mrn = pat.mrn)
      LIMIT 1;
    END IF;
    IF bed_id IS NULL THEN
      SELECT id INTO bed_id FROM public.bed_management
      WHERE facility_name = pat.facility_name
        AND status = 'Available'
        AND current_patient_mrn IS NULL
      ORDER BY room_number, bed_letter
      LIMIT 1;
    END IF;
    IF bed_id IS NOT NULL THEN
      UPDATE public.bed_management
      SET status = 'Occupied',
          current_patient_mrn = pat.mrn,
          status_updated_at = now()
      WHERE id = bed_id;
      UPDATE public.patients
      SET room = (SELECT room_number || '-' || bed_letter FROM public.bed_management WHERE id = bed_id)
      WHERE mrn = pat.mrn;
    END IF;
  END LOOP;
END $$;
