# Auto Terminologist — autonomous VSAC discovery & retrieval

**Status:** implemented on branch `feat/auto-terminologist-vsac-retrieval`. **Nothing is committed, pushed, applied or deployed.** The migration has been tested on a real (throwaway) Postgres, not on `qxyvmvtecnnwqeqaouzh`.
**Date:** 2026-11-27 · **Scope:** `supabase/functions/auto-terminologist-cycle/`, `_shared/auto-terminologist-cycle.ts`, `_shared/value-set-registry.ts` + new shared modules.

---

## 1. What changed, in one paragraph

Until now the Auto Terminologist could *notice* a terminology gap, file a request, and even *find* a candidate in VSAC's catalog — but a human still had to click **Import** to fetch the value set. It now does what a real terminologist does at that point: it queries VSAC's authenticated FHIR API, retrieves the actual value set, checks that it genuinely covers the codes that triggered the request, and **stages it as an unpublished `draft`** with full provenance (VSAC's real OID, version, publisher, expansion timestamp, retrieval time, a content hash). The steward's only remaining job is the one that should stay human: **review the draft and publish it.** When they do, the next cycle resolves the request automatically.

> **⚠ One repo invariant was deliberately relaxed.** The cycle's header used to say it *never* creates `custom_value_sets` rows ("every creation needs a human click"). That is no longer true: it may now create **inert drafts** stamped `provenance.staged_by = 'auto-terminologist'`. It still cannot publish, and now cannot even *request* review — a database trigger enforces that (§5). If you want the old behaviour back without a code change, set `VSAC_AUTO_STAGE_MODE=preview` (or `off`).

---

## 2. How real clinical terminologists work (and what we copied)

**Evidence base, stated honestly.** I could not find public documentation of Epic's or Oracle Health's *internal* terminology workflows, and I could not re-locate the Optum posting I read earlier in the session, so neither is cited. What follows rests on public job postings, NLM/eCQI authoring guidance, and vendor/industry material. Treat it as the shape of the profession, not an audit of any one employer.

| What a terminologist does | Evidence | What Auto Terminologist now does |
|---|---|---|
| Authors and maintains **value sets** and **code-to-concept maps** across SNOMED CT, LOINC, RxNorm, ICD-10-CM, CPT; reviews each other's work | Postings describe developing/maintaining mappings and value sets, and clinical review of non-clinical analysts' work ([Core4ce](https://jobs.cste.org/job/clinical-terminologist/84679368/), [Lead Terminologist](https://www.tealhq.com/job/lead-terminologist_7ea1a5843149773fa3b19c3f6a22438e66752), [builtin.com](https://builtin.com/job/clinical-terminologist/7348672)); the SMART/WHO terminologist persona authors CodeSystem, ValueSet and ConceptMap resources ([SMART Base](https://smart.who.int/base/ActorDefinition-SGAuthoring.Persona.Terminologist.html)) | Unchanged (Authoring Workbench, Cross-Map Studio). The engine now supplies the *first draft*; the steward remains the reviewer |
| **Reuses before creating.** Authoring from scratch is expensive; start from an existing authoritative set | eCQI/VSAC author guidance centres on VSAC as the shared repository ([eCQI value set guidance](https://ecqi.healthit.gov/value-set-guidance), [VSAC best practices](https://nlm.nih.gov/vsac/support/authorguidelines/bestpractices.html)); a (non-peer-reviewed) preprint on value-set reuse argues for reusing existing sets and making new ones only when necessary ([medRxiv](https://medrxiv.org/content/10.1101/2024.02.15.24302903v2.full.pdf)) | Discovery runs **before** the demand pass: a request VSAC can satisfy never reaches UMLS-suggestion or self-authoring |
| **Responds to gaps found in data** — a code appears that no value set covers | Wolters Kluwer's account of a new ICD-10 diabetes code that analytics value sets missed ([Wolters Kluwer](https://www.wolterskluwer.com/en/expert-insights/unlocking-the-features-of-a-value-set-management-tool)) | The demand queue / proactive sweep already file these; discovery now acts on them |
| **Records why** a value set looks the way it does (traceability) | Same source lists "lack of traceability" as a core failure of informal value-set management | Provenance is captured verbatim and hashed (§4.4) |
| **Monitors terminology updates and analyses impact**; maps local codes | HIE/health-system postings: "monitor industry updates… incorporate changes", "map local codes" ([Dice HIE posting](https://www.dice.com/job-detail/ac7e3cd3-9627-4bc0-a9dd-201ef1009ed3), [HK Tech](https://remotive.com/remote/jobs/medical/clinical-terminologist-6639357)) | Already covered by staleness/dormancy sweeps. **Drift re-sync against VSAC is Phase 2** (§10) |
| Uses **VSAC** for quality-measure and eCQM value sets, via the **UTS-authenticated** services | HK Tech posting lists "VSAC value sets, eCQM and HEDIS code sets"; NLM documents the API and UMLS licence requirement | This feature |

---

## 3. The real APIs — what is verified, documented, and unverified

### 3.1 Documented by NLM
- **Endpoint:** `https://cts.nlm.nih.gov/fhir/` (FHIR R4 4.0.1). A separate UAT server exists but needs permission ([NLM VSAC FHIR docs](https://www.nlm.nih.gov/vsac/support/usingvsac/vsacfhirapi.html)). **Not used.**
- **Auth:** HTTP Basic; username `apikey` (or blank), password = your **UMLS API key** ([NLM](https://nlm.nih.gov/vsac/support/usingvsac/vsacsvsapiv2.html)). The same UTS key works for UMLS, RxNorm and VSAC ([NLM KB](https://support.nlm.nih.gov/knowledgebase/article/KA-05452/en-us)); it stays valid while the UTS account is active. The UTS REST API (used by `umls-proxy`) instead takes the key as `?apiKey=` ([UTS docs](https://documentation.uts.nlm.nih.gov/rest/authentication.html)). **This client uses the Basic header only — never a URL parameter.**
- **Operations:** `ValueSet/{oid}` (definition), `ValueSet/{oid}/$expand`, `$validate-code`; `$expand` works for intensional as well as extensional sets since Feb 2021 ([release note](https://www.nlm.nih.gov/vsac/support/releasenotes/20210219.html)).
- **Licence:** a free UMLS licence is required; NLM states approval takes roughly 3–5 business days ([UMLS FAQ](https://nlm.nih.gov/research/umls/faq_main.html)). The key belongs to the licensee's own UTS account. SNOMED CT licence terms differ outside IHTSDO member countries ([NLM](https://www.nlm.nih.gov/databases/umls.html)) — worth a glance given the project is run from Ireland.
- **Rate limit & caching** — confirmed on NLM's UTS API terms page ([terms](https://documentation.uts.nlm.nih.gov/terms-of-service.html)): **20 requests per second per IP address**; excess requests "may not be serviced" and service "will not be restored until the request rate falls beneath the limit"; NLM **recommends caching results for 12–24 hours**. There is no documented `Retry-After` or rate-limit header contract.
- **Attribution:** the page *requests* (does not mandate) the statement "This product uses publicly available data from the U.S. National Library of Medicine (NLM). NLM is not responsible for the product and does not endorse or recommend this or any other product." and says developers may not use NLM's name/logo in conjunction with their applications. We store the statement text in provenance and never use the name/logo.

### 3.2 Verified live on 2026-11-27 (public `/fhir/metadata`, read in Claude in Chrome — no key used)
Server `vsac-fhir` 2.26.19 · FHIR 4.0.1 · security: Basic · `ValueSet`: read / vread / search-type · operations: `expand`, `validate-code` · search params: `name, title, status, publisher, version, code, codesystem, keyword, identifier, reference, usage, date, url, _lastUpdated` · 112 code systems · the five code-system URIs in `VSAC_SYSTEM_TO_VOCAB` are all present and unchanged · no rate-limit headers on a normal response (so nothing relies on them).

### 3.3 NOT verified — needs an authenticated call, none was made
1. **Whether `$expand` honours `offset`/`count`.** The capability statement advertises no `expansion` block and does not host the `$expand` OperationDefinition (404). 
2. **Whether `$expand` reports `expansion.total`.** The client now *requires* it (§4.2): without a reported total nothing can be proved complete, so the candidate is refused. If VSAC omits it, discovery will correctly stage nothing until the client is adapted.
3. **Whether `name:contains` works as a search modifier.** `name` is an advertised parameter; the `:contains` modifier is standard FHIR but is not confirmed by the capability statement.

**All three fail safe** (see §6): if paging misbehaves or no total is sent the client throws `incomplete` and stages nothing; if the search modifier is rejected the pass records a `search_error` against the request, logs it once, and pauses catalog searches for the cycle (requests that carry filed VSAC candidates are unaffected). **Please run the check in §9 once with your own key** — it takes one minute and turns all three into facts.

---

## 4. Design

### 4.1 Cycle order
`runAutoTerminologistCycle` (≈ every 10 min, `auto-terminologist-cycle` edge function, DB lease) now runs:

0. **VSAC discovery** *(new)* → 1. demand queue → 2. drug-allergy auto-link → 3. VSAC publication poll → 4. proactive sweep → 5. staleness → 6. dormancy.

Discovery goes first so a request it satisfies leaves `pending` and never reaches the UMLS-suggestion/self-authoring branch. The browser-tab copy of the cycle (`useAutoTerminologist.ts`) passes no gateway, so the step reports `skipped: no-gateway` and the tab behaves exactly as before — **the browser never holds the key.**

### 4.2 VSAC client (`_shared/vsac-client.ts`)
Why not reuse `umls-proxy`'s `vsacExpand`? Built for a human clicking Import on one OID, it has four gaps that matter unattended: **(1)** a single un-paged `$expand`, so a large set can be silently truncated and still look normal; **(2)** no provenance; **(3)** no 429/5xx handling — errors look like "not found"; **(4)** no request budget or circuit breaker.

The new client: Basic auth only (key never in a URL, never in an error message) · self-throttle 150 ms (≈ 6.7 req/s, a third of NLM's limit) · per-invocation budget 40 requests · bounded retries (2) with exponential backoff and `Retry-After` honoured up to 15 s · 20 s per-request timeout (covers reading the body, so a response that stalls mid-stream is cut off and treated as transient, not left hanging) · **circuit breaker** (opens on an auth failure, a rate-limit it won't wait out, or 3 consecutive transient failures) · typed errors (`auth | not_found | rate_limited | transient | bad_request | malformed | incomplete | budget_exhausted | circuit_open | too_large`).

**Completeness proof.** `retrieve()` does a definition `GET` (type, status, version, publisher) then pages `$expand`. It returns only an expansion it can *prove* complete: distinct entries ≥ the `expansion.total` VSAC reports. **No reported total ⇒ nothing is provable ⇒ `incomplete`** — a short page is *not* accepted as proof, because a server that silently caps its page size would look exactly like a finished one. No new codes on a later page ⇒ the server is ignoring paging ⇒ `incomplete`. A 400 on the first paged request ⇒ one un-paged retry. `total > 10 000` ⇒ `too_large`. Abstract entries are excluded from `codes`; inactive ones are kept and counted.

### 4.3 Discovery pass (`_shared/vsac-discovery.ts`)
1. **Select** `terminology_requests` where `status='pending'`, `linked_vsac_oid IS NULL`, `request_type='create'`, has **gradeable seed codes** (SNOMED CT, ICD-10, LOINC, RxNorm or CPT — a seed in any other vocabulary cannot be matched in VSAC and is ignored, not counted against coverage), `vsac_discovery_attempts < 3`, the no-match cooldown (`attempts × 24 h`) has elapsed, **and it is not cooling off after a flaky VSAC response** (30 min, doubling to 6 h, stored in `vsac_discovery_result`; costs no attempt). Ordered urgent → high → normal → low, then by recurrence. **3 requests per cycle**, ≤ ~40 API calls, and a **40 s wall-clock budget** for the whole pass (stop reason `deadline`) so discovery can never starve the rest of the cycle.
2. **Candidates:** the request's own `known_vsac_candidates` if any are usable; **otherwise (including when none of them is active/attributed/well-formed) a catalog search** for the quoted clinical term in the request name (`Condition coverage for "Hypertension"` → `Hypertension`) and the first seed's display. Candidates are kept only if `active`, attributed and carrying a well-formed OID. Then two filters: an OID **a steward already deleted as the answer to this same request** (consumer + name) is never proposed again, and an OID **already in the library** is never retrieved.
3. **Grade — deterministic, no LLM, no guessing.** Retrieve up to 3 candidates (best name match first) and grade **all** of them before choosing — no first-match shortcut. Accept only if VSAC status is `active` **and** the set actually *contains* ≥ 50 % of the seed codes (same vocabulary family; ICD-10 compared ignoring the dot; **a code VSAC marks inactive does not count as coverage**) **and** (the name shares a significant token with the request **or** the set has ≤ 250 codes). **A name-only match never stages.** Among accepted candidates: highest seed coverage → best name match → smaller (more specific) set → OID.
4. **Decide, from the real outcomes.** Nothing accepted *and* any candidate or search hit a transient error ⇒ **no verdict, no attempt used**, request parked (cooldown above). Nothing accepted and every candidate was genuinely checked ⇒ `no_match` (attempts + 1) with a message built from what actually happened ("2 candidate(s) checked, 2 did not pass grading"). Otherwise **stage** the best (§4.6).
5. **Reconcile** (§4.5).

### 4.4 Provenance (`custom_value_sets.provenance`, jsonb)
Copied **verbatim** from what VSAC sent, `null` where VSAC didn't send a field — nothing defaulted or inferred:

`source, api, oid, vsac_version, vsac_status, vsac_publisher, vsac_date, vsac_last_updated, vsac_version_id, expansion_timestamp, expansion_identifier, expansion_parameters, total_reported, codes_retrieved, inactive_count, abstract_excluded, code_systems, completeness, pages, content_sha256, retrieved_at, source_url, attribution` — plus our own stamp: `staged_by: 'auto-terminologist'`, `stage_mode`, `request_id`, and `match` (`basis: seed_overlap`, matched/total/coverage, the matched codes). `content_sha256` hashes the sorted code list, so Phase 2 drift detection can compare content without re-reading it. The draft's `version` column is VSAC's version, and its `change_history` records the retrieval and "staged as DRAFT — awaiting steward review and publish". The `description` is deliberately a statement of **origin, not state** ("retrieved automatically from NLM VSAC … review it against the request before publishing"): it outlives the draft stage, so it must not keep claiming "not reviewed" on a value set a steward has since published. Review state lives in `status` and `change_history`. Codes VSAC marks inactive keep an `inactive: true` flag in the draft so a steward can see them.

### 4.5 Closing the loop (`reconcileStagedRequests`)
Runs at the start of every pass (needs no VSAC call, so it also runs with no key or `mode=off`):
- steward **published** the draft → request → `resolved`;
- draft **deleted** (a steward rejected it) → request back to `pending` for a human, `vsac_discovery_attempts` set to the cap and a note explaining why — **so a deleted draft can never be silently re-staged in a loop**. The rejected OID stays on the row (`outcome: withdrawn`, `chosen_oid`), and discovery refuses to propose it again for any request with the same consumer + name. If, while the request sat in `vsac_staged`, a **newer pending request for the same gap** was filed (the dedup index only covers `pending`), re-opening would violate the unique index (`23505`); the old request is then closed as `rejected` in favour of the newer one;
- still `draft`/`review`/other → untouched.
It writes `terminology_requests` only, never `custom_value_sets`, and counts/logs a change only if its guarded update really changed a row. If the library can't be read it does nothing (unreadable ≠ deleted).

### 4.6 Stage modes — `VSAC_AUTO_STAGE_MODE`
| value | behaviour |
|---|---|
| unset / `preview` | **the default.** write **nothing** to `custom_value_sets`; stage a provenance-stamped `vsac_expansion_preview` and set the request to `ready_to_import` — the existing "Import Now" button; the human click creates the row |
| `draft` | **explicit opt-in.** insert the inert draft; request → `vsac_staged` |
| `off` | discovery disabled |
| anything else, incl. empty | treated as `preview` (fail safe) |

If the draft insert fails for any reason, the pass falls back to `preview` rather than losing the find.

### 4.7 UI (`AutoTerminologistActivity.tsx`)
`vsac_staged` requests appear under **Ready to Import** with a cyan badge and a card showing the draft's name, status, OID, VSAC version/publisher, code count, retrieval time and how many of the triggering codes it contains, plus: *"Nothing is live yet. Open Value Set Library, review this draft, and publish it — this request then resolves automatically."* The card reads provenance from the draft row **lazily**; it is deliberately *not* added to the panel's list query, so the panel keeps working if the frontend deploys before the migration is applied.

---

## 5. The publish gate — layers of defence

| # | Layer | What it stops | Verified by |
|---|---|---|---|
| 1 | **Code:** the only `custom_value_sets` write in the discovery pass is the draft `INSERT`; request writes are guarded `.eq('status', …)` | Engine code promoting content | `expectGateIntact()` asserted after every scenario in `vsac-discovery.test.ts` |
| 2 | **Database trigger** `guard_auto_staged_value_set` (BEFORE INSERT OR UPDATE): for callers that are `service_role` **by JWT claim or by Postgres role**, blocks on an auto-stamped row: (a) inserting it as anything but `draft`, (b) moving it to `review`/`published`, (c) changing or removing its provenance, (d) changing its codes or OID once it is past `draft` (the engine's own `published → deprecation-suggested` flag and the FHIR publisher's stamps still work) | A bug or later code change in the engine, even bypassing layer 1 | **39 checks on a real Postgres** (`/tmp/pgtest/guard-test.cjs`, with real `service_role`/`anon` roles): service_role blocked by claim *and* by role alone / human, anon & SQL paths allowed / legacy and non-stamped rows unchanged / content freeze / multi-row insert atomic / malformed JWT claims fail open to "not service_role" / migration idempotent; the rollback SQL was also run and leaves nothing behind |
| 3 | **Readers filter on `published`** | A draft influencing alerts, coverage, validation, cohorts, FHIR | Audit of the app's `custom_value_sets` readers (every clinically-acting one). Two real gaps were found and fixed: `coding-pipeline.ts` (coverage now counts only published sets) and `umls-validate-code.ts` (no longer validates against draft/review rows). Remaining non-filtering readers are steward/admin tools or explicit-id actions (`fhir-publish-valueset` publishes only on a steward's click and stamps non-published rows `draft`/`experimental`) |
| 4 | **Labelling:** `provenance.staged_by`, `change_history` and the UI all say "auto-staged — awaiting steward review"; the `status` column is the authoritative review state | A steward mistaking it for reviewed content | Unit-tested |

> **Honest limit of layer 2.** spehr has **no user login** (`docs/edge-function-auth-hardening-plan.md`), so a steward in the browser reaches the database as `anon` — and so does anyone holding the public anon key. The trigger separates *"the engine"* from *"everyone else"*; it **cannot tell which person published**, and it does not stop someone with the anon key. That needs real authentication (Stage 2+ of that plan). Direct SQL (migrations, the SQL editor) carries no JWT role and is unrestricted by design.
> Also: the trigger guards rows **stamped** `auto-terminologist`; it is a backstop against engine bugs, not against code written to deliberately forge a stamp. It does **not** refuse every `service_role` insert of a non-draft row: `spehrancillary.live` and `spehranalytics.live` share this project and may legitimately write with the same credential, which nothing in this repo can rule out. Once that is confirmed, "service_role may only insert drafts" is a one-line addition to the INSERT branch.
> The **browser-tab copy** of the cycle runs as `anon`, so it is outside the guard by design. It is handed no VSAC gateway, so it can never stage a draft; the guard is not what stops it.

---

## 6. Failure modes

| Situation | What happens |
|---|---|
| `UMLS_API_KEY` unset, or `mode=off` | Discovery `skipped`; the rest of the cycle is unchanged. Reconcile still runs |
| **401/403** (bad/expired key, or licence lapsed) | Circuit opens, pass stops, **one** `vsac_error` row (throttled to 1 / 6 h). No request is penalised. Message says to check the UMLS key |
| **429** or "not serviced" | Honours `Retry-After` up to 15 s; otherwise stops the pass for this cycle. No penalty; retried next cycle |
| **5xx / network / timeout** | Backoff, 2 retries; 3 consecutive ⇒ circuit opens. **Recorded as an error, not as "no match"** — attempts are not incremented, so an NLM outage can't burn a request's retries. The request is parked (`outcome: transient_error`, 30 min doubling to 6 h) so a flaky value set cannot keep winning the queue head and starve the others |
| VSAC **refuses the catalog search itself** (e.g. unsupported `name:contains`) | That request: `search_error`, attempts + 1; one `vsac_error` log (throttled); no further searches this cycle. Requests carrying filed VSAC candidates still work |
| The 40 s pass budget is spent | Stop reason `deadline`; requests not yet started are untouched; the rest of the cycle runs |
| Paging unsupported / truncated expansion | `incomplete` ⇒ that candidate is rejected; **nothing staged** |
| No candidate passes grading | `no_match`: attempts + 1, cooldown `attempts × 24 h`, full audit in `vsac_discovery_result`; after 3 the pass stops trying and the human queue handles it |
| OID already in the library | No insert; request annotated and parked; logged `vsac_already_in_library` |
| Draft insert fails | Falls back to `preview` |
| The request is no longer `pending` when the draft is linked to it (a human acted in the same minute) | The guarded update matches 0 rows; logged as an orphan; the draft is inert. If that update instead *errors*, the request stays `pending` and the next cycle finds the OID already in the library and parks the request — no second draft |
| Migration not applied yet | Discovery cannot read its columns, logs one `vsac_error` explaining why, writes nothing |
| Two cycles overlapping | DB lease (`claim_automation_lease`) as before; the request update is additionally guarded on `status='pending'` |

---

## 7. Files

| File | Change |
|---|---|
| `supabase/functions/_shared/vsac-client.ts` | **new** — authenticated, paged, provenance-capturing, rate-limited client |
| `supabase/functions/_shared/vsac-discovery.ts` | **new** — discovery pass, grading, staging, reconcile |
| `supabase/functions/_shared/auto-terminologist-cycle.ts` | step 0 wired in; header invariant rewritten; summary/heartbeat/watchdog carry discovery + reconcile counts |
| `supabase/functions/_shared/value-set-registry.ts` | additive: `provenance`/`version` pass-through on `buildVsacImportInsert`; `cleanedSearchKeyword` exported |
| `supabase/functions/auto-terminologist-cycle/index.ts` | builds the client from `UMLS_API_KEY` per invocation; reads `VSAC_AUTO_STAGE_MODE` |
| `supabase/migrations/20261127120000_vsac_auto_retrieval_provenance.sql` | **new, not applied** — `custom_value_sets.provenance`; `terminology_requests.vsac_discovery_{at,attempts,result}`; guard trigger |
| `src/lib/coding-pipeline.ts`, `src/routes/api/public/umls-validate-code.ts` | draft-leak fixes (§5 layer 3) |
| `src/components/admin/dictionary/AutoTerminologistActivity.tsx` | `vsac_staged` badge, routing, card |
| `src/integrations/supabase/types.ts` | the new columns (12 additive lines) |
| `src/lib/vsac-client.test.ts`, `src/lib/vsac-discovery.test.ts` | **new** — 31 + 60 tests |

## 8. Testing
Full suite **261 passing**, `tsc --noEmit` clean, no new lint errors (new files clean; `AutoTerminologistActivity.tsx` held at its baseline of 16 pre-existing). The guard trigger was exercised on a real Postgres (39 checks, plus the rollback SQL). An independent reviewer (a separate agent that had not seen the work being produced) went through the whole change; its findings are summarised in §12. **Not tested, and not testable from here:** any authenticated call to VSAC, the deployed edge function, the pg_cron schedule, and the UI in a browser.

## 9. Rollout runbook (nothing below has been run)
Order matters: **migration → secret → function → frontend.**
1. Review the diff; commit on the branch and open a PR.
2. **Apply the migration** to `qxyvmvtecnnwqeqaouzh` (`supabase db push --project-ref qxyvmvtecnnwqeqaouzh`, or paste the file into the SQL editor — it is idempotent). Check: `select column_name from information_schema.columns where table_name='custom_value_sets' and column_name='provenance';`
3. **Mode:** nothing to set — unset means `preview`, the safe first-run mode (no write to `custom_value_sets`). Setting it explicitly documents the intent: `supabase secrets set VSAC_AUTO_STAGE_MODE=preview --project-ref qxyvmvtecnnwqeqaouzh`. (`UMLS_API_KEY` is already a project secret for `umls-proxy`.)
4. **Deploy the function** with whatever flags you used last time: `supabase functions deploy auto-terminologist-cycle --project-ref qxyvmvtecnnwqeqaouzh`.
5. Merge → Cloudflare builds the UI.
6. **Watch a few cycles** (every ~10 min):
   ```sql
   select action, count(*), max(run_at) from auto_terminologist_log where action like 'vsac_%' group by 1;
   select requested_name, status, vsac_discovery_attempts, vsac_discovery_result->>'outcome' as outcome
     from terminology_requests where vsac_discovery_at is not null order by vsac_discovery_at desc limit 20;
   ```
   In `preview` mode matches appear as **Ready to Import** with an "Import Now" button — judge the quality of what it finds before turning staging on.
7. When satisfied, opt in explicitly: `supabase secrets set VSAC_AUTO_STAGE_MODE=draft --project-ref qxyvmvtecnnwqeqaouzh` (redeploy the function if you want it immediately). Then:
   ```sql
   select id, name, oid, version, status, provenance->>'retrieved_at' as retrieved
     from custom_value_sets where provenance->>'staged_by'='auto-terminologist';
   ```
**Rollback:** `VSAC_AUTO_STAGE_MODE=off` stops all discovery instantly in effect. Already-staged drafts are inert; delete them in the Library if unwanted (their requests re-open, per §4.5). Full DB rollback SQL is in the migration header.

**Verify the two unverified API facts (one minute, your own key, nothing pasted into chat):**
```bash
read -rs UMLS_API_KEY        # type the key; it is not echoed or kept in shell history
curl -s -u "apikey:$UMLS_API_KEY" \
  'https://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.113.11.1090/$expand?offset=0&count=5' \
  | jq '{total: .expansion.total, offset: .expansion.offset, returned: (.expansion.contains | length)}'
curl -s -u "apikey:$UMLS_API_KEY" \
  'https://cts.nlm.nih.gov/fhir/ValueSet?name:contains=diabetes&_count=3' | jq '{total, n: (.entry|length)}'
unset UMLS_API_KEY
```
(That OID is NLM's own documented extensional example.) **Reading the first result:** `returned: 5` with `total` > 5 → paging works, as assumed. `returned` = `total` → the server ignored paging and sent everything; the client still accepts this (complete on one page). `returned: 5` and *no* `total` → **the client will refuse every expansion** (it cannot prove completeness without a total) and discovery will stage nothing until the client is adapted — tell me and I will. A 400 → the client's un-paged fallback applies. All of these are safe; the answer tells us which code path will run in production.

## 10. Known limits and Phase 2
- **Drift re-sync.** Compare `content_sha256`/`vsac_version` of VSAC-origin value sets against VSAC and *propose* an update (never auto-apply). The hash is stored precisely for this.
- **Search by code.** VSAC supports a `code` search parameter, which would find sets containing a seed code directly instead of by name. Left out because it is unverified against the live service.
- **Human import path still un-paged.** `umls-proxy`'s `vsacExpand` can silently truncate a large expansion (finding §4.2). Moving it onto the shared client is a small follow-up; I did not change it because it can't be tested live from here.
- **No unique index on `custom_value_sets.oid`.** Both writers check before inserting, but a true race could still create two rows. Adding a partial unique index is a follow-up that first needs a duplicate check on production data.
- **Identity.** Everything about "which human published" waits on the auth-hardening plan (§5).
- **Egress IP.** NLM's limit is per IP; Supabase edge functions share egress addresses, so other traffic on the same IP could count against the same 20 req/s. This is an inference, not documented; the client's headroom (≈ 6.7 req/s, 40-request budget) and "stop on 429" behaviour are the mitigation.
- **A staged draft is not wired to consumers.** `linkPendingDependencies` (which connects a `value_set_dependencies` row waiting on this exact name) lives in the browser code and runs only in the human import path, at import time. The engine does not call it, and publishing in the Library does not either; only Drug-Allergy pairs are auto-linked on publish (`runPairAutoLinkPass`). So a request can reach `resolved` while a consumer rule for the same name still has no value set linked. Same exact-name limitation as before; worth fixing in a follow-up.
- **Provenance describes the retrieval, not later edits.** If a steward edits a draft's codes before publishing, `provenance.content_sha256` still describes what VSAC returned. That is intended (it is the retrieval record); Phase 2 drift detection should compare against it knowingly. The draft's `steward` column holds VSAC's publisher, not the person who published it here.
- **A duplicate pending request for a gap that is already `vsac_staged`** is not merged into the staged one (that would add a query to a hot path used by several engines); discovery notices the OID is already in the library and parks it with a pointer to the draft.
- **Office bridge.** `office-task-bridge.cjs` could not reach Supabase from the build sandbox (network allowlist), so this work was not registered on the Office board.

## 11. Sources
- NLM, [FHIR Terminology Service for VSAC Resources](https://www.nlm.nih.gov/vsac/support/usingvsac/vsacfhirapi.html) · [VSAC API authentication](https://nlm.nih.gov/vsac/support/usingvsac/vsacsvsapiv2.html) · [Feb 2021 release note (intensional `$expand`)](https://www.nlm.nih.gov/vsac/support/releasenotes/20210219.html)
- NLM, [UTS API terms of service](https://documentation.uts.nlm.nih.gov/terms-of-service.html) · [UTS REST authentication](https://documentation.uts.nlm.nih.gov/rest/authentication.html) · [UMLS FAQ](https://nlm.nih.gov/research/umls/faq_main.html) · [UMLS licence & SNOMED CT note](https://www.nlm.nih.gov/databases/umls.html) · [KB: API key](https://support.nlm.nih.gov/knowledgebase/article/KA-05452/en-us)
- eCQI Resource Center, [Value Set Guidance](https://ecqi.healthit.gov/value-set-guidance) · VSAC, [Author best practices](https://nlm.nih.gov/vsac/support/authorguidelines/bestpractices.html)
- Role evidence (job postings, point-in-time): [Core4ce](https://jobs.cste.org/job/clinical-terminologist/84679368/) · [Lead Terminologist](https://www.tealhq.com/job/lead-terminologist_7ea1a5843149773fa3b19c3f6a22438e66752) · [HK Tech](https://remotive.com/remote/jobs/medical/clinical-terminologist-6639357) · [HIE posting](https://www.dice.com/job-detail/ac7e3cd3-9627-4bc0-a9dd-201ef1009ed3) · [builtin.com](https://builtin.com/job/clinical-terminologist/7348672) · [SMART/WHO terminologist persona](https://smart.who.int/base/ActorDefinition-SGAuthoring.Persona.Terminologist.html)
- Wolters Kluwer, [Value set management tools](https://www.wolterskluwer.com/en/expert-insights/unlocking-the-features-of-a-value-set-management-tool) · [Value-set reuse preprint (not peer reviewed)](https://medrxiv.org/content/10.1101/2024.02.15.24302903v2.full.pdf)
- Live capability statement read 2026-11-27: `https://cts.nlm.nih.gov/fhir/metadata`

## 12. Independent review
Before this was handed over, a separate reviewer agent read the whole change cold. It raised 17 findings; the ones that mattered, and what happened:

- **Completeness proof (blocker, fixed).** The client accepted a short final page as proof an expansion was complete; a server that silently caps its page size would have staged a truncated set stamped `verified`. It now requires a reported `total`, and the test that asserted the opposite was replaced.
- **Body stalls (fixed).** The request timeout ended once headers arrived; a stalled body could hang the cycle. The body is now read inside the timeout.
- **Flaky requests starved the queue / transient errors cost nothing and moved nothing (fixed).** Per-request cooldown, no attempt penalty, and "no match" wording built from the real outcomes.
- **First-match shortcut (fixed).** All ≤ 3 candidates are graded before the best is chosen.
- **No wall-clock bound (fixed).** 40 s pass budget.
- **Silent search failure, and filed-but-unusable candidates (fixed).** Search refusals are surfaced; the catalog search is the fallback when no filed candidate is usable.
- **Draft leakage into matching (fixed).** Inactive codes no longer count as coverage; the vocabulary allow-list excludes unmatchable seeds.
- **A deleted draft could be re-proposed (fixed).** The rejected OID is remembered; a re-filed gap no longer breaks the re-open (`23505`).
- **Guard gaps (fixed).** Keys on JWT claim *or* Postgres role; content freeze past `draft`; rollback now re-parks `vsac_staged` requests; the browser-tab exemption is documented.
- **Default mode (changed).** Unset now means `preview`; writing drafts is an explicit opt-in.
- **Misleading label (fixed).** "NOT REVIEWED" in the description would have outlived the draft stage; it is now a statement of origin.
- **Deliberately not done:** blocking *every* `service_role` non-draft insert (could break the other live apps on this project — §5), and merging duplicate requests into a staged one (§10).
- **Known limit, documented:** consumer dependency linking (§10).
