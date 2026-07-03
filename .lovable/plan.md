## Goal

Make the NLP Coding Audit Trail collapsible with an auto-approval countdown, and repurpose the "UMLS Resolution Trail" tab as an "NLP Approval Trail" that lists recently approved audits (human vs AI).

## Changes

### 1. Schema — add `approved_by`
Migration on `nlp_audit_logs`:
```sql
ALTER TABLE nlp_audit_logs ADD COLUMN IF NOT EXISTS approved_by text;
```
No RLS/GRANT changes (table already exposed).

### 2. `src/lib/coding-pipeline.ts` — extend `approveMrnCoding`
- Add optional 2nd arg `approvedBy: 'human' | 'ai' = 'human'`.
- When flipping the latest audit-log row to `approved`, also set `approved_by: approvedBy`.
- Everything else unchanged so existing callers keep working.

### 3. `src/components/admin/dictionary/NlpAuditLogsPanel.tsx` — collapsible cards + timer

Refactor `AuditCard`:
- New `expanded` state, default `false`. Header row remains visible (MRN, timestamp, CC snippet, confidence badge, status badge) plus a chevron button (`ChevronDown`/`ChevronUp` from lucide) that toggles expansion.
- Streams A–F grid + action footer (Edit/Re-code/Approve) render only when `expanded`.
- Click anywhere on header (or chevron) toggles.

Auto-approval timer (only when `row.status !== 'approved'`):
- Show a thin horizontal progress bar directly under the header. Bar drains from 100% → 0% over **120s** starting from `row.created_at` (so refreshes don't reset the timer).
- Color interpolated by remaining %: `>66%` emerald, `33–66%` amber, `<33%` red.
- `useEffect` with `setInterval(250ms)` recomputes `remaining = max(0, 120000 - (now - createdAt))`.
- When `remaining` hits 0 and status still pending, call `approveMrnCoding(mrn, 'ai')` exactly once (guarded by a `firedRef`), toast "Auto-approved by AI", refresh.
- Manual `Approve` button now calls `approveMrnCoding(mrn, 'human')` and cancels the timer via the same `firedRef` guard.
- Bar hidden entirely for approved rows.

### 4. Rename tab + component to "NLP Approval Trail"
- `src/components/admin/Step8Surfacing.tsx`: rename export `UmlsResolutionTrail` → `NlpApprovalTrail` (keep a re-export alias so no other file breaks) and replace its body per §5.
- `src/routes/system-admin.tsx`: update import + JSX usage + any nav label showing "UMLS Resolution Trail" → "NLP Approval Trail".

### 5. New `NlpApprovalTrail` content
Replace resolver-activity body with:
- Query: `nlp_audit_logs` where `status = 'approved'`, order by `updated_at desc`, limit 50. Realtime subscription like the audit panel.
- Render each row as a collapsible card using the **same** `AuditCard` visuals from NlpAuditLogsPanel. To avoid duplication, extract `AuditCard` into its own file (`src/components/admin/dictionary/AuditCard.tsx`) and import it in both panels. Add prop `readOnly?: boolean` — hides Approve/Re-code/Edit footer when true (approval trail is read-only).
- Extra pill in the header: green "Human" badge if `approved_by === 'human'`, blue "AI" badge if `approved_by === 'ai'` (fallback "—" if null on legacy rows).
- Default collapsed; expand shows the same 6 stream cards.
- No auto-approval bar (already approved).

### 6. No other files touched
Auto Terminologist, coding pipeline sweep, Live Terminology Matrix, and Cross-Map Studio remain unchanged.

## Verification
- Load `/system-admin` → NLP Audit Logs: all pending cards start collapsed with a draining color bar; clicking chevron expands; leaving one alone for 2 min auto-approves and shifts it to the Approval Trail tagged **AI**.
- Click Approve on another pending card → immediate approval tagged **Human**, bar disappears.
- Switch to the renamed "NLP Approval Trail" tab → shows up to 50 approved rows, newest first, each collapsible, correct Human/AI badge.
