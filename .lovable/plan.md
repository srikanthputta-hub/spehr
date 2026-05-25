## Goal
Make the Lab Board's "Recent Completed Labs Feed" mirror the Nursing Board — show the latest 25 completed labs for patients currently admitted on the Nursing Board at the active facility, displaying the exact lab test performed on each patient. Auto-update in realtime.

## Changes — `src/routes/lab-board.tsx`

1. **Fetch the nursing-board roster**
   - Add state `boardMrns: Set<string>`.
   - In `load()`, query `patients` where `facility_name = facility` AND `status = 'Admitted'`, ordered by `admission_time desc`, limit 25 (same source the Nursing Board uses).
   - Store MRNs in `boardMrns`.

2. **Filter the completed feed** to those MRNs
   - Update the `completed` memo to add `boardMrns.has(o.patient_mrn)` before slicing to 25.
   - Pending queue is untouched.

3. **Surface the exact lab test per patient**
   - The table already has a "Test Type" column rendering `o.test_type` (e.g., "Complete Blood Count (CBC)", "Cardiac Troponin", "Arterial Blood Gas"). Confirm it stays as the precise per-row test.
   - Add a small result/flag preview next to the test name: when `results_data` is present, render the first critical/abnormal flag inline (e.g., "Troponin I 0.85 ng/mL · CRITICAL"); otherwise show `result_value` if available. Falls back to just the test name.

4. **Realtime stays as-is**
   - Existing channel already listens to `patients` and `lab_orders` and refetches, so admissions/discharges and newly-resulted labs both refresh the filtered feed automatically.

5. **Copy updates**
   - Subtitle: "Latest {n} completed labs for patients currently on the Nursing Board at {facility}, newest first."
   - Empty state: "No completed labs yet for patients currently on the Nursing Board at {facility}."

## Out of scope
- No DB migration. No changes to Nursing Board, pending queue, or other boards.

## Verification
- Memorial Hospital: feed lists resulted labs only for the admitted patients visible on the Nursing Board, each row showing the precise test type plus a brief result/flag.
- St. Jude (empty in screenshot): if any admitted patient there has a resulted lab, it appears; otherwise the new empty-state copy explains why.
- Toggling Ghost AI automation or admitting a new patient updates the feed live without a refresh.
