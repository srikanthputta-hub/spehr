## Goal
Make the Finance & Accounts dashboard table scrollable so only 25 patients are visible at once and staff scroll down to see older invoices.

## What we'll change
1. In `src/routes/finance-board.tsx`, wrap the existing `<table>` in a scrollable container.
2. Set a fixed max-height on the container that fits roughly 25 data rows plus the sticky header.
3. Make the `<thead>` sticky so column labels remain visible while scrolling.
4. Keep the existing search, tabs, KPI strip, and realtime sync unchanged.

## Implementation details
- Use Tailwind classes on the wrapper: `overflow-y-auto max-h-[some-px]`.
- Add `sticky top-0 z-10` to the `<thead>` and a background color so it does not become transparent over rows.
- No pagination or "Load more" button — the full filtered list still renders, just inside a scroll viewport.
- No backend or data-fetch changes.

## Files affected
- `src/routes/finance-board.tsx` only.

## Verification
- Typecheck (`bunx tsc --noEmit` or `tsgo`) after the edit.
- Visual check in preview that the Active/Settled table scrolls and the header stays fixed.