\# CLAUDE.md — S.P.E.H.R. Project Briefing



Read this fully before making changes. All patient data is 100% synthetic — no real PHI.



\## What this is

S.P.E.H.R. — autonomous AI-driven virtual hospital on synthetic data (www.spehr.live and spehr.live).

Paired with MySpehr (FHIR-native patient portal, reads the same FHIR server, does not talk to S.P.E.H.R. directly).

Stack: React+TypeScript frontend (TanStack Start), hosted standalone on Cloudflare Workers — Lovable has been fully

removed from the codebase (as of 2026-09-18): no \`@lovable.dev/\*\` packages, no \`.lovable/\` directory, no Lovable

preview-auth broker, no Lovable-generated MCP routes. The app's own MCP server (\`/mcp\`, 3 tools) now runs on the

official \`@modelcontextprotocol/sdk\`. \`vite.config.ts\` is a plain standalone config (nitro's \`cloudflare-module\`

preset is what actually builds/deploys the Worker — \`@cloudflare/vite-plugin\` in package.json is unused).

Backend: Supabase (PostgreSQL, ~70 tables + Edge Functions/Deno), Medblocks HAPI FHIR R4 server, UMLS terminology

via the \`umls-proxy\` Edge Function.



\## Product topology — spehr.live + MySpehr are the active 2-domain architecture (as of 2026-09-19)

The active scope is two consumers sharing one Supabase project and one Medblocks HAPI FHIR R4 server:

\`spehr.live\`/\`www.spehr.live\` (this repo) and MySpehr (the FHIR-native patient portal, reads the same FHIR

server, does not talk to S.P.E.H.R. directly). \*\*Only spehr.live's code lives in this repository.\*\*

\- \`spehr.live\` / \`www.spehr.live\` — \*\*Clinical Workspace\*\*: admissions/discharges, orders, notes, vitals, bed

  management, Medical Dictionary, the automation engines. \*\*This repo = this domain only.\*\*

\- MySpehr — FHIR-native patient portal, reads the same FHIR server as spehr.live. Outside this repo.

\- \`spehrancillary.live\` (\*\*Ancillary\*\*: Labs, Pharmacy, Radiology) and \`spehranalytics.live\` (\*\*Analytics\*\*:

  Billing/RCM, Population Health) are \*\*still live but no longer actively maintained or designed around as of

  2026-09-19\*\* — this is a scope decision, not a deletion or takedown. Their Lovable-hosted deployments continue

  to exist and still share the same Supabase project/FHIR server; whether/when they're ever taken offline is the

  user's own call, made on their own timeline via Lovable's UI, not something to assume either way from this repo.

Because everything above shares state — the same Supabase tables/Edge Functions and the same FHIR server — never by

direct app-to-app calls, a schema, RLS, or Edge Function change made from this repo can still affect

spehrancillary.live/spehranalytics.live even though they're out of active scope, and nothing in this codebase will

catch that. Don't design new work around keeping those two working, but don't write code that assumes they're gone

either.



\## CRITICAL — Supabase project migration in progress (as of 2026-09-18)

Production (\`spehr.live\`/\`www.spehr.live\`) currently still runs on \`fjncfbqwyrenoavhkvdr\` — a Supabase project

that Lovable manages, not one you own. You are migrating to \`qxyvmvtecnnwqeqaouzh\`, a project in your own Supabase

account, so Lovable is out of the picture entirely. \*\*Do not flip production over to the new project without

explicit re-confirmation\*\* — this is a deliberate, staged migration, not yet cut over.

Status so far:

\- New project (\`qxyvmvtecnnwqeqaouzh\`): schema present (~69 tables), all 14 Edge Functions deployed, all required

  secrets set (\`UMLS\_API\_KEY\`, \`FHIR\_SERVER\_URL\`, \`FHIR\_BEARER\_TOKEN\`, \`GEMINI\_API\_KEY\`, Supabase built-ins).

  \`FHIR\_APIKEY\` intentionally left unset (optional, not needed for this FHIR token type).

\- Reference/seed data verified already correct on the new project: \`bed\_management\` (100 beds, self-consistent

  with its 12 existing test patients), \`system\_settings\` (automation\_enabled=true), \`custom\_value\_sets\` (15

  starter value sets covering the key safety-alert categories — different from production's 53, left as-is).

  \`fhir\_sync\_state\` is empty and blocked by an RLS anomaly even for \`service\_role\` — minor/non-blocking, not yet

  fixed (the poll functions fail open on missing cursor state).

\- \*\*Simulation data (patients, orders, notes, vitals, billing, logs — the ~400K rows on the old project) is\*\*

  \*\*deliberately NOT being migrated.\*\* S.P.E.H.R. is a simulation that generates its own data by admitting and

  discharging patients on a schedule — once the new project's automation is actually running, it will regenerate

  a fresh population organically, the same way the old project's data built up in the first place. Confirmed via

  PostgREST's OpenAPI schema (read-only, no side effects) that all automation DB functions exist on the new

  project: \`auto\_admit\_ghost\_patient\`, \`auto\_admit\_due\_appointments\`, \`admit\_patient\_from\_appointment\`,

  \`auto\_discharge\_ghost\_patients\`, \`auto\_report\_pending\_radiology\_orders\`, \`cascade\_clinical\_automation\` (retired

  no-op), \`auto\_order\_ghost\_labs\`, \`auto\_code\_patient\_complaint\`, \`sweep\_stalled\_clinical\_orders\`. The two

  \`pg\_cron\` schedules (\`auto\_admit\_appointments\_job\`, \`auto\_report\_radiology\_job\`) \*\*are confirmed registered and

  active\*\* on the new project (verified 2026-09-19 via \`cron.job\`, both \`schedule: "\* \* \* \* \*"\`, \`active: true\`) —

  the earlier "unverified" status is resolved.

\- \*\*End-to-end admission/discharge automation confirmed working live on \`qxyvmvtecnnwqeqaouzh\`, verified

  2026-09-19.\*\* Called \`auto\_admit\_ghost\_patient\` and \`auto\_discharge\_ghost\_patients\` directly via REST RPC using

  the project's own anon/publishable key (i.e. exactly the call \`useAutomationWatchdog.ts\`'s ghost-tick makes, not

  an elevated/service-role bypass) and confirmed real, self-consistent state changes: \`patients\` went from

  12 admitted/12 total → 16 admitted/16 total (4 new ghost admissions across 3 facilities, matching \`bed\_management\`

  occupied count 12 → 16), then a discharge call moved 3 of those to \`status: 'Discharged'\` with \`bed\_management\`

  occupied dropping 16 → 13 in lockstep. Anon read access to \`patients\` (needed for the UI to display admissions)

  also confirmed working post-RLS-hardening. This closes the "next step when resumed" item — the automation layer

  itself is proven functional on the new project; what's left before any cutover consideration is running the actual

  frontend against it (dev/preview build) for a UI-level check, which hasn't been done yet.

\- Do NOT attempt bulk data export/import between the two Supabase projects by delegating to Lovable's AI agent with

  live credentials in the instructions — Claude Code's own safety classifier blocks this pattern (flagged as Data

  Exfiltration) and correctly so. Any data movement between the two projects should be done directly, in small,

  auditable, tool-visible steps — not delegated to a third-party agent.



\## CRITICAL — Edge Functions

\- `umls-proxy` — ACTIVE. ALL terminology ops route here (validate/lookup, crosswalk, expand). Correct function.

\- `fhir-terminology` — EMPTY SHELL, 0 invocations. DO NOT CALL. Any code calling it is a bug → reroute to umls-proxy.

\- `fhir-proxy` — ACTIVE (FHIR sync).

\- `nlp-extract-concepts` — as of 2026-09-18, calls Google Gemini (\`gemini-3.5-flash-lite\`, free tier) directly via

  raw \`fetch\`, not OpenAI. Env var is \`GEMINI\_API\_KEY\` (was \`OPENAI\_API\_KEY\`). Same fallback contract as before

  (429/error → \`{concepts: [], error: ...}\`, 200 — caller drops to its lexical ladder).



SAB mapping: SNOMED CT→SNOMEDCT\_US, ICD-10-CM→ICD10CM, LOINC→LNC, RxNorm→RXNORM, CPT→CPT, MedDRA→MDR.



UMLS endpoints (do NOT use the plain search endpoint for these):

\- Crosswalk: https://uts-ws.nlm.nih.gov/rest/crosswalk/current/source/{fromSab}/{fromCode}?targetSource={toSab}\&apiKey=KEY

\- Validate: https://uts-ws.nlm.nih.gov/rest/search/current?string={code}\&sabs={sab}\&inputType=sourceUi\&returnIdType=sourceUi\&searchType=exact\&apiKey=KEY



\## Medical Dictionary — 7 sections, ALL WORKING

Value Set Library (4-tab drawer, status workflow, Save Metadata + change\_history);

Authoring Workbench (live UMLS search, Save Draft stays loaded, Submit for Review);

Cross-Map Studio (single+batch crosswalk, CSV, FHIR ConceptMap);

NLP Audit Logs (3-stage pipeline, auto-resolve);

Live Terminology Matrix (clickable pills, cross-tab nav);

FHIR Terminology Server ($lookup/$expand/$translate — presentation layer wrapping UMLS in FHIR JSON);

Safety Alerts (empty = healthy).



\## Known UMLS data gaps — NOT bugs, do not "fix"

SNOMED 422504002 (stroke) and 233604007 (pneumonia) have no direct ICD-10-CM crosswalk in UMLS — "no match" is correct.

Working demo codes: 38341003→I10, 44054006→E11, 59282003→I26, 22298006 ($lookup → Myocardial infarction).



\## Auto Terminologist (src/hooks/useAutoTerminologist.ts) — demand-mode architecture (as of 2026-07-05)

Refactored away from an opportunistic 24h-patient-data scanner with a numeric confidence score to a VSAC-style

demand queue. There is no confidence formula, no deriveThemeName(), and no UMLS \`validate\` call in this file anymore

— do not chase the old confidence-score bug, it no longer applies. Still NEVER auto-publishes (keep this).

Flow: consumer engines (Safety Alerts, Auto Doc, Auto Admin) detect a coverage gap and insert/merge a row into

\`terminology\_requests\` (status \`pending\`) with real coded \`seed\_codes\` (e.g. RxNorm/SNOMED codes already resolved

by their own pipelines — never raw chief-complaint text). Every \~10 min (leader-elected tab, DB-gated via

\`auto\_terminologist\_log.run\_at\`) \`processPendingTerminologyRequests()\` reads all pending rows and for each:

1\. \`request\_type: "deprecate"\` → flags the target \`custom\_value\_sets\` row \`deprecation-suggested\` (human acts on it

   in the Value Set Library); drafts under review/published are never silently downgraded.

2\. \`request\_type: "create"\` (default) → \`tryUmlsSuggestion()\` first searches UMLS for an existing real value set;

   if ≥3 plausible matches, stages them as \`status: "umls-suggested"\` on the request row and skips self-authoring.

3\. Otherwise runs \`runQualityGate()\` — a boolean pass/fail gate (not a score) on the request's \`seed\_codes\`: checks

   for missing code/display/vocabulary, unsupported vocabulary (must be SNOMED CT, ICD-10, RxNorm, or LOINC),

   too-short/non-descriptive display text, duplicate codes, and code shape vs. declared vocabulary

   (\`codeShapeMatches\`, e.g. SNOMED must be 6–18 digits). Failure → request stays \`pending\`, gets

   \`quality\_gate\_notes\` explaining exactly why, and is logged to \`auto\_terminologist\_log\` (action \`gated\`) —

   this is where a "held, nothing drafts" symptom would actually show up today.

4\. On pass, \`safeUpsertValueSet()\` drafts a new \`custom\_value\_sets\` row (\`status: "draft"\`) or merges codes into an

   existing draft/review/published row without ever downgrading status, then a best-effort crosswalk sanity-check

   runs on the added codes (never blocks the draft).

A separate pass in the same cycle (\`runPairAutoLinkPass\`) links Drug-Allergy \`value\_set\_dependencies\` rows to

newly-published value sets by exact name. Every cycle writes one row to \`automation\_watchdog\_logs\`.

The \`confidence\` column on \`auto\_terminologist\_log\` and the confidence display in \`AutoTerminologistActivity.tsx\`

are vestigial from the old scanner — no current code path populates them.

To see what it's actually doing right now: check \`terminology\_requests\` for \`status\` and \`quality\_gate\_notes\`

(non-null notes on a still-\`pending\` row = held, and why), and \`auto\_terminologist\_log\` ordered by \`run\_at desc\`

for \`action\` in (\`gated\`, \`drafted\`, \`extended\`, \`umls-suggested-import\`, \`deprecation-suggested\`,

\`cycle\_summary\`, \`heartbeat\`) — or the Auto Terminologist Activity panel in the Medical Dictionary admin UI, which

reads the same log.



\## Database

Join to patients via mrn. patients uses facility\_name (not "facility"); status is 'Admitted'|'Discharged';

codes in standardized\_output (jsonb) + snomed\_codes\[]/icd10\_codes\[]. Verify columns before assuming:

SELECT column\_name, data\_type FROM information\_schema.columns WHERE table\_name='X' ORDER BY ordinal\_position;

Two Supabase projects exist right now — see the migration section above. Know which one you're querying:

production is \`fjncfbqwyrenoavhkvdr\` (query via the Lovable MCP connector's \`query\_database\` tool, project id

\`c583ffa8-2be6-4140-bf75-9b224843471e\`), the migration target is \`qxyvmvtecnnwqeqaouzh\` (query via its REST API

with the service\_role key, or \`supabase db query --linked\` if direct Postgres/IPv6 access is available).



\## Ruflo / RuFlo Office — installed, monitoring-only, not an execution engine

\`ruflo\` (claude-flow) is installed in this project (\`.claude/\`, \`.claude-flow/\`, \`.agents/\`, \`.swarm/\`,

\`dashboard/\`). Its role here is strictly a \*\*read-only activity monitor\*\* for what Claude Code itself does in this

project — it is NOT set up to spawn or run its own agents to do spehr work, and should not be used that way.

Specifically:

\- RuFlo Office (the dashboard at \`dashboard/server.mjs\`, typically \`http://localhost:4173\`) is for watching

  Claude Code's own activity in this project. Do NOT click its "Spawn" / "+" controls — that creates live,

  independently-running agents with broad tool access, which is exactly the pattern Claude Code's own safety

  classifier has blocked twice in this project's history (reasons: "Create Unsafe Agents", "Data Exfiltration").

\- The ruflo daemon (\`ruflo daemon start\`) runs local-only bookkeeping workers (\`map\`/\`audit\`/\`optimize\`) with AI

  workers disabled by default — this is the safe mode and should stay that way. Starting it is itself sometimes

  blocked by the auto-mode classifier when Claude Code attempts it directly; if so, ask the user to run it

  themselves (\`! ruflo daemon start\`).

\- Model routing for subagents Claude Code spawns via its own Agent tool (not ruflo's) should scale with task

  difficulty — see Working style below. This is independent of whatever \`modelPreferences\` ruflo's own config

  files declare for its own (currently unused) agent-spawning path.

\- \*\*Office bridge (added 2026-09-18):\*\* \`.claude/helpers/office-task-bridge.cjs\` lets Claude Code register its

  own Agent-tool subagent spawns as ruflo tasks/agents purely so Office can visualize them — it does NOT spawn,

  run, or control anything itself, and never touches the hook chain in \`hook-handler.cjs\` (zero regression risk

  to ruflo's own intelligence/session tracking). Call it manually around meaningful subagent work:

  \`node .claude/helpers/office-task-bridge.cjs start --id <correlationId> --type <agentType> --model <model> --desc "<description>"\`

  then \`... complete --id <correlationId>\` or \`... fail --id <correlationId>\` when the subagent finishes.

  \`<agentType>\` should be one of Office's known role labels (coder, researcher, tester, reviewer, architect,

  analyst, optimizer, security-architect, security-auditor, memory-specialist, swarm-specialist,

  performance-engineer) — pick whichever best matches what the subagent is actually doing. \`<model>\` should match

  the model tier actually used for that subagent (haiku/sonnet/opus), per the difficulty-based routing rule.

  Tested working 2026-09-18: registering a task makes its node go green/active with a connecting line to the

  swarm core in Office; completing it returns the node to idle. To start Office itself: \`ruflo daemon start\`

  (safe default — AI workers disabled, local-only bookkeeping only) and

  \`node dashboard/server.mjs\` (serves on \`http://localhost:4173\`, or set \`RUFLO\_DASHBOARD\_PORT\`).

  \*\*Office board behavior (as of 2026-09-18):\*\* \`start\`/\`complete\`/\`fail\` in the bridge now delete the agent+task

  entry entirely rather than resetting it to idle — a board only shows agents that are either a standing-roster

  placeholder (\`modelRoutedBy: "default"\`, never touched by the bridge) or currently doing real work. A finished

  agent's desk disappears rather than accumulating as an idle ghost. The dashboard's own "Stop" button (in a

  board's drawer) does the same cleanup after \`ruflo agent stop\` succeeds. Each desk shows a colored model-tier

  badge (H=Haiku, S=Sonnet, O=Opus) read from the store's \`model\`/\`modelRoutedBy\` fields (the CLI's own \`agent

  list --format json\` strips these, so \`dashboard/server.mjs\`'s \`collect()\` merges them back in from

  \`.claude-flow/agents/store.json\` directly) — hover a desk or open the board's drawer for the full tier name and

  whether it was "routed by task complexity" (a real dispatch) or is a standing placeholder. A legend bar at the

  top of Office spells out the same three-tier rule that's in "Working style" below. Board layout is computed

  dynamically (\`posFor()\` in the dashboard, an ellipse around the swarm hub) so it isn't capped at a fixed slot

  count — adding a role just adds another point around the circle.

  \*\*Boss is on the board too (as of 2026-09-19):\*\* the primary Claude Code session — not a dispatched

  subagent — is now a 13th standing board, type \`boss\`, always sorted first (top of the circle) with a gold

  accent and a 👑 crown icon instead of the generic 🧑‍💻, plus a small "the primary session, not a dispatched

  role" note on its pod. This exists so the user can monitor everything on one screen, including work the boss

  does directly rather than delegating. \*\*Binding rule going forward:\*\* whenever the primary session performs

  a real task itself — applying a Supabase migration, deploying an edge function, a non-trivial investigation,

  anything more than a one-line read-only check — it must register that work on the board the same way it

  registers a dispatched subagent: \`node .claude/helpers/office-task-bridge.cjs start --id <correlationId>

  --type boss --model <actual model running this session> --desc "<description>"\`, then \`complete\`/\`fail\` when

  done. This is not optional flavor — the whole point of Office is that \*everything\* is visible on the

  dashboard, not just delegated work.

  \*\*UI redesign (as of 2026-09-18):\*\* removed the "+" Spawn button and its panel entirely, along with

  \`/api/spawn\` server-side — Office never lets anyone create a live independently-running agent from the UI now,

  closing off the exact pattern already banned above. Removed the decorative swarm "messages sent / consensus

  rounds" stats from the hub drawer (never meaningfully populated, since this project doesn't do multi-agent

  consensus) — replaced with a live "Active pipelines" list showing any in-progress coordinated handoff chain by

  name and stage. Added a persistent "WHO'S WORKING ON WHAT" panel (top-left, collapsible) listing every currently

  active agent with its role, live task description, and elapsed time — no hover needed, and clicking a row opens

  that role's board drawer. Added a role-name search/filter box in the header. \`office-task-bridge.cjs\`'s \`start\`

  command now takes optional \`--pipeline <name> --stage <n> --of <total>\`, which the dashboard renders as a

  "🔗 pipeline-name stage N/M" tag on the task everywhere it shows (work panel, tooltip, drawer, hub) — use this

  when dispatching a step of the coordination-model pipeline above so Office visually distinguishes coordinated

  handoffs from independent one-off dispatches.

  \*\*Standing role roster (as of 2026-09-18):\*\* 12 boards, seeded as idle \`modelRoutedBy: "default"\` placeholders

  matching a real corporate structure for building/running this EHR app — use these \`--type\` values when

  registering bridge work, matching the role to what the subagent is actually doing:

  | Group | \`--type\` value | Real-world role | Baseline tier |

  |---|---|---|---|

  | Engineering | \`coder\` | Software Engineer | Sonnet |

  | Engineering | \`reviewer\` | Tech Lead / Code Reviewer | Sonnet |

  | Engineering | \`tester\` | QA Engineer | Sonnet |

  | Engineering | \`architect\` | Solutions Architect | Opus |

  | Engineering | \`devops\` | DevOps / SRE (Cloudflare Workers deploy, CI/CD) | Sonnet |

  | Engineering | \`data-engineer\` | Database/Data Engineer (Supabase schema, migrations) | Sonnet |

  | Product & Design | \`product-manager\` | Product Manager (roadmap, requirements) | Sonnet |

  | Product & Design | \`ux-designer\` | UX/UI Designer (patient + clinician workflows) | Sonnet |

  | Health-tech domain | \`clinical-informaticist\` | Terminology/FHIR specialist (UMLS, SNOMED, Medical Dictionary) | Sonnet |

  | Health-tech domain | \`security-auditor\` | Security & Compliance (HIPAA-adjacent hygiene) | Opus |

  | Research & Analysis | \`analyst\` | Business/Data Analyst | Sonnet |

  | Research & Analysis | \`researcher\` | Research & Innovation | Sonnet |

  | — | \`boss\` | The primary session itself (not dispatched) | whatever model is actually running the session |

  "Baseline tier" is just the placeholder's idle badge — actual dispatches still follow the difficulty-based

  routing rule below, not a fixed mapping per role.

  \*\*Per-role access policy (as of 2026-09-18):\*\* there is no OS-level permission system for Agent-tool

  subagents — a spawned agent gets whatever tools its prompt references, nothing is enforced by the platform.

  "Access per role" therefore means a policy Claude Code itself must follow when writing each role's prompt —

  least-privilege by convention, not by mechanism. This reflects how each role has actually behaved correctly

  across two real work rounds on 2026-09-18:

  | Role | Read | Write/Edit | Bash | Supabase MCP | Browser |

  |---|---|---|---|---|---|

  | \`coder\` | Anywhere | \`src/\`, \`supabase/functions/\*/index.ts\` for confirmed bug fixes only | \`npm test\`, \`tsc --noEmit\`, \`npm run build\` | None | No |

  | \`reviewer\` | Anywhere | None — review only | \`git diff\`/\`log\`/\`show\` (read-only git) | None | No |

  | \`tester\` | Anywhere | Test files, test config (\`vitest.config.ts\`), \`package.json\` scripts/devDeps | \`npm test\`, \`npx vitest\`, \`deno test\`/\`deno check\` if available | None | No |

  | \`architect\` | Anywhere | \`docs/\*.md\`, \`CLAUDE.md\` — design docs only, never implements | Read-only (\`git log\`, inspection commands) | \`get_advisors\`, \`list_tables\`, \`list_edge_functions\` (read-only) | No |

  | \`devops\` | Anywhere | CI config (\`.github/workflows/\`), \`package.json\` engines/build scripts, build-tool config | \`npm run build\`, \`npx wrangler\` inspection (never \`wrangler deploy\`/\`supabase functions deploy\`) | None | No |

  | \`data-engineer\` | Anywhere | \`docs/\*.md\` (migration plans) — never a live migration file applied without separate explicit approval | Local SQL inspection only | READ-ONLY: \`list_tables\`, \`get_advisors\`, \`execute_sql\` (SELECT only). Never \`apply_migration\`, never a mutating \`execute_sql\` | No |

  | \`product-manager\` | Anywhere | \`README.md\`, \`CHANGELOG.md\`, \`docs/backlog.md\` only | \`git status\`/\`diff\` for context-gathering | None | No |

  | \`ux-designer\` | Anywhere | Component files, but ONLY accessibility attributes (\`aria-*\`, \`<label>\`) once a finding is confirmed — never visual/behavioral changes without a separate task | \`tsc --noEmit\` to verify | None | Yes — read-only browsing/inspection for audits; never submits forms or clicks destructive controls |

  | \`clinical-informaticist\` | Anywhere | None — verification only | None | Read-only calls to verify live terminology behavior (e.g. invoking \`umls-proxy\` directly) are fine; no schema/data mutation | No |

  | \`security-auditor\` | Anywhere | Security-relevant files (edge functions), ONLY to close a specific confirmed vulnerability — never a broad refactor | \`deno check\` to verify | READ-ONLY only (\`get_advisors\`) | No |

  | \`analyst\` | Anywhere | None — analysis only | None | READ-ONLY: \`execute_sql\` (SELECT only), \`get_advisors\`, \`list_tables\` | No |

  | \`researcher\` | Anywhere | \`docs/*.md\` for its own research write-ups only | Read-only inspection commands | Read-only, if needed for the research question | Read-only, if needed |

  | \`boss\` (primary session) | Anywhere | Anywhere | Anything | Read-write, incl. \`apply_migration\`/\`deploy_edge_function\` | If genuinely needed |

  \`boss\` is deliberately unrestricted — it's the primary session, and every restriction in this table exists

  precisely to keep the 12 dispatched roles from doing what only \`boss\` should: git operations, Supabase

  mutations, deploys. \`boss\` still owes the user the same confirmation checkpoints as always (see the hard

  exceptions in \[\[spehr\_autonomy\_scope\]\] memory) — this table's freedom is about tool access, not about

  skipping the user's sign-off on migration cutover / force-push / data deletion / live-branch pushes.

  \*\*Cross-cutting, no exceptions for any role:\*\* no role ever runs \`git commit\`, \`git push\`, \`git reset --hard\`,

  \`supabase functions deploy\`, \`apply_migration\`, or any other mutating/deploy command — those stay with the

  primary session, gated by the standing confirmation exceptions in \[\[spehr\_autonomy\_scope\]\] memory (Supabase

  cutover, force-push, data deletion, pushing to the live branch). A role needing something outside its own row

  (e.g. \`data-engineer\` actually applying a migration) is a signal to bring it to the user, not to broaden the

  prompt.

  \*\*Coordination model (as of 2026-09-18):\*\* the first two work rounds this session ran all 12 roles in

  parallel on independent tasks — useful for a broad audit, but not how a real office ships a single piece of

  work, and not to be the default going forward for anything beyond initial discovery. For an actual backlog item

  (see \`docs/backlog.md\`), route it through a pipeline with real handoffs, most roles reading the PREVIOUS role's

  actual output rather than working from the original problem statement independently:

  1. \*\*Product Manager\*\* triages \`docs/backlog.md\` and states what "done" means for the item.

  2. \*\*Architect\*\* designs first, in writing (\`docs/\*-design.md\`), for anything touching schema, security, or

     a race condition — skip straight to step 3 for a simple, well-understood bug fix.

  3. \*\*Coder\*\* implements strictly from the Architect's design doc (or the bug report), not from scratch.

  4. \*\*Reviewer\*\* reviews the Coder's actual diff against the design doc, not the diff in isolation.

  5. \*\*Domain specialist sign-off\*\*, run against the same diff, gated on what the change touches: \`security-auditor\`

     for anything security-relevant, \`data-engineer\` for schema/RLS, \`clinical-informaticist\` for terminology

     logic, \`ux-designer\` for UI-facing changes. Skip whichever don't apply.

  6. \*\*Tester\*\* adds/extends coverage for what Coder just built (not a generic sweep).

  7. \*\*DevOps\*\* confirms the change doesn't break build/typecheck/CI once the above are clean.

  \`analyst\` and \`researcher\` normally sit outside this per-ticket pipeline — they feed \*into\* the Product

  Manager's backlog (new findings, verification of assumptions) rather than gating a specific ticket, the same

  way a data/research team feeds a real PM's roadmap without being in every ship-a-feature critical path.

  A pipeline run still stops at the same points a parallel run would: no role applies a migration, deploys, or

  pushes without the user's separate say-so (see the access table above) — coordination changes the order and

  handoffs, not who's allowed to pull the trigger on an irreversible step.



\## Working style

One focused change at a time; verify before next. Surgical fixes, not rewrites. Add temp console.logs to confirm

root cause, then remove. Never call fhir-terminology. Keep human-in-the-loop (no auto-publish of value sets).

Deploy Edge Functions: \`supabase functions deploy <name> --project-ref <ref>\` (specify the project explicitly while

two Supabase projects are in play). After frontend edits: commit → push → Cloudflare Workers Build auto-deploys →

verify on spehr.live / www.spehr.live (no more Lovable sync step).

When spawning subagents via the Agent tool for spehr work, pick the model by task difficulty rather than defaulting

to one tier for everything: simple/mechanical tasks (a single lookup, running one command, formatting) → Haiku;

typical coding/debugging/investigation → Sonnet (default); complex architecture, deep multi-file debugging, or

high-stakes production changes → Opus. Say which tier and why when it's not the default.
