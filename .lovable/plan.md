## Root causes

After scanning every dashboard (`admissions-board`, `nursing-board`, `physician-board`, `pharmacy-queue`, `lab-board`, `finance-board`, `analytics`, `admin-dashboard`, `system-admin`, `patient.$mrn`, `chart.$mrn`) three patterns are producing the "long load + flicker" behavior:

1. **Loading skeleton resets on every realtime event.** Each board defines `load()` that starts with `setLoading(true)`, then subscribes to `postgres_changes` on high-churn tables (`patients`, `lab_orders`, `medication_orders`, `vitals`, `clinical_notes`) and calls `load()` on every event. A single admission burst fires 5–20 events per second, so the whole board flashes to "Loading…" and back repeatedly. Finance was already fixed with `initialLoadRef` + debounce — the same pattern needs to be applied everywhere.
2. **Uncoalesced refresh storms.** Multiple `.on("postgres_changes", …)` handlers in the same channel all call the same `load()` synchronously. During ghost-admit / auto-doc sweeps this triggers dozens of parallel Supabase queries which then all `setState` in the same tick, causing long paints and dropped frames.
3. **Second-by-second (and 400ms) clock ticks re-render the entire dashboard.** `nursing-board`, `patient.$mrn`, and `system-admin` keep `now` in the top-level component and update it every 1s (and every 400ms in one place), forcing 1000+ children to reconcile. That is the "glitch" the user sees on otherwise idle screens.

## Fix

### 1. Non-flickering data refresh (shared pattern)

For every dashboard listed above:

- Add `const initialLoadRef = useRef(true)` and only call `setLoading(true)` on the very first load. Subsequent refreshes update state in place — the UI keeps rendering the last data until the new data arrives.
- Wrap `load()` in a `debouncedRefresh` (250 ms trailing) so a burst of realtime events collapses into one query.
- Consolidate the three-to-five separate `.on("postgres_changes", …)` handlers on the same channel to all call the same `debouncedRefresh`, not separate load functions.

Files touched: `nursing-board.tsx`, `pharmacy-queue.tsx`, `lab-board.tsx`, `admissions-board.tsx` (both `AdmissionsPage` and the appointments panel), `physician-board.tsx`, `admin-dashboard.tsx`, `analytics.tsx`, `patient.$mrn.tsx`, `chart.$mrn.tsx`, and the ~6 realtime-driven panels inside `system-admin.tsx`.

### 2. Isolate the clocks

Extract a tiny `<LiveClock />` component (its own `useState(now)` + `setInterval`) and use it wherever the dashboards render "now". This keeps the 1-second tick from re-rendering the patient list / bed board / audit panels.

- `nursing-board.tsx` line 378 clock → `<LiveClock />`
- `patient.$mrn.tsx` line 232 clock → `<LiveClock />`
- `system-admin.tsx` lines 1421, 2208 clocks → `<LiveClock />`
- Delete the `setInterval(() => setAutoTick(t => t + 1), 400)` on line 3389 — the same panel already refreshes via realtime + the 5-second refresh interval, so the 400 ms forced re-render is pure jank.

### 3. Trim redundant polling that overlaps realtime

- `nursing-board` has `setInterval(load, 5000)` AND five realtime subscribers on the same tables → keep realtime + drop the 5 s poll (or raise it to 30 s as a safety net).
- `analytics.tsx` reloads every 10 s and hard-resets state; switch to the debounced pattern above and raise interval to 30 s.
- `system-admin.tsx` line 3389 auto-tick removed (see above).

### 4. Verification

- Open each dashboard, admit a ghost patient, and confirm no "Loading…" flash on updates.
- Check console for the existing "flicker" symptoms (no repeated "loaded N rows" spam).
- Confirm `useBackgroundFhirSync` 400 ms heartbeat still ticks (it lives in a hook, not the render tree, so it is unaffected).

### Out of scope

- No schema, RLS, edge-function, or business-logic changes.
- No visual redesign — only the loading/refresh mechanics and clock isolation.
- `useAIAutomation`, `useAutoTerminologist`, `useBackgroundFhirSync`, and other background hooks stay as-is; they already run outside the render tree.
