## Goal
Replace the always-visible `CdsSuggestionsBanners` above the Summary with a conditional **CDS Protocol button** in the patient chart's tab row that opens a right-side slide-over showing the fired order set as an interactive checklist.

## Changes

### 1. `src/routes/patient.$mrn.tsx`
- Remove `<CdsSuggestionsBanners mrn={patient.mrn} />` at line 1426 and its import.
- Add a small `useCdsActiveSuggestion(mrn)` hook (inline in the file) that:
  - Reads `localStorage["spehr.cds.suggestions.${mrn}"]`.
  - Subscribes to `spehr:cds` and `storage` events.
  - Returns the highest-severity non-dismissed suggestion (order: `septic-shock` → `acs` → `sepsis-bundle` → `infection-workup`) or `null`.
- In the `TABS_ROW1` `<nav>` block (line 1484-1488), render a new `<CdsProtocolTabButton>` at the end of row 1, only when a suggestion exists. It sits inline with the tab row, same height as the tab buttons, does not become a `TabKey` (does not affect `tab` state).
- Panel state (`cdsPanelOpen`) lives on `PatientChart`; button click sets it true.

### 2. New component `src/components/patient/CdsProtocolTabButton.tsx`
- Props: `{ suggestion, onOpen }`.
- Renders a pill-height button matching the existing tab button height:
  - Amber background, red border, red pulsing dot (`animate-pulse`) on the left.
  - Label derived from `ORDER_SETS[suggestion.id].label` (strip leading emoji, prefix with 🔴 or ⚠ per severity → matches the spec: "🔴 ACS Protocol", "🔴 Sepsis Protocol", "🔴 Septic Shock", "⚠ Infection Workup").
  - Critical severity gets a slightly stronger border/ring.

### 3. New component `src/components/patient/CdsProtocolPanel.tsx`
- Props: `{ mrn, suggestion, onClose }`.
- Right-side slide-over: `fixed inset-0 z-50 flex` with a dimmed backdrop and `<aside className="ml-auto w-96 h-full bg-white shadow-2xl flex flex-col">`.
- Header shows the protocol title (per severity: ACS immediate workup / Sepsis 3-hour bundle / Septic Shock escalated / Infection Workup) and a "Triggered by:" line with the SNOMED display term (see storage extension below; falls back to "approved clinical concept" if unknown).
- Body: iterates `ORDER_SETS[suggestion.id].items`, each rendered as a `<label>` + `<input type="checkbox">`; checked state is local `useState<Record<string, boolean>>` — no DB write, resets on close.
- Footer:
  - **Dismiss Protocol** — updates `localStorage` to set `dismissed: true` for this `id`, dispatches `spehr:cds`, closes panel. Button then disappears from tab row automatically via the hook.
  - **Close** — closes panel only; suggestion stays active.

### 4. Storage extension — capture triggering SNOMED display term
- `src/hooks/useCdsSuggestionsWatcher.ts`: when a trigger fires, record the first matching code and its display term (best-effort via a small map in `cds-order-sets.ts`). Extend the stored suggestion type from `{ id, firedAt, dismissed? }` to `{ id, firedAt, dismissed?, triggerCode?, triggerDisplay? }`. Reads remain backward-compatible.
- `src/lib/cds-order-sets.ts`: export a `CODE_DISPLAY: Record<string,string>` covering the codes in `ACS_CODES`, `INFECTION_CODES`, `SEPTIC_SHOCK_CODE`, plus a small set of common sepsis-indicator codes; `matchTriggers` gains a variant/return that also reports which code fired each trigger (or a separate helper `firstTriggerCode(codes, id, sepsisSet, highAcuitySet)` used by the watcher).

## Out of scope
- No changes to any other tab, layout, or chart behaviour.
- No DB writes for checklist state.
- No changes to `nlp:approved` event chain, `DischargeConformanceBanner`, or the safety-alerts flow.

## Validation
- Typecheck via `tsgo`.
- Manually: chart with no fired suggestion → tab row unchanged. Approve an NLP row producing 59139008 → red "🔴 ACS Protocol" button appears at end of row 1; click opens right slide-over with the 6 ACS items, checkboxes toggle locally, **Dismiss Protocol** removes the button, **Close** keeps it.
