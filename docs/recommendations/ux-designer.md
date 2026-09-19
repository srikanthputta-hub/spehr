# UX Roadmap Recommendation — S.P.E.H.R.

Author: UX design pass, 2026-09-18. Scope: this repo only (spehrancillary.live and
spehranalytics.live are separate repos and out of reach from here — flagged for a
follow-up audit request to whoever owns those). Read-only investigation; no code changed.

## Context / what I found

Physician Board (`src/routes/physician-board.tsx`, 1369 lines) has real aria-label
coverage now (8 instances — census row selection, CPOE dose/route/frequency fields).
Nothing else in the app does:

| Route | Lines | aria-label | role | tabIndex |
|---|---|---|---|---|
| `nursing-board.tsx` | 1109 | 1 | 0 | 0 |
| `pharmacy-queue.tsx` | 818 | 0 | 0 | 0 |
| `admin-dashboard.tsx` | 925 | 0 | 0 | 0 |
| `system-admin.tsx` | 4744 | 0 | 0 | 0 |

`system-admin.tsx` is the largest route file in the repo by a wide margin and has zero
accessibility audit history — bigger blind spot than Nursing/Pharmacy combined.

Component structure: 86 `.tsx` files under `src/components/`. 47 are shadcn/Radix
primitives in `src/components/ui/` (button, dialog, table, etc. — a real foundation
already exists). But `src/components/common/` has exactly **one** file (`LiveClock.tsx`).
Domain folders (`admin/` 18, `patient/` 5, `physician/` 5, `admissions/` 3) look
built independently per workspace rather than against shared composite patterns
(status badge, patient-row card, async-state wrapper) — worth confirming per-file
during the audit, but the folder shape is consistent with duplicated, drifting patterns.

No `ErrorBoundary` usage anywhere in `src/routes` or `src/components`. No route greps
positive for `.isLoading`/`.isPending`/`.isError`/`isFetching` despite React Query being
the data layer — loading/error states, where they exist, aren't using a recognizable
shared idiom. Only 2 files reference the existing `Skeleton` component. No
keyboard-shortcut/hotkey handling found in any clinical workflow file (CPOE, MAR, order
entry) — only incidental `keydown` use inside vendored Radix components
(command/menubar/sidebar) and two combobox/modal files, not real app-level shortcuts.

## Recommendations (prioritized)

**1. Accessibility audit + fix: System Admin first, then Nursing/Pharmacy/Admin dashboard — High priority, ~3-5 days**
`system-admin.tsx` is 4x bigger than any other route and totally unaudited; do it before
the smaller boards so the biggest risk surface is covered first. Reuse the physician-board
pattern (aria-label on interactive rows/fields, not a redesign) rather than inventing a new
convention. Sequence: system-admin → nursing-board → pharmacy-queue → admin-dashboard.

**2. Consistent async-state pattern (loading/error/empty) via shared components — High priority, ~2-3 days**
No file currently follows a recognizable loading/error idiom despite React Query usage
app-wide, and `Skeleton` is nearly unused. Build 2-3 shared primitives in
`src/components/common/` (e.g. `AsyncBoundary`/`QueryStateWrapper`, a standard error-toast
helper) and retrofit the busiest workspace (Nursing or Pharmacy — highest patient-throughput)
first as the reference implementation, then propagate. This is the single highest-leverage
item: it fixes a cross-cutting gap once instead of workspace-by-workspace.

**3. Design system consolidation audit: `src/components/common/` — Medium priority, ~2 days to scope, effort after that scales with findings**
With 86 component files and only 1 shared common component, there's likely real
duplication (status badges, patient-card headers, section containers) across
`admin/`, `patient/`, `physician/`, `admissions/`. Don't build a new system — the
47-file shadcn/Radix base in `ui/` is solid and shouldn't be replaced. Scope this as
an inventory pass (diff visual patterns across workspace files) before committing to
extraction effort; recommend against a big-bang refactor given "surgical fixes, not
rewrites" project style.

**4. CPOE/MAR keyboard shortcuts for speed — Medium priority, ~3-4 days**
Clinical workstation UIs live or die on keyboard efficiency (order entry, MAR
scanning) and this repo currently has none — every interaction is mouse-only. Start
narrow: physician-board CPOE panel (already accessibility-hardened, so it's the safest
place to layer in `Tab`-order-aware shortcuts, e.g. quick-submit on `Ctrl+Enter`,
field-to-field nav) before touching Nursing MAR. Validate with an actual clinician
persona/user if possible — shortcut choices are easy to get wrong without domain input.

**5. ErrorBoundary coverage — Medium priority, ~1-2 days**
Zero `ErrorBoundary` usage anywhere means any unhandled render error in a clinical
workspace currently white-screens the tab mid-shift. Add route-level boundaries (TanStack
Start's error component convention) at minimum for the four unaudited workspaces plus
physician-board, with a clinical-appropriate fallback (not a generic crash page — should
make clear what happened and that no data was lost).

**6. Cross-repo consistency check (flag, don't fix) — Low priority now, revisit post-migration**
spehrancillary.live and spehranalytics.live weren't reachable for this pass. Once the
Supabase project migration (see main CLAUDE.md) settles, worth a lightweight visual/
interaction diff against those two domains so Nursing/Pharmacy/Admin here don't drift
from whatever patterns those repos use — same clinical staff may move between them.

## Expected UX debt pattern (for planning, not yet verified per-file)

Given the clinical-workstation shape of this app (shift-based use, high interruption
rate, mouse+keyboard split by role), expect: inconsistent status-color semantics across
workspaces (color-only indicators without text/icon backup — 9 raw `bg-red/green/yellow`
hits in nursing-board alone, worth checking for text pairing), copy-pasted modal/drawer
boilerplate instead of shared primitives, and loading states that silently show stale
data rather than a spinner/error (common failure mode when `isLoading` isn't checked).
Recommendation #2 addresses the last one directly; the others should surface naturally
during the audits in #1.
