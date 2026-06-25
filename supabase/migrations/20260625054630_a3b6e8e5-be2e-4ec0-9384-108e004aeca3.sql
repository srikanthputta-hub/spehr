-- Shrink bed capacity from 30 to 20 per facility.
-- Remove rooms 111-115 (rows 11..15) keeping rooms 101-110 = 20 beds (A,B).
-- Reassign any currently-occupied bed to an available bed in rooms 101-110 first.
DO $$
DECLARE
  occ RECORD;
  target RECORD;
BEGIN
  FOR occ IN
    SELECT id, facility_name, current_patient_mrn, status
    FROM public.bed_management
    WHERE room_number IN ('111','112','113','114','115')
      AND current_patient_mrn IS NOT NULL
  LOOP
    SELECT id INTO target
    FROM public.bed_management
    WHERE facility_name = occ.facility_name
      AND room_number IN ('101','102','103','104','105','106','107','108','109','110')
      AND (current_patient_mrn IS NULL)
      AND lower(status) = 'available'
    ORDER BY room_number, bed_letter
    LIMIT 1;
    IF target.id IS NOT NULL THEN
      UPDATE public.bed_management
        SET current_patient_mrn = occ.current_patient_mrn,
            status = occ.status,
            status_updated_at = now()
        WHERE id = target.id;
      UPDATE public.bed_management
        SET current_patient_mrn = NULL,
            status = 'Available',
            status_updated_at = now()
        WHERE id = occ.id;
    END IF;
  END LOOP;
END $$;

DELETE FROM public.bed_management
WHERE room_number IN ('111','112','113','114','115');