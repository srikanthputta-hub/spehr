# Security Roadmap Recommendations

Author: security audit pass, 2026-09-18. Read-only recommendation — no code changed, nothing deployed.

## Calibration first (read this before the recommendations)

The honest threat model for S.P.E.H.R. is **not** a PHI breach. All patient data is synthetic by
design and by statement, HIPAA does not attach, and a hostile party who dumps every row of
`patients` gets a pile of invented people. Security spend proportional to a real hospital EHR would
be theater here.

What is genuinely at risk, in descending order:

1. **Third-party credentials the backend holds.** `UMLS_API_KEY` (an NLM-licensed key — abuse gets
   the *account* suspended, which kills the Medical Dictionary's seven working sections),
   `FHIR_BEARER_TOKEN` (write access to the Medblocks HAPI server), `GEMINI_API_KEY` (free-tier
   quota, trivially exhaustible). The app is currently an **open, unauthenticated, unmetered relay**
   in front of all three. This is the real vulnerability class, and it is the one both the
   fhir-proxy DELETE vuln and the UMLS key log leak already fell into.
2. **Integrity and availability of the simulation itself.** This is a portfolio/demonstration
   product on a public domain. Someone wiping or defacing the dataset is a demo outage and a
   credibility hit, not a breach — but it is the failure mode most likely to actually happen, and
   the one arbitrary-DELETE would have caused.
3. **Cloud cost / quota abuse** on Supabase and Cloudflare.
4. **Future-proofing.** If this ever ingests non-synthetic data, or a partner integrates against it,
   retrofitting an auth boundary into a system with 26 RLS-disabled tables and 12 anon-callable
   SECURITY DEFINER functions is a rewrite. Building the *boundary* now with deliberately permissive
   policies inside it is cheap; building it later is not.

So: invest at the level of "protect the keys and the write paths," not "prepare for an audit." The
recommendations below are ordered on that basis, and #6 is an explicit list of what *not* to build.

A worked example of the calibration, from this pass: `.env` appears in git history (`f610a86`,
`6699d77`) and was only removed in the pending working-tree change, on a repo with a public GitHub
origin. That reads like a P0 secret leak. It is not — the file contained only
`SUPABASE_URL`, `SUPABASE_PROJECT_ID`, and `SUPABASE_PUBLISHABLE_KEY` (plus their `VITE_` twins),
every one of which ships in the browser bundle anyway and is public by design. No `service_role`
key, no `UMLS_API_KEY`, no FHIR token. No history rewrite is warranted. Recommendation #5 keeps the
cheap automated check that would tell us next time; it does not escalate this one.

---

## Recommendations (prioritized)

### 1. Deploy the fhir-proxy fix and close its Bundle bypass in the same push — before any new security work starts

The arbitrary-DELETE fix exists in code (`supabase/functions/fhir-proxy/index.ts:84`) and has not
been deployed (backlog P0 #1). **An undeployed fix is not a fix**, and the gap between "we believe
this is handled" and "this is handled" is itself the most dangerous state on this list — it
suppresses urgency on the one issue that is actually live.

It is also currently *incomplete*. Per the auth-hardening plan's "Also fix" section, fhir-proxy
Shape 1 forwards any Bundle unvalidated, so a `transaction` Bundle carrying
`request.method: "DELETE"` entries routes straight around the new passthrough allowlist. Deploying
as-is ships a fix that a five-line payload defeats. Validate Bundle `type` and per-entry methods
against the same allowlist, then deploy once, to both projects (production `fjncfbqwyrenoavhkvdr`
and migration target `qxyvmvtecnnwqeqaouzh`), and verify with an actual rejected-DELETE request
rather than a successful deploy message.

Effort: S. This is the only item here with a genuinely live exploit path, and it costs an afternoon.

### 2. Make RLS a precondition of the Supabase cutover, not a follow-up to it

This is the single highest-leverage sequencing decision available, and the window for it is open
right now and will close permanently at cutover.

Applying RLS to 26 tables on **production** means 26 opportunities to silently break a running
simulation in front of visitors, with rollback pressure and no safe place to iterate. Applying the
same 26 policies to `qxyvmvtecnnwqeqaouzh` — which by deliberate design has **no production traffic
and no migrated data** — means a broken policy surfaces as "admissions stopped flowing in the dev
build," which is *exactly the verification step already planned as the next migration milestone*
(CLAUDE.md: "point a dev/preview build at the new project and confirm admissions/discharges actually
start flowing"). The RLS rollout and the migration's own smoke test are the same test. Run them as
one.

The alternative — cut over first, harden later — produces two projects with divergent security
postures, a live system where every policy change is a production change, and a P0 that realistically
never gets done. Concretely: **add "RLS enabled on all 26 tables, admissions/discharges verified
flowing" to the cutover checklist as a blocker.**

Two dependencies to resolve before writing the SQL, both already flagged in
`docs/rls-remediation-plan.md`:

- **Get the SECURITY DEFINER sign-off explicitly.** The 12 anon-callable RPCs
  (`auto_admit_ghost_patient` et al.) are the documented ghost-tick architecture, not an accident.
  My recommendation is **option (a): accept and document it** — "anyone with the anon key can
  trigger a synthetic admission" is a correctly-priced risk for a simulation, and option (b)
  (routing admissions through an edge function) is real architectural work bought against a
  near-zero-impact threat. But write the acceptance down, with a date and a reason, so it reads as a
  decision rather than an oversight to the next reviewer.
- **Drop the 10 genuinely dead tables rather than writing policies for them.** `nurse_assignments`,
  `patient_assignments`, `clinical_alerts`, `safety_alerts`, `patient_notes`, `api_health_pings`,
  `clinical_keyword_mappings`, `simulation_chief_complaints`, `fhir_patients`,
  `fhir_medication_requests` have zero query paths. Deleting them removes 10 tables of attack
  surface and ~10 policies of permanent maintenance for less effort than securing them. Do this on
  the migration target only — it is the clean-slate project, and this is exactly the kind of debt a
  migration exists to leave behind.

Effort: L, but materially smaller than the same work done post-cutover.

### 3. Sequence the auth-hardening stages around the migration, not through it — Stages 0 and 1 now, Stage 2 deferred, Stage 3 pulled forward if Stage 2 slips

The staged plan is well-designed; the risk is running the expensive stage at the wrong moment.

- **Stages 0 (`_shared/cors.ts`) and 1 (`_shared/auth.ts` in log-only mode): do now, on the
  migration target, alongside the RLS work.** Both are zero-regression by construction — an origin
  allowlist that only omits a header, and a classifier that only logs. They land in the same
  deploy-and-verify window as #2, and Stage 1's telemetry is a *prerequisite* for Stage 2 being
  safe: right now nobody knows what `spehrancillary.live`, `spehranalytics.live`, and MySpehr
  actually send. Collecting that data has to start well before it is needed.
- **Stage 2 (anonymous sign-in, then enforce): defer until after the migration has settled.** This
  is the only stage that can break applications outside this repo, and it requires two
  separately-deployed frontends plus MySpehr to adopt `signInAnonymously()` first. Attempting a
  cross-app auth contract change and a Supabase project cutover in the same window means that when
  something breaks, you will not know which change broke it. Do them in series. The plan's
  per-function `REQUIRE_SESSION=1` env gate is the right rollback design — keep it.
- **Stage 3 (per-`sub` rate limits) is the control that actually protects the UMLS key**, and it is
  currently gated behind Stage 2 for a stable `sub`. If Stage 2 slips — and cross-team coordination
  always slips — **do not let the key stay unprotected in the meantime.** Ship an interim quota
  keyed on IP + origin. It is weaker than per-`sub` and worth having anyway, because the realistic
  threat here is a scraper or a runaway script, not an adversary rotating IPs.

Keep the plan's own honest framing intact: CORS is defense against a hostile *web page*, does
nothing against `curl`, and must not be recorded as the fix for the open-relay gap.

### 4. Extend Stages 0 and 3 to the Worker-hosted `/api/public/*` routes — the auth plan's scope has a hole in it

The hardening plan reasons about "all 14 functions," but the Supabase Edge Functions are not the
only unauthenticated backend surface. The TanStack server routes deployed on the Cloudflare Worker
are a parallel, unmentioned set:

- `src/routes/api/public/umls-search.ts` — hardcodes `"Access-Control-Allow-Origin": "*"`
  (lines 27-32), takes an unauthenticated POST, and forwards to
  `uts-ws.nlm.nih.gov` with the server-side `UMLS_API_KEY`. Its own docstring states the intent:
  *"Lives under /api/public/ so external automation can call it without an authenticated session."*
  No rate limit, no origin check, no caller identity.
- `src/routes/api/public/umls-validate-code.ts` — same shape.
- `src/routes/api/public/directory.ts` — reads `staff_roster` via `supabaseAdmin`
  (**service_role**), unauthenticated.

If Stage 0 and Stage 3 only cover `supabase/functions/**`, the UMLS key-exhaustion risk does not get
mitigated — it just relocates to the Worker, where the tooling and the plan are not looking. The
`_shared/cors.ts` allowlist and whatever quota mechanism Stage 3 lands need a Worker-side twin, and
`directory.ts` should be re-checked for whether service_role is required at all (a narrow anon
SELECT on display columns would be the lower-privilege equivalent, though note the RLS plan
correctly moves `staff_roster` to service_role-only access — reconcile these two before acting).

Effort: S-M, and it should be folded into Stage 0 rather than tracked as a separate item, or it will
be forgotten.

### 5. Adopt diff-triggered security review plus an automated advisor check — explicitly *not* a monthly calendar audit

Direct answer to the cadence question: **yes to recurring review, no to monthly, no to
every-deploy-blanket.**

A monthly deep audit on a single-contributor project is a commitment that gets honored twice and
then quietly lapses — and a lapsed cadence is worse than none, because the lapse is invisible.
Gating *every* production deploy on security review is the opposite failure: most deploys here are
frontend and touch nothing security-relevant, so a blanket gate trains everyone to rubber-stamp it,
and the stamp is worthless by the time it matters. Both patterns are how security process dies.

What survives, in three tiers:

- **Automated, continuous, zero-discipline (do this first).** Supabase's `get_advisors` is already
  how the RLS audit got its ground truth. Run it on a schedule (weekly cron, or a CI job) against
  both projects and fail/alert on new findings. This catches the single most likely future
  regression — a new table created without RLS — for free and forever, with no human in the loop. Add
  a secret-scanner (`gitleaks` or `trufflehog`) as a pre-commit or CI step for the same reason:
  the `.env`-in-history finding above was benign, but the check that confirms that in five seconds
  is worth having permanently.
- **Diff-triggered, per-PR.** A security look is required only when the diff touches
  `supabase/functions/**`, `supabase/migrations/**`, `src/routes/api/**`, or
  `src/integrations/supabase/**`. This dovetails exactly with the CODEOWNERS and PR-template
  recommendations in `docs/recommendations/reviewer.md` — same paths, same mechanism, no second
  process to maintain. Because it is scoped to diffs that genuinely warrant it, it stays meaningful.
- **Quarterly, deep, human.** One re-audit per quarter, plus a mandatory one **immediately before
  the production cutover** and one after the Stage 2 auth enforcement flip. Tie the cadence to
  architectural events rather than to the calendar — those are the moments when the threat model
  actually changed, which is the only time a full re-audit tells you something you did not already
  know.

### 6. Write a one-page threat model, and use it to say no — an explicit non-goals list

The main risk to this project's security posture from here is not under-investment; given the
momentum of an audit round, it is **over-investment in the wrong controls**, which burns the time
that recommendations #1-#3 actually need.

Write down, in `docs/`, roughly the calibration section at the top of this file: what the assets
are (three third-party credentials, demo integrity, cloud quota), what they explicitly are not
(PHI — synthetic by design, no HIPAA/HITECH obligation, no BAA, no breach-notification duty), and
then an explicit **non-goals list**. My recommended non-goals for the current phase:

- **No real user authentication, roles, MFA, or session management** beyond the anonymous-session
  JWT that Stage 2 needs for rate-limit identity. Role selection on the boards is a UI affordance of
  the simulation, not an access control, and should stay that way. Do not let Stage 2 grow into a
  login wall — the plan is right that it should be a no-UX-change bootstrap call.
- **No HIPAA / SOC 2 / HITRUST posture work**, no compliance documentation, no BAA pursuit. None of
  it applies without real PHI, and all of it is expensive.
- **No penetration test, no bug bounty, no WAF.** Disproportionate to synthetic data on a demo
  domain.
- **No tamper-evident or immutable audit logging.** `nlp_audit_logs` and
  `automation_watchdog_logs` are simulation telemetry, not a legal record.
- **No secrets-rotation automation or vaulting** beyond Supabase's built-in secret storage. A
  written runbook for "the UMLS key leaked, here is how to rotate it" is the correct-sized control.
- **No encryption work beyond platform defaults.** Supabase and Cloudflare already provide it.

The one place to deliberately over-invest relative to the synthetic-data framing is **the boundary,
not the policy** — enable RLS on every table and route every credential through a metered proxy,
while keeping the policies inside that boundary permissive. That posture costs little now, and it is
the difference between a config change and a rewrite on the day this system touches data that is not
synthetic.

Finally, treat the synthetic-data claim itself as a security control with an owner. It is the load-
bearing assumption under every "no" on this list. If a real dataset, a real patient record, or a
partner's live FHIR data ever enters the system, **this entire document is void** and the
recommendations re-price immediately. State that dependency explicitly in the threat model so the
re-pricing is triggered by policy rather than noticed by accident.
