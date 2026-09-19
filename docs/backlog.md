# S.P.E.H.R. Consolidated Backlog

Prioritized across all engineering review rounds. Effort: S/M/L. Status reflects current repo state
verified against code/docs on 2026-09-18 (not just prose claims).

## P0 — Security, deploy now

1. **fhir-proxy arbitrary-DELETE vuln** — fixed in code: `validateBundleEntries()` in
   `supabase/functions/fhir-proxy/index.ts` guards DELETE to a specific `ResourceType/id` path
   (rejects bare-resource-type DELETEs) and strips caller-supplied query params on DELETE so a
   validated single-resource delete can't fan out via HAPI JPA's conditional-delete-by-search
   behavior. **Not confirmed deployed** — no deploy tooling output available to verify from the
   repo; treat as undeployed until checked. Effort: S. Status: fixed, undeployed.
   Action: `supabase functions deploy fhir-proxy --project-ref <ref>`, then verify with an actual
   rejected-DELETE request (not just a successful deploy message). Per
   `docs/recommendations/security-auditor.md` #1, also close the Bundle-transaction bypass in the
   same push — a `transaction` Bundle carrying `request.method: "DELETE"` entries currently routes
   around the passthrough allowlist — before deploying to either project (production
   `fjncfbqwyrenoavhkvdr` and migration target `qxyvmvtecnnwqeqaouzh`).
2. **RLS disabled on 26 tables** (migration-target project `qxyvmvtecnnwqeqaouzh`), plus 12
   anon/authenticated-callable SECURITY DEFINER functions and 2 SECURITY DEFINER views. Planning is
   now **complete**: `docs/rls-remediation-plan.md` covers the full table-by-table policy design for
   all 26 tables (up from an earlier partial draft covering 5), plus the SECURITY DEFINER
   function/view exposure analysis. Effort: L. Status: **planning complete, SQL not yet applied to
   any project.** Needs explicit sign-off on the SECURITY DEFINER RPC exposure decision before
   applying SQL. Per `docs/recommendations/security-auditor.md` #2, apply this on the migration
   target *before* cutover (no production traffic there yet), not as a post-cutover follow-up.

## P1 — Correctness / reliability

3. **Leader-election race in `useAutoTerminologist.ts`** — non-atomic localStorage read-then-write
   caused duplicate cycles/drafts and couldn't coordinate across browsers/deployments. **Now
   implemented** (not just designed): `claimLease()`, `heartbeatLease()`, and
   `releaseLeaseBestEffort()` in `src/hooks/useAutoTerminologist.ts` call a new atomic DB-backed
   lease via `supabase/migrations/20260918000000_automation_leases.sql`
   (`claim_automation_lease`/`heartbeat_automation_lease` RPCs, table `automation_leases`).
   Security fixes applied: both `_lease_ms` and `_min_interval_ms` are server-side clamped
   (`[30000, 300000]` and `[60000, 3600000]` respectively) so a caller can't request an effectively
   unbounded lease or defeat the cadence gate. Reviewer-found bugs also fixed: heartbeat cadence
   corrected and a dead `releaseLeaseBestEffort()` call path fixed. Effort: M. Status:
   **implemented, migration not yet applied to any Supabase project** — per the migration file's own
   header, the RPCs don't exist until it's applied, so shipping the hook change first against an
   unmigrated project makes every tick a silent no-op. Doc: `docs/leader-election-fix-design.md`.
   **New finding (`docs/recommendations/architect.md` R4):** the identical
   read-then-write-`localStorage` pattern still exists, unfixed, in `useAutomationWatchdog.ts`
   (gates the core ghost-tick admission engine — `auto_admit_ghost_patient`) and
   `useCodingPipelineSweep.ts`. The `automation_leases` table/design already supports more rows
   (PK is `engine`), so generalizing is additive (new engine rows + a shared `useEngineLease` hook),
   not new SQL. Not yet done — track as a follow-up once the terminologist lease is applied and
   verified.
4. **Test coverage** — was zero-to-minimal (one test file). `src/hooks/useAutoTerminologist.test.ts`
   now has **18 tests** (up from 10), including coverage of the `claim_automation_lease`/
   `heartbeat_automation_lease` RPC names/arguments and the no-op behavior when the RPC doesn't
   exist. `vitest.config.ts` is tracked/in place. Effort: L. Status: meaningfully improved for this
   one file; still the only test file repo-wide. Per `docs/recommendations/architect.md` R6, further
   investment should go to schema-drift CI + Edge Function contract tests rather than generic
   component coverage.
