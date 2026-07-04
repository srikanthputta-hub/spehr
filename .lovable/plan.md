
## Changes to `src/components/admin/dictionary/AuditCard.tsx`

### 1. Add 6-minute needs_review countdown
- Add constant `NEEDS_REVIEW_AUTO_APPROVE_MS = 360_000`.
- Compute a second `nrRemainingMs` / `nrStartPct` from the same anchor (`admissionAt ?? row.created_at`) using the 6-minute window.
- In the existing `useEffect`, add a parallel branch: when `autoApprove && needsReview && !approved && !firedRef.current`, schedule `onAutoApprove?.(row)` at `nrRemainingMs`. Reuse `firedRef` / `timeoutRef` so manual approve still cancels it.
- Before firing, tag the row locally: `(row as any).__autoReviewed = true` so downstream `onAutoApprove` handler / render can distinguish origin without a DB migration.

### 2. Orange countdown bar for needs_review
- Add a second progress-bar block mirroring the existing green one, gated on `autoApprove && !approved && needsReview && nrRemainingMs > 0`.
- Same drain animation, `backgroundColor: "#f59e0b"` (orange), title `Auto-reviews in Ns`.
- Green bar's render condition already excludes `needsReview`, so the two never show together.

### 3. New "AI REVIEWED" amber badge
- Track original status via a local flag: read `(row as any).__autoReviewed === true` OR infer from `approved_by === 'ai'` combined with a persisted marker. Since no DB migration is allowed and `standardized_output` / `extraction_mapping` are the only jsonb fields, use `row.extraction_mapping?.auto_reviewed === true` as the derivation source when present, falling back to the local flag set at auto-approve time.
- Add a third badge branch in the header:
  - `approved && approvedBy === 'ai' && autoReviewed` → amber badge `<Sparkles/> AI Reviewed` (`border-amber-300 bg-amber-50 text-amber-700`).
  - Existing blue AI badge only when `approvedBy === 'ai' && !autoReviewed`.
  - Green USER badge unchanged.

### Not touched
- 3-minute pending timer, green bar, blue AI badge for pending rows, all other files.

### Technical notes
- No new props; parent already passes `onAutoApprove`. The local `__autoReviewed` flag on the row object is enough for the current-session badge; the `extraction_mapping.auto_reviewed` read handles rows re-fetched after refresh only if a future writer sets it — acceptable per the instruction to prefer the no-migration path.
