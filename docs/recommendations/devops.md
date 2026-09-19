# CI/CD Roadmap Recommendation

Author: DevOps review, 2026-09-18. Read-only recommendation — no CI/build config changed as
part of this doc. Reflects `docs/backlog.md`, `docs/lint-cleanup-plan.md`, and current
`.github/workflows/ci.yml` (typecheck + build only; deploy is Cloudflare Workers Build on
push to `main`, out of band from this repo's CI).

## 1. Land the CRLF cleanup, then add lint as a required CI check — Effort: S (once backlog #6 lands)

`docs/lint-cleanup-plan.md` already has the right sequence (`.gitattributes` → renormalize →
`eslint --fix` → gate). Once those three commits are in and `npm run lint` is clean (or has a
small, triaged remainder), add a `Lint` step to `ci.yml` right after `Typecheck`, same job,
`run: npm run lint`, no separate workflow needed. Do this as its own PR, not bundled with the
cleanup commits, so a lint regression is bisectable independent of the mechanical renormalization
diff. Do not gate on lint before the cleanup lands — today's ~67k CRLF errors would make the gate
meaningless noise and train people to ignore CI red. Effort is small because the workflow edit
itself is trivial; the real cost is backlog item #6 (Effort M there), which is a prerequisite.

## 2. Add a `test` step to CI now, ungated — Effort: S

Independent of lint. `vitest.config.ts` and one test file already exist but are untracked
(backlog #4). Add `npm test` (or `vitest run`) as a CI step today, non-blocking-in-spirit is fine
even though CI steps are pass/fail by nature — with one test file the bar is low enough that it
should just pass. The value isn't coverage yet, it's making "add tests" a zero-friction habit
before the suite grows, and catching the day someone's change silently breaks the one test that
exists. Do this before or independently of item 1; no dependency between them.

## 3. Do not stand up a full staging environment yet; use Supabase branching + preview deploys instead — Effort: M

A traditional staging environment (separate domain, permanently-running infra, its own Cloudflare
Worker + Supabase project) is more than this project needs right now, given `qxyvmvtecnnwqeqaouzh`
already exists as an unambiguous non-prod target and Cloudflare Workers Build already produces
preview builds per-PR. Concretely:
- Frontend: confirm/enable Cloudflare Workers Build's preview-deployment-per-PR feature, pointed
  at the migration-target Supabase project's URL/anon key via a preview-only env var override.
  This gives a real "staging" URL per PR for free, no new infra to maintain.
- Backend: use Supabase's branching feature (or, failing that, keep `qxyvmvtecnnwqeqaouzh` itself
  as the shared pre-prod target) rather than a third project — a third Supabase project adds a
  third thing to keep schema/secrets in sync across, worsening the exact two-project drift risk
  CLAUDE.md already flags as unresolved.
- Once the migration's own next step lands (point a dev build at the new project, confirm
  admissions/discharges flow — CLAUDE.md's stated next step), that becomes the de facto staging
  environment; formalize it in CI/docs rather than building a parallel one.
Revisit a dedicated always-on staging environment only if PR-preview-plus-branching proves
insufficient (e.g., once real user auth per `docs/edge-function-auth-hardening-plan.md` Stage 2
needs a stable non-prod callback URL).

## 4. Gate Edge Function deploys behind a manual-approval CI job, not full automation — Effort: M

Today deploys are manual (`supabase functions deploy <name> --project-ref <ref>`), correctly
tied to explicit human action per CLAUDE.md's "Working style." Recommend a middle ground rather
than jumping to auto-deploy-on-merge, because:
- 14 functions are shared across three separately-deployed frontends plus MySpehr
  (`docs/edge-function-auth-hardening-plan.md`), so a bad auto-deploy blast-radius extends well
  outside this repo.
- Two Supabase projects are live at once during the migration; an automated pipeline needs to
  pick the right `--project-ref` or it becomes the exact kind of cross-project mistake the
  migration section of CLAUDE.md is trying to avoid.
Concrete shape: add a separate `deploy-functions.yml` workflow, `workflow_dispatch`-triggered
(manual button in GitHub Actions UI) with a required input for `project-ref` and function name(s),
plus a GitHub Environment (`supabase-migration-target`) with a required reviewer, so deploys are
one click instead of a local CLI invocation, are logged/auditable in Actions history, and still
require a human to pick the target and press go. Do not add a `push`-triggered auto-deploy job
until (a) production is fully cut over to the single new project, and (b) function-level tests
exist to gate on (currently none). Fold in the still-undeployed `fhir-proxy` DELETE-guard fix
(backlog #1) as the first real use of this workflow once it exists.

## 5. Add a Dependabot/Renovate config for `npm` and GitHub Actions — Effort: S

No dependency-update automation currently exists. Low-risk, low-effort addition: Dependabot
(native to GitHub, no new service) for `package.json` and `.github/workflows/*` on a weekly
schedule, PRs only (not auto-merge) so CI (typecheck+build, later lint+test) has to pass before a
human merges. This is a cheap way to avoid the kind of large, un-reviewed dependency drift that
made the Lovable removal (`c5dc284`) a bigger job than it needed to be.

## 6. Track RLS remediation and leader-election fixes as CI-adjacent, not CI-blocking — Effort: informational, no new work here

Backlog items #2 (RLS disabled on 26 tables) and #3 (leader-election race, `automation_leases`
migration already drafted) are correctness/security work, not CI/CD gaps, but they interact with
this roadmap: once item 4's deploy-gate workflow exists, extend it (or a sibling workflow) to also
run `supabase db push`/migration apply for `qxyvmvtecnnwqeqaouzh` under the same manual-approval
Environment, so schema changes (the RLS fix, `20260918000000_automation_leases.sql`) get the same
auditable, human-gated path as function deploys instead of being applied ad hoc via CLI or MCP
tools. No action needed until item 4 lands; noting it here so the deploy-gate design accounts for
migrations, not just function code, from the start.

## Suggested order

1 and 2 can start immediately (2 today, 1 as soon as backlog #6's cleanup lands) — both are pure
CI-workflow edits. 5 is independent and cheap, do whenever. 3 and 4 are the real design work;
recommend 4 before 3, since the deploy-gate workflow is needed regardless of whether a formal
staging environment ever gets built, and it directly unblocks deploying the already-fixed
`fhir-proxy` vulnerability (backlog P0 #1) through an auditable path instead of another ad hoc
CLI run.
