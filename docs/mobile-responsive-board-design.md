# Mobile-Responsive Clinical Board Design Spec

Status: design only — no implementation in this doc. Confirmed bug source: real iPhone Safari
screenshots showing `BoardHeader` (in `src/components/BoardShell.tsx`) and the tab-nav bar in
`src/routes/admissions-board.tsx` breaking on ~390px-wide viewports (text wrapping into a narrow
column, elements overlapping, a large empty gap where content got pushed off). Neither component
has any responsive breakpoints today. Scope is the internal clinical workspace (board routes) only
— the public login/hub page (`src/routes/index.tsx`) is confirmed fine and out of scope.

## Breakpoint decision

Use Tailwind's default **`md:` (768px)** as the single cutover point for both components, mobile-first
(unprefixed classes = the new mobile layout, `md:`-prefixed classes = the current/existing desktop
layout, unchanged). Rationale: `BoardHeader` packs a 4-line text block plus 4 separate right-side
controls (`FacilitySwitcher`, AI status pill, "Switch Role", "Log Out") — that combination realistically
needs ~900–1000px to lay out in one row without crowding, so `sm:` (640px) is too low a cutoff (a
640–767px window, e.g. a portrait tablet or a landscape phone, would still be cramped). `md:` puts phones
*and* portrait tablets into the compact mobile layout, and true desktop/tablet-landscape widths keep the
existing row exactly as it renders today. Do not introduce a third intermediate tier — it adds
implementation complexity for a doc-only handoff; a single breakpoint is enough to fix the confirmed bug.

---

## 1. `BoardHeader` mobile layout (`src/components/BoardShell.tsx`, lines 27–126)

### What stays visible at all times (< 768px)
- Logo (shrunk: `h-6` instead of `h-8`, `md:h-8` restores current size)
- Title only, truncated (the badge/role line, subtitle, and facility-dot line all move into the
  overflow menu or are hidden — see below)
- AI Engines / Manual Mode status pill, but **icon-only** below `sm:` (400px+ still shows the label)
- A new overflow ("...") trigger button

