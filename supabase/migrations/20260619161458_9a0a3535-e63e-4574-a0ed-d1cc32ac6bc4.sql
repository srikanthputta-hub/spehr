DELETE FROM public.medication_orders
WHERE ordered_by = 'Auto Doc'
  AND status = 'Administered'
  AND administered_at = created_at;