
CREATE TABLE public.patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn text NOT NULL UNIQUE,
  first_name text NOT NULL,
  last_name text NOT NULL,
  dob date NOT NULL,
  age integer NOT NULL,
  gender text NOT NULL,
  code_status text NOT NULL,
  chief_complaint text NOT NULL,
  room text,
  hr integer NOT NULL,
  bp_systolic integer NOT NULL,
  bp_diastolic integer NOT NULL,
  temp_f numeric(4,1) NOT NULL,
  spo2 integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view patients"
  ON public.patients FOR SELECT
  TO authenticated
  USING (true);

INSERT INTO public.patients (mrn, first_name, last_name, dob, age, gender, code_status, chief_complaint, room, hr, bp_systolic, bp_diastolic, temp_f, spo2) VALUES
  ('MRN-884213', 'Margaret', 'Chen', '1947-03-12', 78, 'F', 'DNR', 'CHF Exacerbation', '401-A', 112, 98, 54, 99.1, 91),
  ('MRN-771902', 'Robert', 'Alvarez', '1961-09-04', 64, 'M', 'Full Code', 'Sepsis, UTI source', '402-B', 124, 86, 48, 102.4, 94),
  ('MRN-902551', 'Janelle', 'Owusu', '1984-06-22', 41, 'F', 'Full Code', 'Post-op Day 1 — Lap chole', '404-A', 82, 118, 74, 98.4, 98),
  ('MRN-650118', 'Henry', 'Whitaker', '1954-11-18', 71, 'M', 'DNI', 'COPD Exacerbation', '407-B', 96, 142, 88, 99.8, 88);
