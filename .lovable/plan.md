## NLP Coding Audit Trail

**1. Anchor 3-minute timer to admission time (not stream completion)**

Currently the countdown in `AuditCard.tsx` uses `row.created_at` — which is when the pipeline finishes writing the `nlp_audit_logs` row (after streams run). Switch the anchor to the patient's `admission_time`.

- `src/components/admin/dictionary/NlpAuditLogsPanel.tsx`: after the audit-log fetch, batch-fetch `patients.admission_time` for the returned MRNs (`.in("mrn", [...])`) and build an `mrn → admission_time` map. Pass `admissionAt` into each `AuditCard`.
- `src/components/admin/dictionary/AuditCard.tsx`: add optional `admissionAt?: string | null` prop. Use `admissionAt ?? row.created_at` as the timer anchor for `createdMs` / `remainingMs` / `startPct`. Everything else (CSS drain bar, one-shot `setTimeout(fire, remainingMs)`) stays as-is.

Auto-approve behavior is already correct: on `remainingMs <= 0` it fires immediately; manual Approve clears the timeout and calls `onApprove(row, "human")` right away.

**2. Permanent removal after approval**

Already handled: `handleApprove` in `NlpAuditLogsPanel` optimistically removes the row from local state and the DB query filters `status = 'pending'`, so future refreshes won't bring it back. No change needed beyond confirming both the human and AI paths use the same removal (they do — both go through `handleApprove`).

## NLP Approval Trail

**3. Stable, append-only list with hard cap of 50**

`src/components/admin/dictionary/NlpApprovalTrail.tsx` today replaces the whole `rows` state on every refresh, which reorders if `updated_at` values shift. Change `refresh()` to a merge:

- Fetch top 50 approved rows ordered by `updated_at desc` (unchanged query).
- Merge into existing state: prepend any rows whose `id` isn't already present (in the order returned), keep existing rows in their current position, then truncate to 50 (drops oldest from the tail).
- Initial mount: state is empty, so the first fetch just seeds the list in server order.

This gives: newest-approved-first on arrival, no reshuffle of rows already on screen, hard cap of 50 with oldest evicted.

**4. Copy tweak + approval tag**

- Change "2-minute grace window" → "3-minute grace window" in the `NlpApprovalTrail` description.
- Tag rendering already exists in `AuditCard` (green "Human" for `approved_by='human'`, blue "AI" for `approved_by='ai'`). Rename the green pill label from "Human" to "User" to match the spec. Icon stays.

**5. Immediate move to Approval Trail on approval**

Already wired: `NlpAuditLogsPanel.handleApprove` dispatches `window.dispatchEvent(new CustomEvent("nlp:approved"))` and `NlpApprovalTrail` listens for it and calls `refresh()`. With the merge logic above, the new row will prepend without disturbing existing order. No change needed.

## Out of scope

- No schema changes, no changes to `coding-pipeline.ts` write path, no changes to the 6-stream pipeline itself.
- No touching `AutoDocMonitor`, `ErrorLogPanel`, or other admin panels.
- No changes to the polling cadence (still 20s), realtime subscriptions stay removed.

## Files changed

- `src/components/admin/dictionary/AuditCard.tsx` — add `admissionAt` prop; rename "Human" pill → "User"; timer anchor swap.
- `src/components/admin/dictionary/NlpAuditLogsPanel.tsx` — fetch admission times, pass `admissionAt` to each card.
- `src/components/admin/dictionary/NlpApprovalTrail.tsx` — merge-on-refresh (append-only, cap 50); update grace-window copy.

## Verification

- Admit a patient → open System Admin → NLP Audit Logs → the drain bar starts at (or near) 100% and reflects "3:00 minus (now − admission_time)", not "3:00 minus (now − pipeline_finish)".
- Click Approve → card disappears from Audit Trail and appears at top of Approval Trail with green "User" pill.
- Wait 3 minutes on a pending card → auto-approves once; row appears at top of Approval Trail with blue "AI" pill.
- Refresh the Approval Trail repeatedly with no new approvals → existing rows do not move.
- Approve 51+ items over time → list stays at 50, oldest drops off.