### What collapses into the overflow menu (< 768px)
One `DropdownMenu` (already used elsewhere in this file — same import, same primitives) combining:
- Facility name + `FacilitySwitcher` (the existing `<label>`/`<select>` component, embedded as a
  plain node inside `DropdownMenuContent`, not wrapped in `DropdownMenuItem` — a raw `<select>` does
  not trigger Radix's `onSelect`/close behavior, so it's safe to drop in as-is; the coder should still
  manually verify on a touch device that tapping the select doesn't dismiss the menu before it opens)
- "Switch Role" — reuse the existing `ROLE_LINKS.map(...)` block verbatim
- "Log Out" — reuse the existing `logout` handler

### Exact structural change

Replace the current `<header>` (lines 46–124) with a mobile-first version. Keep all existing logic
(`useNavigate`, `useFacility`, `useAutomationEnabled`, `logout`, `ROLE_LINKS`) unchanged — this is a
markup/class change only, plus one new `DropdownMenu` instance and one new icon import
(`MoreVertical` from `lucide-react`, alongside the existing `LogOut, Construction, Users, Hand, Zap`
import on line 2).

```tsx
<header className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 md:px-6 md:py-3">
  <div className="flex items-center gap-2 md:gap-3 min-w-0">
    <Link to="/" className="flex items-center shrink-0">
      <img src={spehrLogo} alt="S Group Private Network" className="h-6 w-auto md:h-8" />
    </Link>
    <div className="leading-tight min-w-0">
      <div className="hidden md:block text-[10px] uppercase tracking-[0.22em] text-slate-500">
        S.P.E.H.R. · {badge ?? "Clinical"}
      </div>
      <div className="text-sm font-semibold text-slate-900 truncate max-w-[160px] sm:max-w-[280px] md:max-w-none">
        {title}
      </div>
      {subtitle && (
        <div className="hidden md:block text-[11px] text-slate-500">{subtitle}</div>
      )}
      <div className="hidden md:block text-[10px] text-slate-500 mt-0.5">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1 align-middle" />
        {facility}
      </div>
    </div>
  </div>

  <div className="flex items-center gap-1.5 md:gap-3 shrink-0">
    {/* AI status pill — icon-only under sm:, icon+label from sm: up, unchanged from md: up */}
    <span
      title={
        automationEnabled
          ? "AI engines are running across the hospital network"
          : "All AI engines paused — every action must be performed manually"
      }
      className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 sm:px-2.5 sm:py-1.5 text-[10px] font-bold uppercase tracking-wider border ${
        automationEnabled
          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
          : "bg-amber-50 text-amber-800 border-amber-300"
      }`}
    >
      {automationEnabled ? <Zap className="h-3 w-3" /> : <Hand className="h-3 w-3" />}
      <span className="hidden sm:inline">{automationEnabled ? "AI Engines" : "Manual Mode"}</span>
    </span>

    {/* Desktop-only inline controls — identical to current markup, just wrapped */}
    <div className="hidden md:flex items-center gap-3">
      {!hideFacilitySwitcher && <FacilitySwitcher variant="light" />}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Users className="h-3.5 w-3.5" /> Switch Role
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-60">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
            Switch Clinical Role
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {ROLE_LINKS.map((r) => (
            <DropdownMenuItem
              key={r.to}
              onSelect={() => navigate({ to: r.to }).catch(() => {})}
              className="cursor-pointer flex items-center justify-between gap-3"
            >
              <span className="text-sm text-slate-800">{r.label}</span>
              <span className="text-[11px] font-semibold text-[#2d8a9e]">{r.abbrev}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        onClick={logout}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <LogOut className="h-3.5 w-3.5" /> Log Out
      </button>
    </div>

    {/* Mobile-only overflow menu: facility switcher + switch role + log out */}
    <div className="md:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="More options"
            className="inline-flex items-center justify-center h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-64">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.18em] text-slate-500 flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {facility}
          </DropdownMenuLabel>
          {!hideFacilitySwitcher && (
            <div className="px-2 py-1.5">
              <FacilitySwitcher variant="light" />
            </div>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
            Switch Clinical Role
          </DropdownMenuLabel>
          {ROLE_LINKS.map((r) => (
            <DropdownMenuItem
              key={r.to}
              onSelect={() => navigate({ to: r.to }).catch(() => {})}
              className="cursor-pointer flex items-center justify-between gap-3"
            >
              <span className="text-sm text-slate-800">{r.label}</span>
              <span className="text-[11px] font-semibold text-[#2d8a9e]">{r.abbrev}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={logout} className="cursor-pointer flex items-center gap-1.5 text-slate-800">
            <LogOut className="h-3.5 w-3.5" /> Log Out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</header>
```

Notes for the coder:
- `variant="light"` on `FacilitySwitcher` is reused unchanged in both places (desktop inline + mobile
  menu) — no new variant needed.
- Two `ROLE_LINKS.map(...)` blocks (desktop dropdown + mobile overflow menu) is intentional duplication,
  not a bug — keep both in sync if `ROLE_LINKS` ever changes shape. Do not try to dedupe by rendering
  one `DropdownMenu` for both breakpoints; the desktop one must stay a dedicated "Switch Role" trigger
  since Log Out/FacilitySwitcher stay inline on desktop.
- No changes needed to `PlaceholderBoard` (lines 128–159) — it already renders fine at mobile widths
  (single centered card, no fixed-width row).

---

## 2. Tab-nav bar mobile layout

### Decision: horizontal scroll, not icon-only

Recommend **(a) horizontal scroll** (`overflow-x-auto` + `snap-x` + hidden/thin scrollbar), keeping full
icon+label buttons, over icon-only-with-tooltip. Reasoning:
- Tooltips (`src/components/ui/tooltip.tsx` exists in this repo) are a hover affordance — meaningless on
  a touchscreen phone, which is exactly the confirmed bug environment (iPhone Safari). Shipping
  icon-only tabs with no working "hint" mechanism on the actual broken device defeats the point.
- Some tab labels aren't safely inferable from icon alone in a clinical context ("Home" is a
  `ClipboardList` icon, not a house — icon-only would be actively confusing, and this is a clinical
  safety tool where mislabeling a tab has real workflow cost).
- Horizontal scroll is a smaller, lower-risk structural change: wrap the existing button row, no new
  component, no behavior change to the buttons themselves.

### File: `src/routes/admissions-board.tsx`, lines 106–130

Current:
```tsx
<div className="sticky top-0 z-10 border-b border-border bg-[var(--navy)] text-white">
  <div className="max-w-[1400px] mx-auto px-5 h-12 flex items-center gap-1">
    {tabs.map((t) => { ... })}
    <div className="ml-auto text-[11px] text-white/60 inline-flex items-center gap-1">
      {bedCounts.available} / {bedCounts.total} beds open
      <InfoHint ... />
    </div>
  </div>
</div>
```

Change to (wrap the scrollable tab row separately from the non-scrolling "beds open" counter so the
counter doesn't get swiped away, and add a scroll-snap + edge-fade affordance so users know there's
more to scroll):

```tsx
<div className="sticky top-0 z-10 border-b border-border bg-[var(--navy)] text-white">
  <div className="max-w-[1400px] mx-auto px-3 md:px-5 h-12 flex items-center gap-2">
    <div className="flex-1 min-w-0 overflow-x-auto snap-x snap-mandatory board-tabs-scroll">
      <div className="flex items-center gap-1 w-max">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`snap-start shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-semibold transition ${
                active
                  ? "bg-[var(--teal)] text-white shadow"
                  : "text-white/70 hover:bg-white/10 hover:text-white"
              }`}
            >
              <Icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          );
        })}
      </div>
    </div>
    <div className="hidden sm:inline-flex shrink-0 text-[11px] text-white/60 items-center gap-1">
      {bedCounts.available} / {bedCounts.total} beds open
      <InfoHint text={`Beds where bed_management.status = "Available" at ${facility}. Beds in "Cleaning" or "Disinfecting" are not counted as open — they roll back to Available automatically when the cleaning cycle finishes.`} />
    </div>
  </div>
</div>
```

The "beds open" counter is hidden below `sm:` (400px) rather than squeezed — it's supplementary info
already visible on the Bed Management tab itself, not safety-critical to show in the nav bar on the
smallest screens. From `sm:` up it reappears exactly as today.

Add one small CSS utility to `src/styles.css` (same `@utility` pattern already used for `.scroll-feed`
at lines 110–132) so the tab row scrolls smoothly with a barely-visible scrollbar instead of the
default (heavy) browser scrollbar, consistent with the app's existing scroll styling:

```css
@utility board-tabs-scroll {
  scroll-behavior: smooth;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: rgb(255 255 255 / 0.25) transparent;

  &::-webkit-scrollbar { height: 6px; }
  &::-webkit-scrollbar-track { background: transparent; }
  &::-webkit-scrollbar-thumb {
    background: rgb(255 255 255 / 0.25);
    border-radius: 9999px;
  }
}
```

(This is a light-on-dark variant of the existing `.scroll-feed` utility — same mechanism, different
color since this bar is `bg-[var(--navy)]` rather than a white card.)

### File: `src/routes/nursing-board.tsx`, lines 725–745

This bar is **not** the same tab-button pattern — it's a search input + a `LiveClock`, already partly
responsive (`hidden sm:flex` on the clock). No tab-nav fix needed here. The only mobile gap: the search
input's parent `<div className="max-w-[1400px] mx-auto px-5 h-12 flex items-center gap-4">` uses
`px-5` at all widths — for consistency with the header/tab-bar padding change above, change to
`px-3 md:px-5` so the search bar doesn't crowd the screen edge on a 390px phone. That's the only change
needed in this file.

### Other board routes — audited, no similar tab-nav pattern found

Grepped `physician-board.tsx`, `finance-board.tsx`, `system-admin.tsx`, and `admin-dashboard.tsx` for
the same `TabKey`/`tabs.map`/sticky-navy-bar pattern used in `admissions-board.tsx`. None of them have
it — they use plain section headers, tables (`overflow-x-auto` already present in several places, e.g.
`finance-board.tsx:539`, `system-admin.tsx:2675`/`3374`), or card grids instead of a fixed tab-button
row. **No changes needed in those four files for this bug.** If a future audit finds a similar
unresponsive nav pattern introduced later in any board route, apply the same `overflow-x-auto` +
`snap-x` + `board-tabs-scroll` treatment shown above.

---

## 3. Summary — files to change

| File | Change |
|---|---|
| `src/components/BoardShell.tsx` | Rewrite `BoardHeader`'s `<header>` (lines 46–124) per section 1 above. Add `MoreVertical` to the `lucide-react` import on line 2. No changes to `PlaceholderBoard` or `ROLE_LINKS`. |
| `src/routes/admissions-board.tsx` | Wrap tab-button row (lines 106–130) in a horizontal-scroll container per section 2 above; hide "beds open" counter below `sm:`. |
| `src/routes/nursing-board.tsx` | Change `px-5` → `px-3 md:px-5` on the sticky bar's inner container (line 726 area) only. No tab-nav change (different pattern, already partly responsive). |
| `src/styles.css` | Add `board-tabs-scroll` utility near the existing `scroll-feed` utility (lines 110–132). |

No other board route files (`physician-board.tsx`, `finance-board.tsx`, `system-admin.tsx`,
`admin-dashboard.tsx`, `tasks.tsx`, `radiology-board.tsx`, `pharmacy-queue.tsx`, `lab-board.tsx`,
`ancillary-services.tsx`, `analytics.tsx`) need changes for this bug — they consume the fixed
`BoardHeader` (covered by the `BoardShell.tsx` change) and don't have their own tab-nav bar.

## 4. Design-system consistency checklist (for the coder to self-verify)

- Reuses `@/components/ui/dropdown-menu` primitives already imported in `BoardShell.tsx` — no new
  dependency.
- Reuses existing colors (`bg-[var(--navy)]`, `bg-[var(--teal)]`, `slate-*`, `emerald-*`, `amber-*`)
  exactly as used elsewhere in these files — no new palette values introduced.
- Reuses the existing `.scroll-feed`-style `@utility` CSS pattern for the new `board-tabs-scroll`
  utility rather than inventing a new styling mechanism.
- `FacilitySwitcher`'s existing `variant="light"` prop is reused unchanged; no new variant needed.
- No new icon library — `MoreVertical` is from `lucide-react`, already a project dependency (same
  package `LogOut`, `Users`, `Hand`, `Zap` already come from in `BoardShell.tsx`).
