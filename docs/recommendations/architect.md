# Architectural Recommendations — S.P.E.H.R.

Status: **recommendation only. Nothing here is implemented, applied, committed, or deployed.**
Author: architect role. Date: 2026-09-18.
Scope: forward-looking product/platform direction, not a bug list. For the tactical queue see
`docs/backlog.md`.

---

## The one-sentence read

S.P.E.H.R.'s real architecture is not three frontends — it is **one Postgres schema with four
independent clients** (spehr.live, spehrancillary.live, spehranalytics.live, MySpehr), and every
significant risk in this project comes from the fact that the schema is a shared contract that
nobody has written down, versioned, or tested. The recommendations below all reduce to: *make the
integration surface explicit, then make the migration safe, then stop coordinating distributed work
in `localStorage`.*

---

## R1 — Publish the backend as a versioned contract package (not a monorepo)

**Priority: P0. Effort: M (~2–3 days). Risk: Low (purely additive).**

### What

Extract a small, separately-versioned `@spehr/contract` package containing the three things that
actually cross domain boundaries:

1. The generated `Database` type — today `src/integrations/supabase/types.ts` (4,366 lines),
   regenerated from the live project.
2. Hand-written request/response types for each **active** Edge Function (`umls-proxy`,
   `fhir-proxy`, `nlp-extract-concepts`, the `fhir-*-poll` family) — including the documented
   failure contracts, e.g. `nlp-extract-concepts` returning HTTP 200 with
   `{concepts: [], error}` on a 429 so the caller drops to its lexical ladder. That behaviour is a
   contract three apps depend on and it exists only in prose in `CLAUDE.md` today.
3. The list of anon/authenticated-callable RPCs and their argument shapes — `auto_admit_ghost_patient`,
   `auto_admit_due_appointments`, `claim_automation_lease`, etc. These are a public API surface
   whether or not anyone has called them that.

Semver it. A column rename, a policy that revokes an existing grant, or an Edge Function response
change is a **major** bump, and the bump is the signal the other two repos need.

### The part that actually catches breaks

The types package alone is documentation. The enforcement is a **CI schema-drift job**: run
`supabase gen types` against the target project and fail the build if the output differs from the
checked-in file. That single job converts "someone applied a migration and three apps silently
diverged" into a red build with a diff that is precisely the blast radius.

### Rationale

`CLAUDE.md` states the problem exactly: *"a schema, RLS, or Edge Function change made from this repo
can break the other two domains, and nothing in this codebase will catch it."* The missing artifact
is not a build system — it is a **named, versioned integration surface**. That surface already
exists in machine-readable form; it is simply not extracted, not versioned, and not checked.

### Sequencing note

Do this **during** the Supabase migration, not after. The migration is already forcing a full
inventory of tables, functions, and secrets across two projects — that inventory *is* the contract's
first version. Deriving it twice is waste.

---

## R2 — Explicitly decide *against* a monorepo, and write down the trigger to revisit

