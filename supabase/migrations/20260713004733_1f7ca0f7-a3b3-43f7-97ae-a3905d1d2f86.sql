CREATE OR REPLACE FUNCTION public.protect_published_value_sets()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  -- Only block downgrade from PUBLISHED back to draft. A row in `review`
  -- must be allowed to move to `draft` (steward rejection is exactly that
  -- transition) — silently reverting it makes the Reject action a no-op.
  IF OLD.status = 'published' AND NEW.status = 'draft' THEN
    NEW.status := OLD.status;
  END IF;

  -- Never allow a published row's code list to shrink. Curated review
  -- rows may still be edited freely (including code removal) prior to
  -- publish, so this guard applies only to already-published sets.
  IF OLD.status = 'published'
     AND jsonb_typeof(OLD.codes) = 'array'
     AND jsonb_typeof(NEW.codes) = 'array'
     AND jsonb_array_length(NEW.codes) < jsonb_array_length(OLD.codes) THEN
    NEW.codes := OLD.codes;
  END IF;

  RETURN NEW;
END;
$function$;