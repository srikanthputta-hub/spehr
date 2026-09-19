# Review / Quality-Gate Process Recommendations

Author: code review pass, 2026-09-18. Read-only recommendation — no code changed.

## Context

- No PR review process exists today; commits land straight to `main` (single-contributor history).
- CI (`.github/workflows/ci.yml`) currently only runs `tsc --noEmit` and `npm run build` — no lint step, no tests. Lint is blocked by the known ~67k CRLF errors (`docs/lint-cleanup-plan.md`).
- Commit hygiene: of the last 30 commits, roughly half are bare `"Changes"` / `"Work in progress"` with no scope or rationale. The three most recent (`c5dc284`, `e07be76`) are meaningfully descriptive — a real, recent improvement worth locking in rather than letting slip.
- The project already has precedent for security regressions shipping silently (`fhir-proxy` arbitrary-DELETE fix sat undeployed — backlog P0 #1) and for two Supabase projects being live at once — both are exactly the class of mistake a lightweight gate catches before merge, not after.

## Recommendations (prioritized)

1. **Land the CRLF/lint cleanup first, then make lint a required CI check.** This unblocks everything else quality-related and should be sequenced ahead of process changes that assume a working lint gate. Follow the existing plan (`docs/lint-cleanup-plan.md`: `.gitattributes` → renormalize → `eslint --fix` → enable in CI) as its own isolated commits, not bundled with feature work. Until this lands, treat the CI gate as typecheck+build only — don't fake a green lint check by disabling rules wholesale.

2. **Require CODEOWNERS review for security- and data-sensitive paths before any further multi-person work.** Even as a solo-maintainer project, a `CODEOWNERS` file plus branch protection ("require review from code owners") turns "did I remember to double check this" into an enforced gate. Highest-priority paths: `supabase/functions/**` (fhir-proxy, umls-proxy — the fhir-proxy DELETE vuln is the concrete cautionary example), `supabase/migrations/**` (especially anything touching RLS), `src/integrations/supabase/*` (auth-middleware, client config — production vs. migration-target project selection lives here), and `.github/workflows/**`. This scales naturally if/when a second contributor joins, and costs nothing now beyond self-discipline.

3. **Adopt Conventional Commits (`type(scope): summary`) and enforce it with a commit-msg hook (commitlint + husky, or a lightweight custom hook) rather than a style guideline alone.** Given the "Changes" pattern reappeared even after periods of better hygiene, a norm without tooling will regress again the first time work happens under time pressure. Suggested types: `feat`, `fix`, `security`, `chore`, `docs`, `migration`. `security` as its own type makes fixes like the fhir-proxy patch searchable in `git log` months later — currently they're indistinguishable from routine changes.

4. **Add a PR template with a required pre-merge checklist**, even for solo-authored PRs against `main` (self-review via PR, not direct push, is the actual behavior change here). Minimum checklist items: which Supabase project this targets (production `fjncfbqwyrenoavhkvdr` vs. migration target `qxyvmvtecnnwqeqaouzh`) if the change touches backend/DB code; whether an Edge Function change needs `supabase functions deploy` and to which project; confirmation the change doesn't call `fhir-terminology`; whether RLS/security-definer surface area changed. This directly targets the project's recurring failure mode of fixes existing in code but not being deployed, or being applied to the wrong project.

5. **Expand the required CI check set incrementally, in this order, each added only once genuinely green (no skip/allow-failure escape hatches):** typecheck+build (already have) → lint (blocked on #1) → the existing/new Vitest suite (currently one test file — don't gate on it having broad coverage, gate on "tests that exist must pass," then grow coverage separately per backlog item #4) → a Supabase migration dry-run/lint step once migrations become routine. Resist adding all of these simultaneously; a gate nobody can pass gets bypassed or disabled, which is worse than not having it.

6. **Treat `docs/backlog.md`'s P0/P1 items as merge-blocking precedent, not just a task list** — i.e., don't let a new PR introduce a new instance of an already-identified anti-pattern (undeployed security fix, RLS left disabled on a new table, un-atomic leader election elsewhere). A one-line PR template question ("does this change introduce anything on the backlog's P0/P1 pattern list?") is cheaper than re-discovering the same bug class twice.
