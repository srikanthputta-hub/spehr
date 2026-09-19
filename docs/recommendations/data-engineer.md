# Data Engineer Recommendation — Schema/RLS/Migration Roadmap

Scope: sequencing for the RLS remediation plan (`docs/rls-remediation-plan.md`), the 10
dead-table cleanup candidates it identified, the pending `automation_leases` migration
(`supabase/migrations/20260918000000_automation_leases.sql`), and the untracked-migration-workflow
gap, all relative to the `fjncfbqwyrenoavhkvdr` → `qxyvmvtecnnwqeqaouzh` Supabase project
migration. Nothing below has been applied; this is a recommendation only.

## 1. Adopt a formal migration-file workflow on `qxyvmvtecnnwqeqaouzh` before applying anything else

Three schema changes are queued (RLS, dead-table cleanup, `automation_leases`). Applying any of
them ad hoc (dashboard SQL editor, one-off `execute_sql`/`apply_migration` calls) bakes fresh
undocumented debt into the exact project meant to replace Lovable's opaque management of the old
one. Go first, is free (pure process, zero prod impact), and turns the next three changes into the
workflow's first real test cases. Concretely: `supabase migration new <name>` → commit the file →
`supabase db push --linked` (or CI-gated apply) against `qxyvmvtecnnwqeqaouzh` only; leave the old
project's Lovable-generated migration history untouched since that project is being retired, not
maintained. Do not retroactively renumber existing timestamp-UUID files — just stop hand-applying
SQL from here on.

## 2. Apply `automation_leases` next, under the new workflow, as one atomic change with its paired hook deploy

It's additive-only (one new table, two `SECURITY DEFINER` functions, no `ALTER` on existing
tables/RLS), already designed and reviewed (`docs/leader-election-fix-design.md`), and fixes a live
correctness bug (duplicate value-set drafts/log rows from the localStorage race) in the same
demand-queue automation that the migration plan's next step needs to validate anyway. Bundling the
fix in now means that validation only has to happen once. Per the migration file's own header, the
DB migration and the `useAutoTerminologist.ts` RPC-calling code must ship together — deploying
either alone is either inert or a silent no-op.

## 3. Roll out RLS (and the SECURITY DEFINER function/view decision) on `qxyvmvtecnnwqeqaouzh` *before* the planned admissions/discharges validation, not after

CLAUDE.md's next step is "point a dev/preview build at the new project and confirm
admissions/discharges actually start flowing." The RLS plan's policies were explicitly designed to
preserve anon read/write wherever ghost-tick automation needs it, so if the plan is correct,
enabling RLS should be behavior-neutral for the simulation — and that validation pass is the
cheapest possible integration test to prove it, in dev/preview rather than after cutover. Bundle
the SECURITY DEFINER sign-off (accept anon-callable admission RPCs as intentional, or gate them
behind an edge function) into the same batch, since it touches the same admission path being
tested. Scope strictly to `qxyvmvtecnnwqeqaouzh` — no remediation effort on the old, soon-retired
project.

## 4. Treat dead-table cleanup as lock-down-now, drop-later — not part of the RLS migration batch

The "zero references" finding is grep-based against this repo only; it cannot see MySpehr (a
separate codebase reading the same FHIR server) or any other consumer. Recommend: enable RLS with
no anon/authenticated policy on all 10 (cheap, reversible, already drafted for `staff_roster`-style
tables) in step 3, but defer actual `DROP TABLE` until after cutover plus a burn-in period —
or use a reversible rename (e.g. into a `deprecated` schema) instead of an immediate drop, in case
a dependency surfaces post-cutover that static analysis couldn't catch.

## 5. Resolve the `fhir_sync_state` stale-cursor/RLS-anomaly discrepancy before relying on fail-open behavior past the validation window

`fhir_sync_state` already has RLS enabled with a service_role-only read policy
(`20260705205944_...sql`), yet CLAUDE.md notes it's empty and blocked by an RLS anomaly on the new
project even for `service_role` — that shouldn't happen given `service_role` normally bypasses RLS,
so the anomaly is worth a scoped fix, not a shrug. Recommendations: (a) the ~2-week-stale cursor is
almost certainly production's (`fjncfbqwyrenoavhkvdr`) — confirm which project it's on and treat it
as a production data-hygiene note, not a migration blocker; (b) do **not** backfill or copy that
stale cursor into the new project — it starts empty by design and should stay that way, consistent
with the "regenerate organically" simulation-data decision already made; (c) fix the RLS anomaly on
`qxyvmvtecnnwqeqaouzh` as part of the step-3 RLS batch, since the poll functions' fail-open-on-
missing-cursor behavior is acceptable for a bounded dev/validation window but shouldn't be the
permanent production posture after cutover.

## 6. Cutover to `qxyvmvtecnnwqeqaouzh` comes strictly after 1–5, with a schema freeze immediately following

No further schema changes should land in the same window as the production DNS/env cutover — if
something breaks post-cutover, it needs to be attributable to the migration itself, not a
concurrent RLS tweak or table drop. Confirm admissions/discharges flowing (already-planned next
step) only after steps 1–5 are in place, then hold schema changes for a short bake-in period before
resuming normal iteration.
