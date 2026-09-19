# S.P.E.H.R. Consolidated Roadmap

Synthesized from `docs/backlog.md` (tactical, current) and the 11 independent recommendation docs
in `docs/recommendations/` (architect, security-auditor, data-engineer, reviewer, coder, tester,
devops, ux-designer, clinical-informaticist, analyst, researcher). PM synthesis, not a concatenation
— judgment calls below are mine, flagged as such.

## Cross-role consensus (found by cross-referencing, not obvious from any one file)

- **RLS is a cutover precondition.** Architect (R3), security-auditor (#2), and data-engineer (#3)
  independently converge: apply RLS + resolve the SECURITY DEFINER sign-off on `qxyvmvtecnnwqeqaouzh`
  *before* the planned admissions/discharges smoke test, because that test and the RLS validation are
  literally the same check run once. Already backlog P0 #2.
- **A versioned, machine-checked contract beats another prose warning.** Four roles arrive at the
  same shape of fix from different angles: architect's R1 (contract package + schema-drift CI),
  coder's #2–#4 (zod at I/O boundaries, a domain-types layer, a shared FHIR contract doc), clinical-
  informaticist's #3 (IG-lite + CI schema-diff for FHIR resource shapes MySpehr depends on), and
  researcher's #5 (a FHIR bundle contract test replayed against a real HAPI server in CI). These are
  four instances of one idea — the schema/FHIR-shape contract that today lives only in `CLAUDE.md`
  prose needs to become a CI-enforced artifact. Treat as one workstream, not four.
- **Sequence lint-in-CI last, not first.** Architect (R6), reviewer (#1), and devops (#1) all say:
  CRLF renormalization → `eslint --fix` → lint gate, landed *after* other CI additions (schema-drift,
  tests), or the 67k mechanical errors make the gate unadoptable and it gets disabled.
- **Don't chase broad test coverage; chase the two highest-blast-radius seams.** Architect (R6),
  coder (#5), and tester (#1, #3) all rank the same two things first: the `fhir-proxy` DELETE-guard
  regression test, and `useAutoTerminologist.ts`'s quality-gate/suggestion logic. Independent
  agreement on *which* two things matters more than the general "add tests" advice.

## Conflict, with PM judgment call

**Dead-table cleanup timing.** Architect (R5) and security-auditor (#2) favor dropping the 10
zero-reference tables on the migration target before/alongside the RLS batch, once
`pg_stat_user_tables` on production confirms zero scans. Data-engineer (#4) is more conservative:
enable RLS with no policy now (cheap, reversible), but defer the actual `DROP`/rename-to-`archive`
until after cutover plus a burn-in period, because grep-based "zero references" can't see MySpehr or
the other two frontends. **Call: go with data-engineer.** The evidence check (`pg_stat_user_tables`)
hasn't actually been run yet by any role — it's proposed, not done — so an irreversible drop pre-
cutover is premature. Lock-down-now, drop-later costs almost nothing extra and removes the one
failure mode (a live cross-repo consumer nobody grepped for) that would be expensive to reverse.

## Scope disagreement to note

Architect's R6 explicitly argues *against* a generic test-coverage push, scoping investment to
schema-drift CI + Edge Function contract tests. Tester's plan is broader — jsdom + `renderHook` for
three more hooks, a Deno suite for Edge Functions, an integration smoke test, E2E deferred. These
aren't actually opposed (tester's first two priorities are the same fhir-proxy/quality-gate tests
architect wants), but tester's total scope is larger. **Call: treat architect's ranking as the gate
and tester's document as the execution plan behind it** — do items 1 and 3 (Deno, starting with
fhir-proxy/umls-proxy) from tester's list inside Phase 3 below; defer tester's item 2 (hook-level
jsdom coverage) and item 5 (E2E) until Phase 4, since neither addresses the migration-era risk.

## Roadmap

**Phase 1 — Pre-cutover hardening (migration target only, no prod traffic risk)**
Deploy the `fhir-proxy` DELETE fix + close its Bundle-transaction bypass, to both projects, verified
by an actual rejected request (backlog P0 #1; security-auditor #1). Apply RLS + dead-table lock-down
+ SECURITY DEFINER sign-off + `fhir_sync_state` anomaly fix as one batch (backlog P0 #2; architect
R3/R5; data-engineer #3–#5). Apply `automation_leases` and ship the paired `useAutoTerminologist.ts`
change together (backlog P1 #3; data-engineer #2). Auth-hardening Stages 0–1 (CORS + log-only
classifier), extended to the three unauthenticated `/api/public/*` Worker routes (backlog's flagged
gap; security-auditor #4).

**Phase 2 — Cutover rehearsal and execution**
Preview builds of the two consumers now in active scope (this repo, MySpehr) against the new
project — not just this repo, per architect R3's key correction to the existing plan. (Originally
scoped to *all four* consumers including ancillary/analytics; narrowed 2026-09-19 when those two
were dropped from active scope — see CLAUDE.md's Product topology section. Their deployments are
still live and still share the same Supabase project/FHIR server, so a cutover could still affect
them, but verifying their preview builds is no longer this repo's responsibility.) Build the
contract package + schema-drift CI during this window, since the migration already forces the full
inventory (architect R1). Cutover only after explicit re-confirmation, then a schema freeze.

**Phase 3 — Post-cutover quality investment**
Generalize the DB lease to `useEngineLease` and retire the two remaining unfixed instances — this is
one of the two most severe *new* findings this round: `useAutomationWatchdog.ts` (gates the core
`auto_admit_ghost_patient` engine) and `useCodingPipelineSweep.ts` still carry the exact race just
fixed elsewhere, and `localStorage` leader-election was never product-wide across three origins
anyway. CRLF cleanup → lint gate last; CODEOWNERS + PR template + Conventional Commits (reviewer
#2–#4). fhir-proxy/umls-proxy Deno contract tests (tester #3). Accessibility sweep in the documented
order: system-admin → nursing-board → pharmacy-queue → admin-dashboard (ux-designer #1), plus a
shared async-state component (ux-designer #2). Terminology content growth driven by
`terminology_requests` demand history, not a copy of production's 53 sets (clinical-informaticist
#1, #5), with a clinical-plausibility warning added to the quality gate (#2). Liveness/health
dashboard (analyst #1–#2) — cheap and would have caught the "12 patients, zero automation logs"
state discovered this round immediately. Auth Stage 2 (anonymous sign-in) only after the migration
settles, per security-auditor's own sequencing.

**Phase 4 — Later / explicitly deferred**
E2E tests once a stable backend and CI test gate exist (tester #5). Gemini quota watch, not a
provider switch (researcher #3). Synthea-style state-machine refactor once scenario count grows
(researcher #4). Keyboard shortcuts / CPOE speed work (ux-designer #4). Server-side simulation
scheduling, moving off the browser-tab dependency entirely (architect R4 Stage B).

## The other severe new finding

The second item flagged this round outranks most of Phase 3: `src/routes/api/public/umls-search.ts`,
`umls-validate-code.ts`, and `directory.ts` are unauthenticated Worker routes the entire Edge
Function auth-hardening plan doesn't mention. Fold a Worker-side CORS allowlist + quota into Stage 0
now (Phase 1), not later — security-auditor #4 is explicit that this is the same UMLS-key-exhaustion
risk relocated, not a separate, lower-priority issue.

## Explicitly not doing right now

No monorepo (architect R2, ADR to be written). No compliance/pentest/WAF/audit-logging investment —
synthetic data means that's the wrong threat model (security-auditor #6). No full staging
environment — Supabase branching + PR previews cover it (devops #3). No bulk import of production's
53 value sets (clinical-informaticist #5). No general-purpose FHIR validation library (researcher).
