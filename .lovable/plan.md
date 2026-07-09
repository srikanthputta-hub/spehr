## Apply scroll-feed / 150 latest / search to System Admin dashboard panels

Same treatment already applied on the other dashboards (sticky header, ~15 rows visible via `scroll-feed`, latest 150 rows, slim scrollbar), plus a search box wherever there isn't one yet.

### 1. `src/components/admin/dictionary/LiveTerminologyMatrixPanel.tsx`
- Already has search + sticky header. Swap the custom `max-h-[560px] overflow-auto` wrapper for the shared `scroll-feed` utility so scrollbar/height match the other boards.
- Keep the 400-row underlying fetch; no change to filter logic.

### 2. `src/routes/system-admin.tsx` — Enterprise Event Ledger
- Raise `setEvents(out.slice(0, 50))` → `slice(0, 150)`.
- Add a search input above the table filtering on Timestamp / Category / Actor / Facility / Details (case-insensitive substring across all columns).
- Wrap the `<table>` scroll container in `scroll-feed` and keep the header sticky.
- CSV export exports the filtered result if a search is active, otherwise all loaded events.

### 3. `src/components/admin/dictionary/ValueSetLibrary.tsx`
- Raise `.limit(50)` → `.limit(150)` and the realtime prepend cap `.slice(0, 50)` → `.slice(0, 150)`.
- Search box already exists — no change.
- Wrap the value-set rows list in `scroll-feed`.

### 4. `src/components/admin/dictionary/NlpAuditLogsPanel.tsx` (NLP Coding Audit Trail)
- Raise `.limit(20)` → `.limit(150)`.
- Add a search input above the cards filtering on MRN and chief-complaint / raw text.
- Wrap the cards container `space-y-3` in `scroll-feed`.

### 5. `src/components/admin/dictionary/NlpApprovalTrail.tsx`
- Raise `.limit(50)` → `.limit(150)`.
- Add a search input filtering on MRN and raw text.
- Wrap the cards container in `scroll-feed`.
- Update the badge caption `Last 50 · Approved` → `Last 150 · Approved`.

### 6. `src/components/admin/dictionary/AutoTerminologistActivity.tsx`
- Raise both `.limit(50)` fetches and the two `.slice(0, 50)` realtime caps → `150`.
- Add one search input for **Terminology Requests** (filters on consumer / requested_name / justification / status).
- Add one search input for **Value Sets Drafted** (filters on message / theme / action).
- Wrap each of the two rounded list containers in `scroll-feed`.

### Out of scope
- No changes to fetch schemas, realtime channels, or card internals.
- No visual redesign — same colors, badges, spacing; only the wrapper class, row cap, and new search inputs change.
- Taxonomy Tree, KPI cards, charts, and other panels not shown in the screenshots are unchanged.
