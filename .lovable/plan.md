## Goal

Make every patient log / census / feed table across the dashboards behave like the "Live Feed · Global Real-Time Admissions" table on the network analytics page: show the latest 150 rows in a fixed-height, internally scrollable container with roughly 15 rows visible, a slim styled scrollbar, sticky header, and smooth scrolling.

## Tables to redesign

Applied consistently to these five surfaces (from the uploaded screenshots):

1. `src/routes/admissions-board.tsx` — Patient Census table
2. `src/routes/pharmacy-queue.tsx` — Recent Dispatched Medications
3. `src/routes/lab-board.tsx` — Recent Completed Labs Feed
4. `src/components/PatientFlowCensusLog.tsx` (rendered on `admin-dashboard`) — Patient Flow & Census Log
5. `src/routes/finance-board.tsx` — Active · Bill Generation Queue

The reference implementation lives at `src/routes/analytics.tsx` lines 270–321.

## Behavior spec (identical for all five)

- Cap query/render to the **latest 150 rows** (order by admission/created/updated desc, `.limit(150)`).
- Wrap the `<table>` in a scroll container that shows ~15 rows before scrolling; the rest reached by scrolling inside the panel (page itself does not grow).
- Sticky `<thead>` inside the scroll container so column labels stay visible.
- Slim, aesthetic scrollbar; smooth momentum scroll.
- Preserve existing columns, filters, realtime refresh, and row actions — only the container, row cap, and scroll styling change.

## Technical details

### Shared scroll container

Reuse the analytics pattern with one small addition — a global utility for the slim scrollbar + smooth scrolling, so every table matches exactly.

Add to `src/styles.css` (after existing `@utility` blocks):

```css
@utility scroll-feed {
  max-height: 560px;              /* ~15 compact rows + sticky header */
  overflow-y: auto;
  overflow-x: auto;
  scroll-behavior: smooth;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: rgb(148 163 184 / 0.6) transparent;

  &::-webkit-scrollbar { width: 8px; height: 8px; }
  &::-webkit-scrollbar-track { background: transparent; }
  &::-webkit-scrollbar-thumb {
    background: rgb(148 163 184 / 0.55);
    border-radius: 9999px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }
  &::-webkit-scrollbar-thumb:hover { background: rgb(100 116 139 / 0.75); background-clip: padding-box; }
}
```

Row-height math: our tables use `py-2` / `py-2.5` giving ~36px per row. 15 rows ≈ 540px + ~32px sticky header ≈ **560px** cap. Finance rows are taller (`py-3` ≈ 44px), so that panel uses `max-h-[640px]` via an inline override on the wrapper (`className="scroll-feed max-h-[640px]"`).

### Per-file edits

For each of the five files:

1. Change the Supabase query `.limit(...)` to `150` (or add one if none exists). Keep the existing `.order(...)` on the newest-first column.
2. Wrap the existing `<table>` in `<div className="scroll-feed rounded-b-lg">` (finance uses `scroll-feed max-h-[640px]`).
3. Add `sticky top-0 z-10` to the existing `<thead>` and give it a solid background (`bg-slate-50`) so rows don't bleed through.
4. Remove any prior `max-h-[...]`/`overflow` on ancestor wrappers of the same table so the new container is the single scroll owner.
5. Update any "showing N of M" / count chip labels to reflect the 150 cap where one exists (e.g. Patient Flow header currently says "Last 50 admissions" → "Last 150 admissions"; pharmacy "Recent Dispatched" and lab "Recent Completed Labs Feed" entry counters continue to work off the array length).

No other UI changes, no logic changes to filters, realtime subscriptions, admit/verify/administer actions, or column contents.

## Out of scope

- The Pending Verification / Pending Lab Requests panels (they are queues, not logs, and the user's screenshots show them empty — unchanged).
- Virtualization (150 rows renders fine as plain DOM; no need for react-window).
- Column redesign, sorting UI, or new filters.

## Verification

- Load each of the five pages, confirm ~15 rows visible, scroll reveals up to 150, page does not lengthen, header stays pinned, scrollbar is slim, scroll feels smooth.
- Confirm realtime inserts still prepend and the list stays capped at 150.
