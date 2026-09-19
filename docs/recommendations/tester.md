# Testing Strategy Recommendation

Author: tester (read-only recommendation, no tests written)
Date: 2026-09-18

## Where we are

Vitest was just introduced. One file exists — `src/hooks/useAutoTerminologist.test.ts`
(18 tests) — and it only covers pure, side-effect-free helpers exported from that hook
(`codeShapeMatches`, `claimLease`, `heartbeatLease`, `releaseLeaseBestEffort`), with
`supabase.rpc` mocked. `vitest.config.ts` runs in `environment: "node"` — no jsdom/DOM
globals, so no component or `renderHook` test can run yet without a config change.
Everything else in the repo is untested: 13 remaining Edge Functions (Deno runtime, not
Node/Vitest), the rest of `useAutoTerminologist.ts`'s actual cycle logic
(`processPendingTerminologyRequests`, `tryUmlsSuggestion`, `runQualityGate`,
`safeUpsertValueSet`, `runPairAutoLinkPass`), 13 other hooks (automation watchdog, FHIR
sync, safety alerts, CDS suggestions, coding pipeline sweep), and all UI components
(physician board, Medical Dictionary's 7 sections). There is no CI test gate today (only
lint is mentioned in the backlog as CI-blocked).

## Recommendations, in order

**1. Lock in the quality-gate and code-shape logic as regression tests before touching
`useAutoTerminologist.ts` further. (Effort: S, ~2-3 hrs)**
This is the highest-risk, most-changed file in the project (leader-election rewrite is
mid-flight per `docs/leader-election-fix-design.md`, backlog item #3). The existing 18
tests cover shape validation and lease RPCs but not `runQualityGate()`'s actual pass/fail
branches (missing code/display/vocabulary, duplicate codes, unsupported vocabulary) or
`tryUmlsSuggestion()`'s ≥3-match staging threshold. These are pure-ish decision functions
with mockable I/O — cheapest tests in the codebase to add and the ones most likely to
catch a real regression (e.g., a request silently passing the gate it should fail).
Do this first, before other work touches the file, since it's the one file currently
under active revision.

**2. Add a jsdom test environment alongside the existing node one, then unit-test 2-3
of the highest-blast-radius hooks. (Effort: M, ~1 day setup + 1-2 days for first hooks)**
`useAutomationWatchdog.ts` is the actual admission engine (ghost-tick calling
`auto_admit_ghost_patient` directly per CLAUDE.md) — if this silently breaks, the whole
simulation stops generating patients with no visible error. `useBackgroundFhirSync.ts` and
`useSafetyAlertsWatcher.ts` are similarly load-bearing and currently invisible if they
fail. Vitest supports multiple named projects/workspaces so the existing node-based
Supabase-mock tests don't need to move — add a second project config with
`environment: "jsdom"` (needs the `jsdom` devDependency) and `@testing-library/react`'s
`renderHook` for these three. Keep mocking `supabase` at the client boundary the way the
existing test file already does — do not hit real Supabase from unit tests.

**3. Give Edge Functions their own Deno test setup — do not try to force them into
Vitest. (Effort: M, ~1 day setup + ongoing per-function tests)**
The 13 remaining functions run on Deno (`supabase/functions/*/index.ts`), a different
runtime with different module resolution (`https://` imports, `Deno.serve`) than the
Node/Vitest setup covering the frontend. Trying to run them under Vitest means shimming
Deno globals and fighting import maps for no real benefit. Use `deno test` directly
(Deno's built-in test runner, zero extra install) with a `supabase/functions/deno.json`
task, and prioritize by risk: `fhir-proxy` first (has the P0 DELETE-scoping fix from the
backlog — a regression test here directly protects a security fix), then `umls-proxy`
(the only active terminology path — a break here silently degrades every consumer per
CLAUDE.md's "ALL terminology ops route here"), then `fhir-inbound-poll`/`fhir-outbound-poll`.
Mock outbound `fetch` (UMLS, FHIR server) rather than hitting real endpoints. Keep this
test command separate from `npm test` (e.g. `npm run test:edge`) since it needs the Deno
binary, not Node.

**4. One smoke-level integration test for the terminology request lifecycle, not a
full integration suite yet. (Effort: M, ~1-2 days)**
The highest-value integration point is the multi-step flow: a hook inserts a
`terminology_requests` row → `processPendingTerminologyRequests()` picks it up → gate
passes/fails → `custom_value_sets` and `auto_terminologist_log` get written correctly.
This crosses hook + "business logic" boundaries and is exactly the kind of thing unit
tests miss (each piece can pass in isolation while the wiring between them is wrong).
Use a real (local/test) Supabase instance or `supabase start` locally rather than mocking
every table — mocking this many round trips produces a test that mostly re-describes the
mocks. Do not attempt broader integration coverage (e.g., full admission-to-discharge
cycle) until this one is stable; it will surface whether local Postgres/RPC testing is
even practical in this environment given the noted IPv6/direct-Postgres access issue.

**5. Defer end-to-end (browser) tests until after the Supabase project migration
settles. (Effort: L if/when started — not now)**
E2E (Playwright/Cypress against a real running app) is the right tool eventually for
verifying the physician board and Medical Dictionary's 7 sections end-to-end, but two
things make now the wrong time: (a) the project is mid-migration between two Supabase
backends (`fjncfbqwyrenoavhkvdr` → `qxyvmvtecnnwqeqaouzh`) per CLAUDE.md, so an E2E suite
would need to be pointed at a moving target and likely rewritten post-cutover anyway; (b)
there's no CI test gate wired up yet (backlog notes lint-in-CI is itself blocked on the
CRLF cleanup). Stand up unit + the edge-function + one integration test first, wire *those*
into CI, and only add E2E once there's a stable backend to point it at and a CI pipeline
that can afford the runtime cost.

**6. Coverage target: aim for meaningful-path coverage, not a blanket percentage.
(Effort: ongoing policy, not a one-time task)**
For a project this size (single-maintainer, health-tech simulation, ~14 Edge Functions +
~14 hooks + a multi-section admin UI), a global line-coverage number (e.g. "80%") will
either be meaningless (padded by trivial UI snapshot tests) or demoralizing (unreachable
given the UI surface). Instead: require every new/changed pure decision function (gates,
validators, mappers — the `codeShapeMatches` pattern) to ship with tests as a PR-review
norm; require every Edge Function that touches money-equivalent risk (security guards,
data writes) to have at least one Deno test before its next deploy; treat hooks with
side effects (DB writes, cron-like polling) as integration-tested, not unit-tested, since
mocking them thinly unit-tests the mock. Track "percent of P0/P1 backlog items with a
regression test" as the real metric rather than statement coverage.

## Summary ordering (do 1, then 2 and 3 in parallel, then 4, defer 5, apply 6 throughout)

| # | Recommendation | Effort |
|---|---|---|
| 1 | Finish unit-testing `useAutoTerminologist.ts`'s gate/suggestion logic | S |
| 2 | Add jsdom project + unit-test 2-3 critical hooks (watchdog, FHIR sync, safety alerts) | M |
| 3 | Deno test setup for Edge Functions, starting with `fhir-proxy` and `umls-proxy` | M |
| 4 | One integration smoke test for the terminology-request lifecycle | M |
| 5 | Defer E2E until post-migration and until a CI gate exists | L (later) |
| 6 | Coverage policy: per-PR test norm for decision logic, not a blanket % target | ongoing |
