# Researcher Recommendations — Tech & Approach Bets Worth Evaluating

Author: researcher subagent, 2026-09-18. Scope: forward-looking spikes for FHIR validation,
the Gemini NLP choice, and patterns borrowed from other open-source EHR/health-sim projects.
Grounded in what's actually in `src/lib/fhir-bundle.ts` and
`supabase/functions/nlp-extract-concepts/index.ts` today — not a wishlist. Read-only research;
no code changed.

## 1. FHIR validation: add a $validate check against a public HAPI/Medblocks server, not a client library
`fhir-bundle.ts` (2000+ lines) is entirely hand-built object literals — no schema library, no
cardinality/type checking, correctness enforced only by hard-won comments (`HAPI-0521`,
`HAPI-0534`, `HAPI-0931` — real rejection codes the team has already debugged the hard way). The
obvious instinct is "add a FHIR validation library," but the mainstream JS options are a poor fit
for a Cloudflare Worker + Deno Edge Function stack: `fhir.js`/`fhir-kit-client` are HTTP clients,
not validators; the real HL7 FHIR Validator is a JVM tool (not deployable to Workers/Deno at
request time); `fhirpath.js` validates FHIRPath expressions, not resource shape. The practical
move is to **use the FHIR server's own `$validate` operation** (Medblocks HAPI already implements
it) as a pre-flight check in a *dev/CI script*, not inline in the hot path: take a handful of
representative bundles (`buildEncounterBundle`, `buildPatientBundle`, the radiology
ServiceRequest), POST them to `{FHIR_SERVER_URL}/Bundle/$validate`, and assert on
`OperationOutcome.issue[].severity`. This catches the next `HAPI-05xx` class of bug before it
reaches spehr.live, without adding a runtime dependency or latency to every push.
**Rationale:** the existing defensive coding (`safeMap`, dedup-by-stable-id, `isPlausibleLab`) is
good discipline but reactive — it was all written *after* a HAPI rejection was seen in the wild.
$validate turns that into a pre-merge check.
**Effort to spike:** S (a few hours — one script, run against Medblocks, wire into CI as a
non-blocking check first).

## 2. Formalize the CodeableConcept builder pattern with a typed schema, skip full FHIR validation libraries
Short of full $validate, the cheapest real improvement is a zod (already a dependency) schema for
just the `CodeableConcept`/`Coding` shape and the handful of resource shapes actually emitted
(`Condition`, `Observation`, `MedicationRequest`, `ServiceRequest`, `Bundle` entry/request). This
is narrower than "add a FHIR validation library" — it validates *your* emitted shape, not full FHIR
R4 conformance, which is proportionate to a synthetic-data simulation rather than a production EHR
vendor. Apply it at the exit point of `buildEncounterBundle`/`buildPatientBundle` (already the
single choke point every bundle passes through) rather than scattering checks across every
builder function.
**Rationale:** catches the "someone changed a builder and forgot `subject.reference`" class of bug
cheaply; avoids the cost/complexity of a general-purpose FHIR validator that mostly checks things
this codebase doesn't use (extensions, profiles, terminology bindings beyond what UMLS already
guarantees).
**Effort to spike:** S–M.

## 3. Gemini `gemini-3.5-flash-lite` free tier: instrument now, plan the fallback before it's needed
The Gemini swap (2026-09-18) already has a sound *failure* contract (429/error → `{concepts: [],
error}`, 200, caller drops to lexical ladder) — that part doesn't need rework. What's missing is
**visibility into how close to the free-tier ceiling the simulation actually runs**, because
S.P.E.H.R.'s load is not typical chatbot traffic: it's cron/watchdog-driven, bursty by design
(ghost-admission ticks, `auto_code_patient_complaint`), and will scale directly with however many
synthetic patients per hour the simulation is tuned to generate. Concretely: add a log line (or a
row in `auto_terminologist_log`-style table) each time `nlp-extract-concepts` gets a 429, and check
weekly. If/when it starts firing regularly, the fallback is *not* "buy OpenAI back" — it's worth
spiking `gemini-3.5-flash` (paid tier, same API surface, same `responseSchema` support, zero
integration cost since the request/response shape is already correct) before considering a
provider switch, since a provider switch would touch prompt tuning, JSON-mode reliability, and the
whole `Stream A` lexical-ladder fallback interplay again.
**Rationale:** this is a "watch a number" recommendation, not a "rewrite now" one — the current
code is fine; the risk is silent degradation to lexical-ladder-only extraction that nobody notices
because the contract fails open by design.
**Effort to spike:** S (add one log point + a weekly manual check; no code path changes needed
until/unless the ceiling is actually hit).