**Priority: P0 (it's a decision, not work). Effort: 0 (an ADR). Risk: Low, if the trigger is recorded.**

### Recommendation: do not monorepo. Not now, and probably not for this product.

A monorepo buys atomic cross-package refactors, one dependency graph, and one CI. None of those
address the failure mode this product has. **The coupling between the three domains is not
code-level — it is database-level.** A monorepo would not have caught a single break of the kind
`CLAUDE.md` warns about:

| Break | Caught by a monorepo? | Caught by R1's contract + drift CI? |
|---|---|---|
| Column renamed / dropped | No (runtime, PostgREST) | Yes — types diff fails CI |
| RLS policy revokes an anon grant another app relies on | No | Partly — flagged in the policy review the contract forces |
| Edge Function response shape changes | No (HTTP boundary) | Yes — contract test |
| Supabase project cutover | No | Yes — one place lists every consumer |

Against that, the cost is real: three apps on Cloudflare Workers with independent release cadences
would have to be merged, their CI reconciled, and their deploy triggers rewired — during an
in-flight backend migration. That is a large, high-risk change that buys approximately none of the
safety it appears to buy.

### Revisit if — and only if — one of these becomes true

- The three apps begin sharing **UI** (a design system, a shared patient-header component, shared
  chart widgets). Shared *code* is the monorepo's actual use case; shared *data* is not.
- The three apps need to ship **atomically** — i.e. a feature that cannot be rolled out one domain
  at a time. Today the shared-state integration model makes every rollout naturally independent.
- Ownership consolidates such that one team is paying the multi-repo tax daily.

Until then: three repos, one contract package, one drift check. Record this as an ADR so it is a
decision with a review condition, not an omission.

---

## R3 — Re-sequence the Supabase cutover around *all four* consumers, not just this repo

**Priority: P0. Effort: S in this repo; M in coordination outside it. Risk: HIGH if skipped.**

### The gap

`CLAUDE.md`'s stated next step is: *"point a dev/preview build at the new project and confirm
admissions/discharges actually start flowing before considering any production cutover."* Singular
build. But `qxyvmvtecnnwqeqaouzh` is the backend for **four** consumers — this repo,
spehrancillary.live (Labs/Pharmacy/Radiology), spehranalytics.live (Billing/RCM, Population Health),
and MySpehr against the same FHIR server. As written, cutover is a simultaneous four-app backend
swap in which exactly one app has been rehearsed. That is the single largest unmanaged risk in the
current plan.

Two concrete divergences already make this non-theoretical:

- The new project has **15 `custom_value_sets` vs production's 53**, deliberately left as-is. Safety
  Alerts in this repo is covered; Pharmacy's drug-interaction surfaces on spehrancillary.live may
  not be.
- Simulation data is deliberately not migrated, which is correct for this repo (the sim regenerates
  it). But **Billing/RCM on spehranalytics.live is a read-mostly consumer** — it has no generator of
  its own. On cutover it renders an empty product until the sim has run long enough to produce
  claims. That may be perfectly acceptable; it should be an accepted decision, not a surprise.

### Recommended order

1. **Preview build of this repo → new project.** Confirm admissions/discharges flow. (Already planned.)
2. **Apply `supabase/migrations/20260918000000_automation_leases.sql` to the new project only, then
   ship the paired `useAutoTerminologist.ts` change.** Use this as the *rehearsal* for the
   apply-then-deploy discipline the cutover itself requires — the migration file's own header
   correctly notes the two changes are not independently shippable. Small, reversible, and it
   proves the ordering works before it matters.
3. **Point ancillary, analytics, and MySpehr at the new project in preview** and confirm each
   renders. This step does not exist in the current plan and it is the one that de-risks cutover.
4. **Then** do RLS (`docs/rls-remediation-plan.md`) and Edge Function auth hardening
   (`docs/edge-function-auth-hardening-plan.md`) **on the new project**, where there is no
   production traffic to break. Doing this security work before cutover means doing it against live
   users; doing it after means doing it twice or accepting divergence between the two projects.
5. Cutover, with the contract package (R1) as the checklist of who must be told.

### Why this order

Every remaining architectural item in the backlog is *schema or policy work applied to a specific
project*. While two projects exist, that work is either duplicated or divergent. Cutover is
therefore not one task among many — it is the **gate** that makes the rest cheap. Everything that
can wait for it, should.

Also worth resolving during step 1, cheaply: the unverified `pg_cron` registration
(`auto_admit_appointments_job`, `auto_report_radiology_job`) and the `fhir_sync_state` RLS anomaly.
Both are dismissed as minor today because the admission engine is client-side — see R4 for why that
reasoning should not survive contact with three origins.

---

## R4 — Generalize the lease into a coordination primitive, then move the schedule off the browser

**Priority: P1. Effort: Stage A = M, Stage B = L. Risk: Stage A Low, Stage B Medium.**

### Stage A — finish what the lease started (do this soon)

The `automation_leases` work fixed **one** of at least three engines. The identical
read-then-write-`localStorage` pattern still drives:

- `src/hooks/useAutomationWatchdog.ts:209` — `tryAcquireLeader()`, gating **both** the watchdog tick
  *and* `ghostTick`, which calls `auto_admit_ghost_patient`. **This is the core admission engine of
  the entire simulation**, guarded by the exact race that was just judged serious enough to fix
  elsewhere.
- `src/hooks/useCodingPipelineSweep.ts:19` — same shape, same bug.

And there is a second, larger defect the original design note only gestures at: **`localStorage` is
per-origin.** With three deployed origins reading one database, each origin elects its own leader
independently. The "only one tab drives this" guarantee was never true *across the product*, even
before the intra-origin race. The DB-backed lease fixes both problems at once, because the lease
lives where the shared state lives.

The table is already designed for this — `engine` is the primary key and the migration seeds only
`auto_terminologist`. Generalizing is **rows plus a hook, not new SQL**:

- Extract `useEngineLease(engine, { leaseMs, intervalMs })` wrapping the existing
  `claim_automation_lease` / `heartbeat_automation_lease` calls, including the negative-`_lease_ms`
  release trick already implemented.
- Seed `automation_watchdog`, `ghost_admit` (separate engines — they have different cadences:
  60s vs 600s), and `coding_pipeline_sweep`.
- Delete all three `tryAcquireLeader` copies and their `LEADER_KEY` constants.

Note the clamp ranges in the current migration (`_min_interval_ms` floored at 60000) were chosen for
a 10-minute engine. The watchdog's 60s cadence sits exactly on that floor and the ghost-admit tick
is 600s — verify the clamps before seeding, or widen the floor deliberately.

**Yes, generalize it.** It is the right primitive, it is already built, and the remaining call sites
are strictly worse off without it.

### Stage B — question whether a hospital simulation should depend on an open browser tab

`CLAUDE.md` frames "the core admission engine is client-side, not cron-dependent" as reassurance
that unverified `pg_cron` registration doesn't matter much. Architecturally, that reads the other
way round: **the simulation stops when the last tab closes**, and its throughput is a function of
who happens to be looking at it. For a product whose entire value proposition is "autonomous
hospital running continuously on synthetic data," that is a load-bearing weakness, and it is the
reason the new project has no data to migrate in the first place.

The correct home for a scheduled simulation tick is server-side: `pg_cron`, or a Cloudflare Cron
Trigger invoking an Edge Function. At that point the lease's job shrinks from "elect a leader among
unknown browsers on three origins" to "don't double-fire" — a much smaller problem — and the
unverified cron registration becomes something that must be verified rather than something that can
be shrugged off.

Stage B is genuinely L-sized and touches simulation pacing, so it should not block Stage A. But it
should be on the roadmap, and Stage A should be built so it doesn't have to be thrown away: keep
`useEngineLease` a thin wrapper over the same RPCs a server-side caller would use.

---

## R5 — Delete dead schema *before* writing policies for it — but prove it's dead first

**Priority: P1 (it shrinks P0 work). Effort: S once verified. Risk: Medium — this is the exact
cross-domain trap.**

`docs/rls-remediation-plan.md` already did the hard part: it identified **10 tables with zero
references** anywhere in `src/`, `supabase/functions/`, or migration bodies — `nurse_assignments`,
`patient_assignments`, `clinical_alerts`, `safety_alerts`, `patient_notes`, `api_health_pings`,
`clinical_keyword_mappings`, `simulation_chief_complaints`, `fhir_patients`,
`fhir_medication_requests`.

Dropping them (or moving them to an `archive` schema) *before* the RLS work removes 10 of 26 tables
from the P0 RLS surface, shrinks the generated types that R1 has to version, and eliminates the
standing ambiguity about which alert/note table is canonical.

**The catch, stated plainly:** "no references in this repo" is not "no references." These tables are
on the shared backend, and `clinical_alerts`, `safety_alerts`, and `patient_notes` are precisely the
kind of thing an Ancillary or Analytics app might still read. Dropping on this repo's evidence alone
is the exact failure mode `CLAUDE.md` warns about.

**Cheap, zero-risk evidence available today:** query `pg_stat_user_tables` on the **production**
project for `seq_scan` / `idx_scan` / `n_tup_ins` on these ten tables. Production has been serving
all three domains for the life of the project; a table with zero scans there is dead for *every*
consumer, not just this one. That is proof rather than inference, it is a read-only query, and it
costs one round trip. Grep the other two repos as a second check where possible.

Drop only what survives both checks. Anything with live scans gets a policy instead, and gets added
to the contract as a surface this repo doesn't own.

---

## R6 — Spend the testing budget on the integration seam, not on component coverage

**Priority: P1. Effort: M. Risk: Low.**

`docs/backlog.md` item 4 reads "zero-to-minimal test coverage — Effort: L." Recommend **not** taking
that as a generic coverage push. Rank this product's actual observed failure modes:

1. Schema/contract drift breaking another domain (the documented, structural risk).
2. Automation engines double-firing or silently not firing (the leader-election race; the
   quality-gate "held, nothing drafts" symptom).
3. Edge Function contract changes (the OpenAI→Gemini swap in `nlp-extract-concepts`; the
   `fhir-proxy` DELETE guard).

Component unit tests catch none of these. Three targeted investments do:

- **The schema-drift CI job from R1.** Highest value per line of code in this entire document.
- **Contract tests for the four active Edge Functions**, asserting response shape *and* the
  documented fallback behaviours. `fhir-terminology` should get one test that asserts nothing calls
  it — it is an empty shell with 0 invocations and a standing "do not call" rule, which is a rule
  a test can enforce better than a document can.
- **More tests shaped exactly like `src/hooks/useAutoTerminologist.test.ts`.** That existing file is
  the right pattern and should be the template: it asserts the RPC *names and arguments*
  (`claim_automation_lease`, `heartbeat_automation_lease`) and the error path when the function
  doesn't exist. It therefore fails when the migration and the hook disagree — which is the real
  bug class, and the one the paired-change warning in the migration header is currently defending
  against with a comment.

Sequencing note: the `lint --max-warnings 0` CI gate from `docs/lint-cleanup-plan.md` should land
*after* the CRLF renormalization, not before — 67k mechanical errors will otherwise make the gate
unadoptable and it will be disabled, which is worse than never adding it. The current CI
(`.github/workflows/ci.yml`: typecheck + build) is a reasonable floor; add the drift job to it
first, lint last.

---

## Suggested order of execution

| # | Item | Blocks | Effort | Risk |
|---|---|---|---|---|
| 1 | R2 — record the no-monorepo ADR | nothing | 0 | Low |
| 2 | R3 step 1–2 — preview build + apply `automation_leases` to new project | everything below | S | Low |
| 3 | R1 — contract package + schema-drift CI | R3 step 5 | M | Low |
| 4 | R5 — prove-then-drop dead schema (`pg_stat_user_tables` first) | shrinks RLS work | S | Med |
| 5 | R4 Stage A — generalize `useEngineLease` to watchdog + coding sweep | — | M | Low |
| 6 | R3 step 3–4 — other consumers on preview; RLS + auth on new project | cutover | M/L | Med |
| 7 | R3 step 5 — cutover (requires explicit user re-confirmation) | — | M | High |
| 8 | R6 — contract tests; lint gate last | — | M | Low |
| 9 | R4 Stage B — move the simulation schedule server-side | — | L | Med |

Items 1–5 are all doable without touching production and without the cutover decision. Item 7
remains gated on explicit user re-confirmation per `CLAUDE.md`.

---

## Explicitly not recommended

- **A monorepo** — see R2, with revisit triggers.
- **Migrating the ~400K simulation rows** — the existing decision is correct; the sim regenerates.
  The only refinement is R3's note that Analytics has no generator of its own and will start empty.
- **A generic test-coverage push** — see R6.
- **Writing RLS policies for tables that are about to be dropped** — see R5.
- **Treating client-side scheduling as a permanent design** — see R4 Stage B.
