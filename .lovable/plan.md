# Population Health — Custom date range

In `src/components/admin/PopulationHealth.tsx`, replace the `Last 7d`, `Last 30d`, and `All time` preset buttons with a custom From / To date range. Short-window presets stay.

## Changes

**1. Time window row**
- Keep preset buttons: `Last 6h`, `Last 12h`, `Last 24h`.
- Remove: `Last 7d`, `Last 30d`, `All time` entries from the `WINDOWS` array.
- Add two `<input type="date">` fields labeled **From** and **To**, aligned inline with the preset buttons.
- Selecting a preset clears the from/to dates; typing in from/to clears the active preset (mutually exclusive).

**2. State**
- Add `fromDate: string` and `toDate: string` (ISO `YYYY-MM-DD`, empty = unset).
- Keep existing `windowHours` for the presets.

**3. Query submit logic (`submit` handler)**
- If `fromDate` or `toDate` is set: send `since_iso = new Date(fromDate).toISOString()` (start of day UTC) and add a new `until_iso = new Date(toDate + "T23:59:59.999Z").toISOString()` when `toDate` is set.
- Else fall back to current `windowHours` logic.
- One end of the range being empty is allowed (open-ended on that side).

**4. Server function `runPopulationQuery`** (`src/lib/auto-api.functions.ts`)
- Extend input validator to accept optional `until_iso: string`.
- In the handler, apply `.lte(<timestamp column>, until_iso)` alongside the existing `.gte(..., since_iso)` filter, using the same column already used for `since_iso`.

## Out of scope
- No visual redesign of the panel.
- No changes to facilities, code system, keyword, or value set controls.
- No changes to result table or CSV export.
