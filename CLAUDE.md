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



\## CRITICAL — Supabase migration cutover complete (as of 2026-09-23)

Production (\`spehr.live\`/\`www.spehr.live\`) now runs on \`qxyvmvtecnnwqeqaouzh\` — your own Supabase project.

The old Lovable-managed project (\`fjncfbqwyrenoavhkvdr\`) is no longer receiving traffic from spehr.live; Lovable is

out of the picture for this repo entirely. Cutover was verified end-to-end: a live admission (\`MRN-137559\`) flowed

through the real app, landed in \`qxyvmvtecnnwqeqaouzh\`, and successfully pushed to the Medblocks FHIR server, all

within ~2 minutes of the deploy going live.

Cutover mechanics, in case this ever needs redoing (e.g. for MySpehr or another app on the same pattern):

\- Cloudflare Workers Build has \*\*two separate, easy-to-confuse variable surfaces\*\* for a Worker: "Runtime variables

  and secrets" (Settings tab, read via \`process.env\` at request time) and "Build Variables" (Settings → Builds,

  read by Vite at build time for \`import.meta.env.VITE\_\*\` inlining). Updating the Runtime list does \*\*not\*\* affect

  the client bundle — \`VITE\_SUPABASE\_URL\`/\`VITE\_SUPABASE\_PUBLISHABLE\_KEY\` must be set in Build Variables specifically,

  or every rebuild silently keeps serving the old bundle with no error anywhere. Check a build's detail page

  (Deployments → click a version → "Build Variables" row) to confirm what a given build actually saw.

\- Dashboard variable edits create a new Worker "version" but do \*\*not\*\* trigger an actual rebuild — Vite/the build

  step only reruns on a genuine git push. An empty commit (\`git commit --allow-empty\`) is a safe way to force one.

\- Production had \*\*11 pg\_cron jobs\*\*, several set up manually via the SQL editor and never captured in any

  migration file: \`ghost\_triage\_job\` (auto\_admit\_ghost\_patient, \*/5min), \`ghost\_physician\_job\`

  (auto\_order\_ghost\_labs, \*/15min), \`ghost-discharge-worker\` (HTTP call, \*/5min), \`fhir-outbound-poll-45s\` /

  \`fhir-inbound-poll-45s\` (HTTP calls, every ~30-45s), \`sweep\_stalled\_clinical\_orders\_job\` (\*/1min),

  \`vitals-simulation-tick-1min\` (\*/1min), \`backfill-invoices-every-10min\` (HTTP call — \*\*was pointed at a Lovable

  preview URL on production\*\*, now points at spehr.live's own \`/api/public/hooks/generate-invoice\` route instead).

  Only \`auto\_admit\_appointments\_job\`/\`auto\_report\_radiology\_job\`/\`purge-expired-local-cache-daily\` had been

  migrated originally — the rest were missing on \`qxyvmvtecnnwqeqaouzh\` until this cutover and had to be recreated

  by reading production's \`cron.job\` table directly and porting each command over (rewriting URLs/keys to the new

  project). If any of these ever look stalled, check \`cron.job\` on both projects for drift again.

\- Also manually recreated (same "never migrated" pattern): the \`rapid\_response\_alerts\` table + \`simulate\_vitals\_tick()\`

  function (vitals simulation + NEWS2 rapid-response alerting), and — the one that actually mattered most — a

  \`BEFORE INSERT\` trigger on \`patients\` calling \`set\_target\_discharge\_at()\`. That function existed on the new

  project but was never attached as a trigger, so every ghost-admitted patient got \`target\_discharge\_at = NULL\`

  and could never be selected by \`ghost-discharge-worker\`'s \`.lte('target\_discharge\_at', now)\` query — the whole

  admit/discharge cycle silently froze once census hit the hardcoded 85-patient cap (which is exactly what had

  happened by the time this was caught). Fixed by attaching the trigger \*\*and\*\* backfilling \`target\_discharge\_at\`

  on the 85 already-stuck patients. If census ever looks frozen again, check \`target\_discharge\_at\` distribution

  first.

\- \`fhir\_sync\_state\`'s RLS anomaly (mentioned in earlier notes) turned out to be moot — the poll functions read/write

  it fine via their own service-role client; only ad-hoc \`anon\`/dashboard queries against it were ever blocked.

\- Do NOT attempt bulk data export/import between Supabase projects by delegating to Lovable's AI agent with live

  credentials in the instructions — Claude Code's own safety classifier blocks this pattern (flagged as Data

  Exfiltration) and correctly so. Any data movement between projects should be done directly, in small, auditable,

  tool-visible steps — not delegated to a third-party agent.



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

\- \*\*Architecture rewritten 2026-09-24 — Office is no longer tied to this one PC.\*\* The dashboard used to be a

  Node process (\`dashboard/server.mjs\`) tunneled out via \`cloudflared\`, and \`office-task-bridge.cjs\` wrote to

  local \`.claude-flow/*.json\` files — both genuinely broke the moment a different machine (e.g. a cloud Claude

  Code session) tried to use them, since that session would see its own local filesystem, not this PC's. The

  dashboard is now a real route on this already-deployed Worker, \*\*\`src/routes/office.tsx\`, live at

  spehr.live/office\*\*, and the shared state lives in a Supabase table (\`office_board\` on \`qxyvmvtecnnwqeqaouzh\`,

  RLS open to anon since it only ever holds dev-activity visualization, never patient data) instead of local

  files. Any Claude Code session — this PC or a cloud sandbox — runs the exact same

  \`office-task-bridge.cjs\` and sees the exact same board, because the state lives in Supabase, not on a disk.

  The old \`dashboard/server.mjs\` + \`cloudflared\` tunnel setup (still present in the repo, not yet deleted) is

  superseded — don't bother starting it, it was left as-is rather than deleted mid-session.

\- Do NOT click Office's "Spawn" / "+" controls if they ever resurface in some other view — creating live,

  independently-running agents with broad tool access is exactly the pattern Claude Code's own safety classifier

  has blocked twice in this project's history (reasons: "Create Unsafe Agents", "Data Exfiltration").

\- The ruflo daemon (\`ruflo daemon start\`) and its local-only bookkeeping workers (\`map\`/\`audit\`/\`optimize\`) are

  a separate, unrelated thing from the Office board above — pure local housekeeping, AI workers disabled by

  default, still fine to leave as-is. It has its own 12h self-shutdown TTL; don't read "daemon stopped" as

  something being broken.

\- Model routing for subagents Claude Code spawns via its own Agent tool (not ruflo's) should scale with task

  difficulty — see Working style below. This is independent of whatever \`modelPreferences\` ruflo's own config

  files declare for its own (currently unused) agent-spawning path.

\- \*\*Office bridge:\*\* \`.claude/helpers/office-task-bridge.cjs\` lets Claude Code register its own Agent-tool

  subagent spawns (and the primary session's own direct work) as rows in the shared \`office_board\` Supabase

  table, purely so the dashboard can visualize them — it does NOT spawn, run, or control anything itself. Works

  identically from any environment with network access; no local file dependency left. Call it manually around

  meaningful subagent work:

  \`node .claude/helpers/office-task-bridge.cjs start --id <correlationId> --type <agentType> --model <model> --desc "<description>"\`

  then \`... complete --id <correlationId>\` or \`... fail --id <correlationId>\` when the subagent finishes.

  \`<agentType>\` must be one of the 13 canonical role labels the board actually has rows for — boss, analyst,

  architect, clinical-informaticist, coder, data-engineer, devops, product-manager, researcher, reviewer,

  security-auditor, tester, ux-designer — pick whichever best matches what the subagent is actually doing. An

  older draft of this doc listed a different, no-longer-real role set (optimizer, security-architect,

  memory-specialist, swarm-specialist, performance-engineer) — those never existed as board rows; ignore any

  reference to them. \`<model>\` should match

  the model tier actually used for that subagent (haiku/sonnet/opus), per the difficulty-based routing rule.

  Tested working 2026-09-24 on the new Supabase-backed board: a \`start\` call makes that role's card active with

  its live description within one poll cycle (~4s); \`complete\`/\`fail\` removes it, leaving the idle placeholder.

  Office itself needs nothing started anymore — \`spehr.live/office\` is live whenever spehr.live is.

  \*\*The paragraph below describes \`dashboard/server.mjs\`'s old, more elaborate local UI (hub-and-spoke layout,

  drawers, a "WHO'S WORKING ON WHAT" panel, per-agent model-tier badges merged from \`ruflo agent list\`'s CLI

  output) — kept for historical reference since that file is still in the repo, unused. \`src/routes/office.tsx\`\`

  replaces it with a deliberately simpler grid (one card per role, active entries only, pipeline tags inline) and

  does not reproduce every one of these specific UI details. If Office's UI ever needs one of these features back,

  add it to \`office.tsx\` directly — don't resurrect \`dashboard/server.mjs\`, it can't read the new Supabase-backed

  state without its own rewrite, and \`ruflo agent list\` was always a local-only CLI, not something a cloud

  session can invoke either.\*\*

  \*\*Office board behavior (as of 2026-09-18, describing the legacy local dashboard):\*\* \`start\`/\`complete\`/\`fail\` in the bridge now delete the agent+task

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



\*\*Dispatch-first, not hands-on-first.\*\* For any real chunk of spehr work — bug fixes, investigations, UI/UX

changes, docs, tests, verification — the primary Claude Code session (\`boss\` on the Office board) should dispatch

it to the matching role from the 12-role roster in the Ruflo Office section above via

\`node .claude/helpers/office-task-bridge.cjs start --id <id> --type <role> --model <tier> --desc "<what>"\` \+ the

Agent tool, picking both role and model tier by the difficulty rule immediately above, then \`complete\`/\`fail\` when

the subagent finishes and review its output before moving on. \*\*This is the default for real implementation work,\*\*

not an occasional nicety — an elaborate role/model/pipeline system that boss narrates while quietly doing everything

itself in the main thread defeats the entire point of building it. What stays with boss directly, not delegated:

deciding priorities and what to dispatch next; registering/completing tasks in the bridge; reviewing subagent output

and deciding pass/fail; git operations (commit/push — no dispatched role has this access, see the per-role access

table above); Supabase migrations/deploys; and the standing hard-exception approvals (migration cutover, force-push,

data deletion, pushing to the live branch). Genuinely trivial one-line read-only checks (e.g. confirming a subagent's

fix compiles) can be done directly too — that's a judgment call, but the default leans toward dispatching, not doing

it yourself. \*\*This applies identically to a fresh cloud Claude Code session picking up the handover doc\*\* — it has

no access to any prior session's local memory, so this paragraph (not a memory file) is the durable source of truth

for the dispatch-first expectation.



\*\*Coordinated meetings — when two+ roles genuinely need to work the same issue together.\*\* Most dispatches are

independent: boss hands one role one task, reviews the result, moves on. Some problems don't decompose that

cleanly — e.g. a security fix that needs the security-auditor and the coder actively reasoning about the same

change together, not a security review that happens after the code is already written. When that's the actual

shape of the problem (not just "these two tasks are related"), dispatch both roles with the \*same\* \`--pipeline\`

name (\`--pipeline <shared-name> --stage <n> --of <total>\` on each \`start\` call). \`office_room_tick()\` (see the

room-simulation migrations, 2026-09-24/25) detects \>=2 rows sharing a non-null \`pipeline_name\` while both are

\`status='working'\` and seats them together in Office's conference room live — this is the actual, tested

mechanism behind "a coordinated meeting happens," not a metaphor. It ungroups automatically the moment either

one finishes (goes to \`idle\`) or the shared \`pipeline_name\` is cleared. Boss decides when a pipeline grouping is

warranted, same as it decides role and model tier — don't pipeline-tag unrelated parallel work just to make Office

look busier; the grouping should mean the two roles are actually reasoning about the same problem at the same time.