5. **Accessibility gaps** — was: unlabeled patient rows, placeholder-text-as-label on CPOE fields.
   **Now fixed** on the physician board: `src/routes/physician-board.tsx` has `aria-label` on patient
   census rows (`Select patient {name}, room {room}, {diagnosis}`) and on CPOE dose/route/frequency/
   drug-name fields; `src/components/physician/SemanticAutocomplete.tsx` accepts and applies an
   `ariaLabel` prop, used by those CPOE fields. Effort: M. Status: **physician board census rows +
   CPOE fields fixed; other workspaces still unaudited.** Confirmed via
   `docs/recommendations/ux-designer.md`: `system-admin.tsx` (largest route file in the repo, 4744
   lines) has zero aria-label/labeling hits and is called out as highest-priority next; `nursing-board.tsx`
   and `pharmacy-queue.tsx` are likewise essentially unaudited. Recommended sequence per that doc:
   system-admin → nursing-board → pharmacy-queue → admin-dashboard.

## P2 — Hygiene / gating

6. **~67k CRLF lint errors blocking lint-in-CI gate** — root cause is missing `.gitattributes` +
   repo-level `core.autocrlf` normalization; mechanical, not real violations. Still unstarted: no
   `.gitattributes` file exists in the repo. Effort: M (mechanical but large diff, needs staged
   commits). Status: designed only, not applied. Doc: `docs/lint-cleanup-plan.md` (gitattributes →
   renormalize → `eslint --fix` → CI gate, each its own commit). Per
   `docs/recommendations/architect.md` R6, sequence this *after* CRLF renormalization and land it
   last relative to other CI additions (a schema-drift job first), or the 67k mechanical errors will
   make the gate unadoptable and it'll get disabled.

## On hold (explicit, not being worked)

7. **FHIR sync failures across most patients in production** — reported broadly in prod. Status:
   **on hold per user decision** — do not imply active work.

## Strategic recommendations (new, docs/recommendations/)

A full review round produced 11 role-specific recommendation docs in `docs/recommendations/`
(analyst, architect, clinical-informaticist, coder, data-engineer, devops, researcher, reviewer,
security-auditor, tester, ux-designer) — these didn't exist when the backlog above was first
written. They are recommendation-only (nothing implemented/applied), forward-looking, and
complementary to this tactical queue — see that directory for the full architectural and security
analysis. The two most severe *new* findings from that round, not yet reflected as fixes above:

- **Leader-election bug pattern is unfixed in two more places.** Per `docs/recommendations/architect.md`
  (R4), the same non-atomic localStorage read-then-write race that item 3 above just fixed for
  `useAutoTerminologist.ts` also drives `useAutomationWatchdog.ts` (which gates the simulation's core
  admission engine, `ghostTick`/`auto_admit_ghost_patient`) and `useCodingPipelineSweep.ts`. Neither
  has been migrated to the new DB-backed lease. Also newly noted: `localStorage` is per-origin, so
  with three deployed frontends (spehr.live, spehrancillary.live, spehranalytics.live) reading one
  shared database, "only one tab drives this" was never true product-wide, even before the intra-origin
  race — the DB-backed lease fixes both problems at once. (spehrancillary.live and spehranalytics.live
  were dropped from active scope 2026-09-19 — see CLAUDE.md's Product topology section — but they're
  still live, not deleted, so this finding stays valid as long as they keep running; going forward,
  only spehr.live + MySpehr need to be designed around.)
- **Three unauthenticated TanStack API routes fall outside the auth-hardening plan's scope.** Per
  `docs/recommendations/security-auditor.md` #4, `docs/edge-function-auth-hardening-plan.md` only
  reasons about the 14 Supabase Edge Functions, but `src/routes/api/public/umls-search.ts` and
  `src/routes/api/public/umls-validate-code.ts` (unauthenticated, forward to UMLS with the
  server-side `UMLS_API_KEY`, no rate limit or origin check) and `src/routes/api/public/directory.ts`
  (reads `staff_roster` via `supabaseAdmin`/service_role, unauthenticated) are a parallel
  Worker-hosted unauthenticated surface the plan doesn't cover. Recommendation: fold a Worker-side
  twin of Stage 0 (CORS allowlist) and Stage 3 (quota) into the existing plan rather than tracking
  separately, or it will be forgotten.
