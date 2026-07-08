## Apply scroll-feed pattern to Step8Surfacing feeds

In `src/components/admin/Step8Surfacing.tsx`, apply the same treatment used on the other dashboards to the two feeds rendered on the System Admin page.

### 1. CDS Hook Decisions · Overrides & Rejections (`CdsOverridesFeed`)
- Raise the query cap from `.limit(25)` to `.limit(150)`.
- Wrap the `divide-y divide-slate-100` rows container in a `scroll-feed` div so ~15 rows are visible and the rest scroll smoothly with the slim scrollbar.
- Keep expand/collapse behavior intact.

### 2. AUTO API · Event Stream (`AutoApiEventsFeed`)
- Raise `.limit(15)` to `.limit(150)`.
- Wrap rows container in `scroll-feed`.
- Update the header caption from `Last 15 · live · cross-loop telemetry` to `Last 150 · live · cross-loop telemetry`.

### Out of scope
- No visual redesign, no column changes, no realtime channel changes.
- No changes to other components on the page.
