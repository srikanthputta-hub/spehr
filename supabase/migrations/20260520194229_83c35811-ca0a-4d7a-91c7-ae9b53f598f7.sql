-- Ensure every patient row has an explicit facility assignment.
UPDATE public.patients
SET facility_name = CASE
  WHEN facility_name IS NULL OR btrim(facility_name) = '' THEN 'Memorial Hospital'
  ELSE facility_name
END;

-- Normalize existing patient statuses so Active Census filters can rely on a real active-state column.
UPDATE public.patients
SET status = CASE
  WHEN status IS NULL OR btrim(status) = '' THEN 'Admitted'
  ELSE status
END;

-- Prevent future mock/live patient rows from omitting required scoping fields.
ALTER TABLE public.patients
  ALTER COLUMN facility_name SET DEFAULT 'Memorial Hospital',
  ALTER COLUMN facility_name SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'Admitted',
  ALTER COLUMN status SET NOT NULL;

-- Guard facility values to the known network hospitals.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'patients_facility_name_network_check'
      AND conrelid = 'public.patients'::regclass
  ) THEN
    ALTER TABLE public.patients
      ADD CONSTRAINT patients_facility_name_network_check
      CHECK (facility_name IN (
        'Memorial Hospital',
        'St. Jude Medical Center',
        'City General Infirmary',
        'County Health Pavilion',
        'Mercy Childrens Hospital'
      ));
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';