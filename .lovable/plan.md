## Replace "Seed Demo Patients" with "Discharge All Patients"

In `src/routes/system-admin.tsx`:

1. **Rename state/handler**
   - Replace `seedingDemo` state and `seedDemoPatients()` with `discharging` boolean state and `dischargeAllPatients()` async handler.

2. **`dischargeAllPatients()` logic**
   - Confirm via `window.confirm("Discharge ALL admitted patients across every facility?")`.
   - `supabase.from('patients').update({ status: 'Discharged', discharge_at: new Date().toISOString() }).neq('status', 'Discharged')`.
   - `supabase.from('bed_management').update({ status: 'Available', patient_mrn: null, patient_name: null }).neq('status', 'Available')`.
   - Toast success with count discharged, or error toast on failure.

3. **Button (line ~781)**
   - Label: `🏥 Discharge All Patients` (destructive amber/red styling — switch variant to `destructive` outline).
   - Disabled + spinner text "Discharging…" while running.
   - Keep position next to the "ENGINES ACTIVE" toggle.

No DB migrations, no other files touched. Background automation engines continue to re-admit ghost patients afterward (unchanged behavior).