## Fix NLP Coding Audit Trail loading / flicker

Root causes:
- Pending query fetches up to 25 rows with no timeout and re-runs on every realtime event.
- A `postgres_changes` subscription triggers `refresh()` continuously, causing the flicker and re-render storm.
- Each pending `AuditCard` runs a `setInterval(..., 250)` that calls `setState` four times a second — dozens of open cards create a re-render loop.

### Changes

**1. `src/components/admin/dictionary/NlpAuditLogsPanel.tsx`**
- Query: `.eq("status","pending").order("created_at",{ascending:false}).limit(20)`.
- Wrap the fetch in `Promise.race` with a 10 s timeout. On timeout: stop loading, set `rows=[]`, show the existing "No pipeline runs yet" empty state (copy tweaked to "No pending items").
- Remove the realtime `postgres_changes` subscription. Keep the one-shot fetch on mount plus the existing **Refresh** button (and refetch after Approve / Re-code, which already happens).

**2. `src/components/admin/dictionary/NlpApprovalTrail.tsx`**
- Same treatment: remove the realtime subscription, keep the single mount fetch, add a 10 s timeout guard. (No Refresh button exists here — add a small one for parity so users can pull latest approvals without a full reload.)

**3. `src/components/admin/dictionary/AuditCard.tsx` — CSS-only auto-approve timer**
- Delete the `useState(remainingMs)` + `useEffect` + `setInterval` ticker.
- Compute `elapsedMs` once from `row.created_at`; if already ≥ `AUTO_APPROVE_MS`, fire `onAutoApprove` once via a single `setTimeout(0)` guard and render an empty bar.
- Otherwise render the drain bar using a pure CSS animation:
  - Outer track: `h-1.5 bg-slate-100`.
  - Inner bar: starts at `width: ${startPct}%` and animates to `width: 0%` over `remainingMs` via an inline `style={{ animation: "audit-drain <remaining>ms linear forwards" }}`.
  - Colour transition (green → amber → red) done with a second CSS animation on `background-color` keyframed at 66% and 33% marks, scaled to the same duration.
  - Fire `onAutoApprove` exactly once with a single `setTimeout(onAutoApprove, remainingMs)` (no re-render, no interval). Cleared on unmount and when the user clicks Approve (sets `firedRef` and clears the timeout).
- Add the `@keyframes audit-drain` and `@keyframes audit-drain-color` blocks to `src/styles.css`.

### Out of scope
- No schema changes, no edge-function changes.
- Approval Trail still filters by `status = 'approved'`; only its subscription is removed.
- Six-stream pipeline, background sync hooks, and other dashboards are untouched.

### Verification
- Open `/system-admin` → Dictionary → NLP Audit Logs: card list renders within ~1 s or shows "No pending items" after 10 s; no flicker on admissions burst.
- Pending card shows a smoothly draining bar with no console re-render churn; clicking Approve stops the bar immediately.
- Waiting 2 min on a pending card auto-approves exactly once (row moves to Approval Trail after clicking Refresh).