## 4. Borrow Synthea's "module state-machine" pattern for the simulation's clinical progression, not its codebase
Synthea (MITRE, open-source, Java) is the closest prior art to what S.P.E.H.R. is doing —
generating synthetic patients with clinically plausible trajectories and emitting FHIR. Not worth
adopting directly (Java, batch-oriented, no live admission/discharge loop, wrong runtime for a
Cloudflare Worker + Supabase stack), but its core design idea — **each condition/care pathway is
an explicit state machine (encounter → observations → conditions → careplan → end), authored as
data, not scattered across service code** — is directly applicable to
`useAutomationWatchdog.ts`/`auto_admit_ghost_patient`/`auto_discharge_ghost_patients`, which today
implicitly encode "what happens during an admission" across several DB functions and one client
hook. As the simulation grows more clinical scenarios (beyond generic admit → labs → meds →
discharge), consider extracting the per-scenario progression into a declarative table
(`clinical_scenario_steps` or similar) the watchdog reads, rather than adding more branching to the
existing functions. This is a "when it grows" recommendation, not urgent now — the current 2-3
scenario shape doesn't yet justify the abstraction cost.
**Rationale:** avoids the automation logic calcifying into an unmaintainable branch tree as more
disease/scenario variety gets added; Synthea hit exactly this problem at smaller scale and its
module-graph format is the proven answer.
**Effort to spike:** M — worth a design doc before any code, not a code spike yet.

## 5. For the FHIR interoperability layer generally, prioritize a contract test over a validation library
Given #1 and #2 already cover shape/schema, the highest-leverage next step for the
Medblocks/MySpehr FHIR boundary is a small **contract test suite**: fixed sample bundles checked
into the repo, replayed against a real (or `hapi-fhir-jpaserver-starter` Docker) FHIR server in CI,
asserting no `OperationOutcome` errors and that round-tripped resources preserve the stable IDs
`fhir-bundle.ts` depends on for idempotent PUT-upsert. This is more valuable than picking a fancier
validation library because the actual historical bugs here (`HAPI-0521`, `HAPI-0534`, `HAPI-0931`)
were all interaction/constraint issues a generic validator wouldn't necessarily catch either — they
came from testing against the real server. Formalizing that ad hoc debugging into a repeatable CI
step is the pragmatic win.
**Rationale:** matches the project's own working style (surgical, evidence-driven fixes) rather
than introducing a heavyweight dependency on spec-perfect validation the simulation doesn't need.
**Effort to spike:** M (needs a disposable HAPI JPA server in CI, e.g. via `docker-compose` in
GitHub Actions — check whether `.github/workflows/` already has runner capacity for this before
committing to it).

## Explicitly not recommended right now
- A general-purpose FHIR validation library/SDK (no good JS/TS/Deno-native option exists that
  fits Workers/Edge Functions without a JVM sidecar) — items #1/#2/#5 get the same benefit cheaper.
- Switching off Gemini preemptively — the current fallback contract is sound and the free tier
  hasn't shown signs of strain; #3 is a watch-and-decide-later item, not a migration.
- Adopting Synthea (or another simulator) wholesale — wrong runtime, wrong deployment model; only
  its state-machine *pattern* (#4) is worth carrying over, and only once scenario count justifies it.
