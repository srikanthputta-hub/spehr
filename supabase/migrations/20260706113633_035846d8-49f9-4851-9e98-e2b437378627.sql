INSERT INTO public.value_set_dependencies (consumer, consumer_file, purpose, lookup_mode, value_set_id, value_set_name, required)
SELECT 'Auto Admin — Isolation/Status Flags', 'src/components/admissions/BedManagementBoard.tsx', 'bed-board isolation badge', 'by_name', v.id, v.name, false
FROM public.custom_value_sets v WHERE v.name = 'Isolation Precaution Diagnoses' AND v.status = 'published'
ON CONFLICT DO NOTHING;