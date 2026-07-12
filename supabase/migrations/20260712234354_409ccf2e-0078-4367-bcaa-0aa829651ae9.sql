ALTER TABLE public.custom_value_sets
  ALTER COLUMN binding_strength SET DEFAULT 'Preferred';

UPDATE public.custom_value_sets
  SET binding_strength = 'Preferred'
  WHERE binding_strength IS NULL;