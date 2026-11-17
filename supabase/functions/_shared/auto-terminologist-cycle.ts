/**
 * Auto Terminologist — autonomous clinical terminologist agent.
 * SHARED cycle implementation.
 * --------------------------------------------------------------
 * This is the real implementation of the 10-minute Auto Terminologist
 * cycle. It used to live entirely inside `src/hooks/useAutoTerminologist.ts`
 * as a `setInterval` closure, which meant the cycle only ran while a human
 * had a browser tab open — it went silent for ~28.7h once nobody did
 * (confirmed via `auto_terminologist_log`'s heartbeat gap, 2026-11-16
 * 14:28 -> 2026-11-17 19:11, the exact moment a tab was reopened). The
 * "Loop active - 10 min cadence" badge in the UI was therefore misleading.
 *
 * This module takes NO framework or hardcoded-client dependency — every
 * function takes its Supabase client explicitly — so it's callable from
 * BOTH:
 *   - `src/hooks/useAutoTerminologist.ts` (via the thin re-export
 *     `src/lib/auto-terminologist-cycle.ts`), which keeps its
 *     `setInterval` trigger purely as a convenience for immediate feedback
 *     when a tab happens to be open.
 *   - The `auto-terminologist-cycle` edge function (imports this file
 *     directly, no re-export needed since it's already Deno-native),
 *     invoked every 10 minutes by `pg_cron` regardless of whether any
 *     browser tab is open. THIS is what actually fixes the reliability
 *     gap — the cycle now runs server-side on a fixed schedule.
 *
 * Both callers race for the SAME `auto_terminologist` DB-backed lease
 * (`claim_automation_lease` / `heartbeat_automation_lease`,
 * `supabase/migrations/20260918215359_automation_leases.sql`, confirmed
 * applied live) so an open tab and the cron-triggered edge function can
 * never double-run a cycle — whichever claims the lease for a given
 * ~10-minute window runs it; the other is a no-op.
 *
 * What the cycle does — unchanged from the original design:
 *   1. Scans pending `terminology_requests` filed by consumer engines
 *      (Safety Alerts, Billing, Auto Doc, Auto Terminologist's own
 *      proactive sweep, etc.) — VSAC-style demand mode. UMLS-first for
 *      `create` requests; flags `deprecate` requests for human review.
 *   2. Drug-Allergy pair auto-link pass.
 *   3. Polls human-linked VSAC OIDs for publication (detection only).
 *   4. NEW — Proactive sweep: for currently-admitted patients, checks
 *      STANDING conditions / medication_orders / allergies against the
 *      published value-set library the same way Safety Alerts Engine's
 *      Rule 1 does (reuses `classTokens` / `substanceMatchesClass` /
 *      `extensionalContains` from `safety-alerts-matching.ts`), filing a
 *      governed `terminology_requests` row for any coverage gap found.
 *      This catches gaps in data that predates any trigger event — the
 *      event-driven engines only ever see *new* orders/conditions.
 *   5. NEW — Value-set staleness: flags published `custom_value_sets`
 *      rows that haven't been published or re-synced from VSAC in over
 *      ~6 months as due for a human review (never auto-re-syncs).
 *
 * The engine NEVER drafts a value set, NEVER submits for review, and NEVER
 * publishes. Every `custom_value_sets` write still requires a human action
 * (the Authoring Workbench, or importing/re-syncing a real OID via the
 * Value Set Library).
 */

import {
  recommendDefinitionType,
  requestTerminologyUpdate,
  suggestedRootConceptForStorage,
  type MinimalUmlsClient,
  type VsacExpansionResult,
} from "./value-set-registry.ts";
import {
  classTokens,
  extensionalContains,
  substanceMatchesClass,
  type MatchableValueSet,
} from "./safety-alerts-matching.ts";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const RUN_INTERVAL_MS = 10 * 60_000;
const LEADER_LEASE_MS = 3 * 60_000;

// VSAC's own publish/expansion cadence is roughly daily — poll a linked OID
// at most this often so the 10-minute background cycle doesn't hammer VSAC
// for a value set that isn't published yet. Slightly under 24h so a check
// that lands a little late one day still catches up the next.
const VSAC_POLL_INTERVAL_MS = 20 * 60 * 60_000;

// Proactive sweep — bounded so a 10-minute cycle never has to walk every
// admitted patient. Rotates through at most this many admitted patients
// per cycle, oldest-checked-first, and never re-checks a patient sooner
// than SWEEP_RECHECK_MS later. At 15/cycle * 6 cycles/hour that's 90
// patients/hour of throughput — comfortably ahead of typical admitted
// census — while the 4h floor means a small census isn't re-swept every
// 10 minutes for no reason.
const SWEEP_BATCH_SIZE = 15;
const SWEEP_RECHECK_MS = 4 * 60 * 60_000;

// Real VSAC value sets need periodic re-review: RxNorm updates monthly,
// SNOMED CT biannually, ICD-10-CM annually. 6 months is a conservative
// middle ground — short enough to catch SNOMED's cadence, long enough
// that a healthy, frequently-re-synced library doesn't get flagged
// constantly. This is a flag for a human (via the existing "Re-sync from
// VSAC" action), never an auto-re-sync.
const VALUE_SET_REVIEW_DUE_MS = 183 * 24 * 60 * 60_000;
// Don't re-log the same stale value set's flag more than once/day.
const STALE_RENOTIFY_MS = 24 * 60 * 60_000;

const VALID_VOCABS = new Set(["SNOMED CT", "ICD-10", "RxNorm", "LOINC"]);

export type SeedCode = { code: string; display: string; vocabulary: string };

/* ------------------------------------------------------------------ */
/*  DB-backed lease (leader election across open tabs AND the          */
/*  cron-triggered edge function)                                      */
/* ------------------------------------------------------------------ */

/**
 * Atomically claim the auto_terminologist lease via a single UPDATE ...
 * WHERE ... RETURNING call in Postgres (claim_automation_lease). Zero rows
 * returned means another caller (a different tab, or the edge function)
 * currently holds the lease or the cadence interval hasn't elapsed yet —
 * skip this cycle. One row means this caller now owns the cycle and
 * `last_run_at` has already been advanced atomically.
 */
export async function claimLease(
  client: MinimalUmlsClient,
  holder: string,
  leaseMs: number = LEADER_LEASE_MS,
  minIntervalMs: number = RUN_INTERVAL_MS,
): Promise<boolean> {
  try {
    if (!client.rpc) return false;
    const { data, error } = await client.rpc("claim_automation_lease", {
      _engine: "auto_terminologist",
      _holder: holder,
      _lease_ms: leaseMs,
      _min_interval_ms: minIntervalMs,
    });
    if (error) {
      console.warn("[auto-term] claim_automation_lease failed", error);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.warn("[auto-term] claim_automation_lease threw", e);
    return false;
  }
}

/**
 * Best-effort mid-cycle lease renewal so a long-running cycle can't have
 * its lease stolen by another caller before it finishes. Never throws — a
 * failed renewal just means the lease may lapse and another caller could
 * pick up the *next* cycle, which is an acceptable degradation, not a
 * correctness bug.
 */
export async function heartbeatLease(
  client: MinimalUmlsClient,
  holder: string,
  leaseMs: number = LEADER_LEASE_MS,
): Promise<void> {
  try {
    if (!client.rpc) return;
    const { error } = await client.rpc("heartbeat_automation_lease", {
      _engine: "auto_terminologist",
      _holder: holder,
      _lease_ms: leaseMs,
    });
    if (error) console.warn("[auto-term] heartbeat_automation_lease failed", error);
  } catch (e) {
    console.warn("[auto-term] heartbeat_automation_lease threw", e);
  }
}

/**
 * Best-effort release, purely an optimisation — never awaited, never lets
 * cleanup depend on it succeeding. Reuses heartbeat_automation_lease with
 * a negative lease so `leased_until` moves into the past, making the row
 * immediately claimable by the next caller rather than making it wait out
 * the full TTL.
 */
export function releaseLeaseBestEffort(client: MinimalUmlsClient, holder: string): void {
  try {
    if (!client.rpc) return;
    // supabase-js query/rpc builders are thenables — the HTTP request is
    // only actually sent once `.then()` (or `.catch()`) is called on them.
    client
      .rpc("heartbeat_automation_lease", {
        _engine: "auto_terminologist",
        _holder: holder,
        _lease_ms: -1000,
      })
      .then(
        () => {},
        () => {},
      );
  } catch {
    /* best-effort only — cleanup must not depend on this */
  }
}

/* ------------------------------------------------------------------ */
/*  Activity logging                                                   */
/* ------------------------------------------------------------------ */

async function logActivity(
  client: MinimalUmlsClient,
  opts: {
    message: string;
    value_set_id?: string | null;
    confidence?: number | null;
    action: string;
    theme?: string | null;
    codes_count?: number | null;
  },
) {
  try {
    await client.from("auto_terminologist_log").insert({
      message: opts.message,
      value_set_id: opts.value_set_id ?? null,
      confidence: opts.confidence ?? null,
      action: opts.action,
      theme: opts.theme ?? null,
      codes_count: opts.codes_count ?? null,
    });
  } catch (e) {
    console.warn("[auto-term] activity log failed", e);
  }
}

/* ------------------------------------------------------------------ */
/*  Shared activity bus mirror                                         */
/*  Writes to terminology_activity_log (feature-scoped) so the         */
/*  Library / Cross-Map panels see automated activity.                 */
/*  Uses actor "Auto Terminologist" (vs. human handlers' actor         */
/*  "S.P.E.H.R. Terminology Services") so reviewers can distinguish    */
/*  automated rows from manual ones at a glance.                       */
/* ------------------------------------------------------------------ */
async function logToBus(
  client: MinimalUmlsClient,
  feature: "library" | "crossmap",
  action: string,
  message: string,
  ref_id?: string | null,
) {
  try {
    await client.from("terminology_activity_log").insert({
      feature,
      actor: "Auto Terminologist",
      action,
      message,
      ref_id: ref_id ?? null,
    });
  } catch (e) {
    console.warn("[auto-term] bus log failed", feature, action, e);
  }
}

/* ------------------------------------------------------------------ */
/*  Demand mode — terminology_requests quality gate + recommendation   */
/* ------------------------------------------------------------------ */

export function codeShapeMatches(vocab: string, code: string): boolean {
  const c = String(code ?? "").trim();
  if (!c) return false;
  if (vocab === "SNOMED CT") return /^\d{6,18}$/.test(c);
  if (vocab === "ICD-10") return /^[A-Z]\d[A-Z0-9]?(\.[A-Z0-9]+)?$/i.test(c);
  if (vocab === "RxNorm") return /^\d+$/.test(c);
  if (vocab === "LOINC") return /^\d+-\d+$/.test(c);
  return true;
}

function runQualityGate(
  seedCodes: SeedCode[],
  requestVocab: string | null | undefined,
): { ok: boolean; notes: string; empty: boolean } {
  if (!Array.isArray(seedCodes) || seedCodes.length === 0) {
    return {
      ok: false,
      empty: true,
      notes: "No seed codes supplied — no scan match available yet",
    };
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  let missingDisp = 0,
    missingCode = 0,
    missingVocab = 0,
    badVocab = 0,
    badDisp = 0,
    dupCount = 0,
    badShape = 0;
  for (const raw of seedCodes) {
    const code = String(raw?.code ?? "").trim();
    const disp = String(raw?.display ?? "").trim();
    const vocab = String(raw?.vocabulary ?? requestVocab ?? "").trim();
    if (!code) missingCode++;
    if (!disp) missingDisp++;
    if (!vocab) missingVocab++;
    if (vocab && !VALID_VOCABS.has(vocab)) badVocab++;
    if (disp && (disp.length < 3 || /^[\d\s]+$/.test(disp))) badDisp++;
    if (code) {
      if (seen.has(code)) dupCount++;
      seen.add(code);
    }
    if (vocab && code && VALID_VOCABS.has(vocab) && !codeShapeMatches(vocab, code)) badShape++;
  }
  const total = seedCodes.length;
  if (missingCode) problems.push(`${missingCode} of ${total} seed codes missing a code`);
  if (missingDisp)
    problems.push(`${missingDisp} of ${total} seed codes are missing a display name`);
  if (missingVocab) problems.push(`${missingVocab} of ${total} seed codes missing a vocabulary`);
  if (badVocab)
    problems.push(
      `${badVocab} seed code(s) use an unsupported vocabulary (must be SNOMED CT, ICD-10, RxNorm, or LOINC)`,
    );
  if (badDisp) problems.push(`${badDisp} seed code display(s) are too short or non-descriptive`);
  if (dupCount) problems.push(`${dupCount} duplicate code value(s) within the request`);
  if (badShape)
    problems.push(
      `${badShape} seed code(s) don't match the shape expected for their declared vocabulary`,
    );
  if (problems.length === 0) return { ok: true, empty: false, notes: "" };
  return { ok: false, empty: false, notes: `Rejected by quality gate: ${problems.join("; ")}` };
}

function normalizePriority(p: string | null | undefined): number {
  const v = String(p ?? "normal").toLowerCase();
  if (v === "urgent") return 0;
  if (v === "high") return 1;
  if (v === "normal") return 2;
  if (v === "low") return 3;
  return 2;
}

// Cadence guard so still-pending requests don't spam the activity log
// every tick — key = request id, value = last log timestamp + notes.
// Module-level state is a best-effort noise-suppression heuristic, not a
// correctness guarantee: it resets on a cold start (new browser tab, or a
// fresh edge function isolate) and that's fine.
const requestLogTracker = new Map<string, { loggedAt: number; notes: string }>();

/* ------------------------------------------------------------------ */
/*  UMLS-first suggestion — check for an existing real value set       */
/*  before self-authoring a fresh draft from thin air.                 */
/* ------------------------------------------------------------------ */

function pickSabForRequest(vocabHint: string | null | undefined): {
  sab: string;
  vocabLabel: SeedCode["vocabulary"];
} {
  const v = String(vocabHint ?? "").toLowerCase();
  if (v.includes("icd")) return { sab: "ICD10CM", vocabLabel: "ICD-10" };
  if (v.includes("loinc")) return { sab: "LNC", vocabLabel: "LOINC" };
  if (v.includes("rxnorm") || v.includes("rx")) return { sab: "RXNORM", vocabLabel: "RxNorm" };
  return { sab: "SNOMEDCT_US", vocabLabel: "SNOMED CT" };
}

/**
 * Search UMLS for concepts matching the requested term. If UMLS returns a
 * plausible set (>=3 coded matches in a real vocabulary), record the
 * suggestion on the request row and skip self-authoring — the terminologist
 * can approve the import from the Auto Terminologist Activity panel.
 *
 * Returns true when a suggestion was staged (caller should skip drafting).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryUmlsSuggestion(client: MinimalUmlsClient, req: any): Promise<boolean> {
  const requestedName = String(req?.requested_name ?? "").trim();
  if (!requestedName) return false;
  const { sab, vocabLabel } = pickSabForRequest(req?.vocabulary);

  try {
    const { data, error } = await client.functions.invoke("umls-proxy", {
      body: {
        action: "search",
        params: {
          string: requestedName,
          sabs: sab,
          pageSize: 15,
          searchType: "words",
          returnIdType: "sourceUi",
        },
      },
    });
    if (error) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: any[] = data?.result?.results ?? [];
    const codes: SeedCode[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      const code = String(r?.ui ?? "").trim();
      const display = String(r?.name ?? "").trim();
      if (!code || code === "NONE" || code === "NO RESULTS" || seen.has(code)) continue;
      if (!codeShapeMatches(vocabLabel, code)) continue;
      seen.add(code);
      codes.push({ code, display, vocabulary: vocabLabel });
      if (codes.length >= 15) break;
    }
    if (codes.length < 3) return false;

    const now = new Date().toISOString();
    const notes = `UMLS match: ${codes.length} ${vocabLabel} concept(s) available for import — awaiting terminologist approval.`;
    await client
      .from("terminology_requests")
      .update({
        status: "umls-suggested",
        seed_codes: codes,
        vocabulary: vocabLabel,
        quality_gate_notes: notes,
        updated_at: now,
      })
      .eq("id", req.id);

    const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    await logActivity(client, {
      action: "umls-suggested-import",
      message: `${timeLabel} — UMLS lookup for '${requestedName}' returned ${codes.length} ${vocabLabel} concept(s) — staged as import suggestion (awaiting terminologist approval).`,
      theme: requestedName,
      codes_count: codes.length,
    });
    return true;
  } catch (e) {
    console.warn("[auto-term] UMLS suggestion failed", e);
    return false;
  }
}

export async function processPendingTerminologyRequests(client: MinimalUmlsClient): Promise<{
  recommended: number;
  gated: number;
  deprecationSuggested: number;
  rejected: number;
  scanned: number;
}> {
  let recommended = 0;
  let gated = 0;
  let deprecationSuggested = 0;
  let rejected = 0;
  const { data: pending, error } = await client
    .from("terminology_requests")
    .select(
      "id, requesting_consumer, requested_name, justification, priority, vocabulary, seed_codes, clinical_application, related_mrn, quality_gate_notes, request_type, target_value_set_id, requested_at, recommended_type",
    )
    .eq("status", "pending");
  if (error || !pending) return { recommended, gated, deprecationSuggested, rejected, scanned: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = [...(pending as any[])].sort((a, b) => {
    const dp = normalizePriority(a.priority) - normalizePriority(b.priority);
    if (dp !== 0) return dp;
    return String(a.requested_at ?? "").localeCompare(String(b.requested_at ?? ""));
  });

  for (const req of rows) {
    try {
      const requestedName = String(req.requested_name ?? "").trim();
      const requestType = String(req.request_type ?? "create").toLowerCase();
      const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

      // ---------------- Deprecation branch ----------------
      if (requestType === "deprecate") {
        const targetId = req.target_value_set_id ? String(req.target_value_set_id) : null;
        const nowIso = new Date().toISOString();
        if (!targetId) {
          gated += 1;
          await client
            .from("terminology_requests")
            .update({
              quality_gate_notes: "Deprecation request missing target_value_set_id",
              updated_at: nowIso,
            })
            .eq("id", req.id);
          await logActivity(client, {
            action: "gated",
            message: `${timeLabel} — Deprecation request from ${req.requesting_consumer} rejected: no target_value_set_id supplied.`,
            theme: requestedName || null,
          });
          continue;
        }
        const { data: target, error: targetErr } = await client
          .from("custom_value_sets")
          .select("id, name, status, change_history")
          .eq("id", targetId)
          .maybeSingle();
        if (targetErr || !target) {
          gated += 1;
          await client
            .from("terminology_requests")
            .update({ quality_gate_notes: "Target value set not found", updated_at: nowIso })
            .eq("id", req.id);
          await logActivity(client, {
            action: "gated",
            message: `${timeLabel} — Deprecation request from ${req.requesting_consumer} rejected: target value set ${targetId} not found.`,
            theme: requestedName || null,
          });
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tRow = target as any;
        const tStatus = String(tRow.status ?? "draft");
        const tName = String(tRow.name ?? "");
        if (tStatus === "draft") {
          rejected += 1;
          await client
            .from("terminology_requests")
            .update({
              status: "rejected",
              resolved_at: nowIso,
              updated_at: nowIso,
              quality_gate_notes:
                "Target is a draft — delete drafts directly instead of deprecating.",
            })
            .eq("id", req.id);
          await logActivity(client, {
            action: "gated",
            message: `${timeLabel} — Deprecation request from ${req.requesting_consumer} for draft '${tName}' — drafts should be deleted directly, not deprecated. Marked rejected.`,
            theme: tName,
            value_set_id: tRow.id ?? null,
          });
          continue;
        }
        if (tStatus === "review" || tStatus === "published") {
          const history = Array.isArray(tRow.change_history) ? tRow.change_history : [];
          const entry = {
            at: nowIso,
            actor: "Auto Terminologist",
            change:
              `Deprecation suggested — requested by ${req.requesting_consumer}: ${req.justification ?? ""}`.trim(),
          };
          await client
            .from("custom_value_sets")
            .update({
              status: "deprecation-suggested",
              change_history: [...history, entry],
              updated_at: nowIso,
            })
            .eq("id", tRow.id);
          await client
            .from("terminology_requests")
            .update({
              status: "drafted",
              value_set_id: tRow.id,
              resolved_at: nowIso,
              updated_at: nowIso,
              quality_gate_notes: null,
            })
            .eq("id", req.id);
          await logActivity(client, {
            action: "deprecation-suggested",
            message:
              `${timeLabel} — Deprecation suggested for '${tName}' (was ${tStatus}) — requested by ${req.requesting_consumer}: ${req.justification ?? ""}`.trim(),
            theme: tName,
            value_set_id: tRow.id ?? null,
          });
          await logToBus(
            client,
            "library",
            "deprecation-suggested",
            `${timeLabel} — Deprecation suggested for '${tName}' (was ${tStatus}) — requested by ${req.requesting_consumer}: ${req.justification ?? ""}`.trim(),
            tRow.id ?? null,
          );
          deprecationSuggested += 1;
          continue;
        }
        // Any other status (e.g. already deprecation-suggested / retired) — no-op
        await client
          .from("terminology_requests")
          .update({
            status: "rejected",
            resolved_at: nowIso,
            updated_at: nowIso,
            quality_gate_notes: `Target value set is '${tStatus}' — no deprecation action taken.`,
          })
          .eq("id", req.id);
        rejected += 1;
        continue;
      }

      // ---------------- Create branch (default) ----------------
      if (!requestedName) continue;

      // UMLS-first: prefer an existing real value set over self-authoring.
      const suggested = await tryUmlsSuggestion(client, req);
      if (suggested) {
        requestLogTracker.delete(String(req.id));
        continue;
      }

      const seedCodes: SeedCode[] = Array.isArray(req.seed_codes)
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (req.seed_codes as any[]).map((s) => ({
            code: String(s?.code ?? "").trim(),
            display: String(s?.display ?? "").trim(),
            vocabulary: String(s?.vocabulary ?? req.vocabulary ?? "").trim(),
          }))
        : [];

      const gate = runQualityGate(seedCodes, req.vocabulary);

      if (!gate.ok) {
        gated += 1;
        await client
          .from("terminology_requests")
          .update({ quality_gate_notes: gate.notes, updated_at: new Date().toISOString() })
          .eq("id", req.id);

        const prev = requestLogTracker.get(String(req.id));
        const changed = !prev || prev.notes !== gate.notes;
        const stale = !prev || Date.now() - prev.loggedAt >= RUN_INTERVAL_MS;
        if (changed || stale) {
          await logActivity(client, {
            action: "requested",
            message: `${timeLabel} — Terminology request from ${req.requesting_consumer}: '${requestedName}' — quality gate failed: ${gate.notes}`,
            theme: requestedName,
            codes_count: seedCodes.length,
          });
          requestLogTracker.set(String(req.id), { loggedAt: Date.now(), notes: gate.notes });
        }
        continue;
      }

      if (req.recommended_type) {
        requestLogTracker.delete(String(req.id));
        continue;
      }

      const dominantVocab = seedCodes[0].vocabulary;
      const now = new Date().toISOString();
      const recommendation = await recommendDefinitionType(
        {
          vocabulary: dominantVocab,
          candidates: seedCodes.map((s) => ({
            code: s.code,
            display: s.display,
            vocabulary: s.vocabulary,
          })),
          requestedName,
          justification: req.justification,
          context: {
            clinicalApplication: req.clinical_application,
            requestingConsumer: req.requesting_consumer,
          },
        },
        client,
      );

      await client
        .from("terminology_requests")
        .update({
          recommended_type: recommendation.recommendedType,
          reasoning: recommendation.reasoning,
          suggested_root_concept: suggestedRootConceptForStorage(recommendation),
          recommended_binding_strength: recommendation.recommendedBindingStrength,
          possible_existing_match: recommendation.possibleExistingMatch,
          clinical_focus: recommendation.clinicalFocus,
          data_element_scope: recommendation.dataElementScope,
          inclusion_criteria: recommendation.inclusionCriteria,
          exclusion_criteria: recommendation.exclusionCriteria,
          known_vsac_candidates:
            recommendation.knownVsacCandidates && recommendation.knownVsacCandidates.length > 0
              ? recommendation.knownVsacCandidates
              : null,
          quality_gate_notes: null,
          updated_at: now,
        })
        .eq("id", req.id);

      const activityMessage =
        `${timeLabel} — Terminology request from ${req.requesting_consumer}: '${requestedName}' — quality gate passed; stamped a ${recommendation.recommendedType} recommendation for the Suggestion Brief (no value set created — awaiting human review and authoring in VSAC). ${req.justification ?? ""}`.trim();

      await logActivity(client, {
        action: "recommendation_stamped",
        message: activityMessage,
        theme: requestedName,
        codes_count: seedCodes.length,
      });

      requestLogTracker.delete(String(req.id));
      recommended += 1;
    } catch (e) {
      console.warn("[auto-term] request processing failed", req?.id, e);
      const errorNote = `Processing error: ${e instanceof Error ? e.message : String(e)}`;
      try {
        await client
          .from("terminology_requests")
          .update({ quality_gate_notes: errorNote, updated_at: new Date().toISOString() })
          .eq("id", req.id);
        await logActivity(client, {
          action: "error",
          message: `Terminology request from ${req?.requesting_consumer ?? "unknown"} ('${req?.requested_name ?? "unknown"}') failed to process: ${errorNote}`,
          theme: req?.requested_name ?? null,
        });
      } catch (e2) {
        console.warn("[auto-term] failed to record processing error", req?.id, e2);
      }
    }
  }

  return {
    recommended,
    gated,
    deprecationSuggested,
    rejected,
    scanned: rows.length,
  };
}

/* ------------------------------------------------------------------ */
/*  Background VSAC-publication detection pass                         */
/*  For every terminology_requests row with a human-linked VSAC OID,    */
/*  poll vsacExpand at most ~once/day; once it returns codes, flip the  */
/*  row to 'ready_to_import' and stash the expansion as a preview for   */
/*  the one-click "Import Now" action in AutoTerminologistActivity.tsx. */
/*  NEVER writes to custom_value_sets itself — detection only, import   */
/*  always requires an explicit human click.                           */
/* ------------------------------------------------------------------ */

export async function runVsacPublicationPollPass(
  client: MinimalUmlsClient,
): Promise<{ checked: number; readyToImport: number }> {
  let checked = 0;
  let readyToImport = 0;
  try {
    const { data: linked, error } = await client
      .from("terminology_requests")
      .select("id, requested_name, linked_vsac_oid, last_vsac_check_at, status")
      .not("linked_vsac_oid", "is", null)
      .neq("status", "resolved");
    if (error || !linked) return { checked, readyToImport };

    const now = Date.now();
    for (const row of linked) {
      const oid = row.linked_vsac_oid;
      if (!oid) continue;
      try {
        const lastCheck = row.last_vsac_check_at ? new Date(row.last_vsac_check_at).getTime() : 0;
        if (lastCheck && now - lastCheck < VSAC_POLL_INTERVAL_MS) continue;
        checked += 1;
        const nowIso = new Date().toISOString();

        const { data, error: expErr } = await client.functions.invoke("umls-proxy", {
          body: { action: "vsacExpand", params: { oid } },
        });
        if (expErr || !data || data.error) {
          await client
            .from("terminology_requests")
            .update({ last_vsac_check_at: nowIso })
            .eq("id", row.id);
          continue;
        }

        const codes: Array<{ code: string; display: string; vocabulary: string }> = Array.isArray(
          data.codes,
        )
          ? data.codes
          : [];
        if (codes.length === 0) {
          await client
            .from("terminology_requests")
            .update({ last_vsac_check_at: nowIso })
            .eq("id", row.id);
          continue;
        }

        const preview: VsacExpansionResult = {
          oid: String(data.oid ?? oid),
          name: data.name ?? null,
          title: data.title ?? null,
          total: Number(data.total ?? codes.length),
          type: (data.type === "grouping" || data.type === "intensional"
            ? data.type
            : "extensional") as "grouping" | "intensional" | "extensional",
          codes,
          publisher: data.publisher ?? null,
        };
        await client
          .from("terminology_requests")
          .update({
            status: "ready_to_import",
            vsac_expansion_preview: preview,
            last_vsac_check_at: nowIso,
            updated_at: nowIso,
          })
          .eq("id", row.id);
        readyToImport += 1;

        const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        await logActivity(client, {
          action: "vsac_publication_detected",
          message: `${timeLabel} — Detected linked VSAC OID ${oid} now published for '${row.requested_name}' (${codes.length} codes) — staged for one-click import, awaiting human confirmation.`,
          theme: row.requested_name ?? null,
          codes_count: codes.length,
        });
      } catch (e) {
        console.warn("[auto-term] vsac publication check failed for request", row?.id, e);
        try {
          await client
            .from("terminology_requests")
            .update({ last_vsac_check_at: new Date().toISOString() })
            .eq("id", row.id);
        } catch {
          /* best-effort only */
        }
      }
    }
  } catch (e) {
    console.warn("[auto-term] vsac publication poll pass crashed", e);
  }
  return { checked, readyToImport };
}

/* ------------------------------------------------------------------ */
/*  Drug-Allergy pair auto-link pass                                   */
/*  Wires up value_set_dependencies rows with NULL value_set_id when   */
/*  a matching PUBLISHED custom_value_sets row exists by exact name.   */
/*  Never touches draft/review rows and never re-links.                */
/* ------------------------------------------------------------------ */
export async function runPairAutoLinkPass(client: MinimalUmlsClient): Promise<number> {
  try {
    const { data: unlinked, error } = await client
      .from("value_set_dependencies")
      .select("id, purpose, lookup_mode, value_set_name")
      .eq("consumer", "Safety Alerts Engine · Drug-Allergy")
      .is("value_set_id", null);
    if (error) {
      console.warn("[auto-term] pair auto-link select failed", error);
      return 0;
    }
    if (!unlinked || unlinked.length === 0) return 0;

    let linked = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const dep of unlinked as any[]) {
      const name = String(dep?.value_set_name ?? "").trim();
      if (!name) continue;
      try {
        const { data: vsRows, error: vsErr } = await client
          .from("custom_value_sets")
          .select("id, name")
          .eq("name", name)
          .eq("status", "published")
          .limit(1);
        if (vsErr) {
          console.warn("[auto-term] pair vs lookup failed", name, vsErr);
          continue;
        }
        const vs = Array.isArray(vsRows) && vsRows.length > 0 ? vsRows[0] : null;
        if (!vs) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vsId = (vs as any).id as string;
        const { error: updErr } = await client
          .from("value_set_dependencies")
          .update({ value_set_id: vsId, updated_at: new Date().toISOString() })
          .eq("id", dep.id);
        if (updErr) {
          console.warn("[auto-term] pair link update failed", dep?.id, updErr);
          continue;
        }

        const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const msg = `${timeLabel} — Activated Drug-Allergy pair '${dep.purpose}' (${dep.lookup_mode} side) — linked published value set '${name}'.`;
        await logActivity(client, {
          action: "pair-linked",
          message: msg,
          theme: String(dep.purpose ?? null),
          value_set_id: vsId,
        });
        await logToBus(client, "library", "pair-linked", msg, vsId);
        linked += 1;
      } catch (e) {
        console.warn("[auto-term] pair auto-link failed for", dep?.id, e);
      }
    }
    return linked;
  } catch (e) {
    console.warn("[auto-term] pair auto-link pass crashed", e);
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/*  Published value-set catalogue — shared by the proactive sweep and   */
/*  the staleness pass below (one query, two passes, per cycle).        */
/* ------------------------------------------------------------------ */

type SweepValueSetRow = MatchableValueSet & {
  id: string;
  published_at: string | null;
  change_history: Array<{ at?: string; change?: string }> | null;
};

async function loadPublishedValueSetsForSweep(
  client: MinimalUmlsClient,
): Promise<SweepValueSetRow[]> {
  try {
    const { data, error } = await client
      .from("custom_value_sets")
      .select("id, name, codes, published_at, change_history, status")
      .eq("status", "published");
    if (error || !data) return [];
    return data as SweepValueSetRow[];
  } catch (e) {
    console.warn("[auto-term] loadPublishedValueSetsForSweep failed", e);
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  NEW — Proactive sweep                                              */
/*  Gap-detection is otherwise purely event-driven (Safety Alerts       */
/*  Engine's Rule 1 reacts to new medication orders; Auto Doc/Auto      */
/*  Admin file gaps from their own triggers). That misses gaps in       */
/*  patients' EXISTING standing data that predates any trigger event    */
/*  — e.g. a patient admitted with a pre-existing med/allergy/condition */
/*  list that never went through the event path. This sweep runs the   */
/*  exact same value-set-membership / allergy-class matching Rule 1     */
/*  uses (imported from safety-alerts-matching.ts, not reimplemented)   */
/*  over a rotating, bounded batch of currently-admitted patients'      */
/*  standing conditions / medication_orders / allergies, and files a    */
/*  governed terminology_requests row — via the existing                */
/*  requestTerminologyUpdate(), reused rather than reimplemented — for  */
/*  any coverage gap found, tagged with requesting_consumer "Auto       */
/*  Terminologist · Proactive Sweep" so it's distinguishable in the UI  */
/*  from reactively-triggered gaps.                                    */
/* ------------------------------------------------------------------ */

const SWEEP_CONSUMER = "Auto Terminologist · Proactive Sweep";

export async function runProactiveSweepPass(
  client: MinimalUmlsClient,
  publishedVs: SweepValueSetRow[],
): Promise<{ patientsChecked: number; gapsFiled: number }> {
  let patientsChecked = 0;
  let gapsFiled = 0;
  try {
    const cutoff = new Date(Date.now() - SWEEP_RECHECK_MS).toISOString();
    const { data: candidates, error } = await client
      .from("patients")
      .select("mrn, terminology_sweep_checked_at")
      .eq("status", "Admitted")
      .or(`terminology_sweep_checked_at.is.null,terminology_sweep_checked_at.lt.${cutoff}`)
      .order("terminology_sweep_checked_at", { ascending: true, nullsFirst: true })
      .limit(SWEEP_BATCH_SIZE);
    if (error || !candidates) return { patientsChecked, gapsFiled };

    for (const p of candidates as Array<{ mrn: string }>) {
      const mrn = p.mrn;
      if (!mrn) continue;
      try {
        const [{ data: allergyRows }, { data: medRows }, { data: conditionRows }] =
          await Promise.all([
            client.from("allergies").select("substance").eq("mrn", mrn).eq("status", "active"),
            client
              .from("medication_orders")
              .select("rxnorm_code, rxnorm_display, drug_name, medication_name")
              .eq("mrn", mrn),
            client
              .from("conditions")
              .select("snomed_code, icd10_code, display_text")
              .eq("mrn", mrn)
              .eq("clinical_status", "active"),
          ]);

        const chartAllergies = ((allergyRows ?? []) as Array<{ substance: string | null }>)
          .map((r) => String(r?.substance ?? "").trim())
          .filter(Boolean);

        // --- A. Drug-Allergy coverage gap (standing meds, Rule 1 mirror) ---
        if (chartAllergies.length > 0) {
          for (const m of (medRows ?? []) as Array<{
            rxnorm_code: string | null;
            rxnorm_display: string | null;
            drug_name: string | null;
            medication_name: string | null;
          }>) {
            const code = String(m?.rxnorm_code ?? "").trim();
            const name = String(
              m?.rxnorm_display ?? m?.medication_name ?? m?.drug_name ?? "",
            ).trim();
            if (!code || !name) continue;
            const anyDrugVsHasCode = publishedVs.some((v) => extensionalContains(v, code));
            if (anyDrugVsHasCode) continue;
            await requestTerminologyUpdate(
              {
                requesting_consumer: SWEEP_CONSUMER,
                requested_name: `Drug-Allergy coverage for "${chartAllergies[0]}"`,
                justification: `Standing order "${name}" (RxNorm ${code}) on an admitted patient's chart could not be cross-checked against allergy "${chartAllergies[0]}" — no published value set contains this drug and names the allergy class. Found by the proactive sweep, not a new-order event.`,
                priority: "normal",
                vocabulary: "RxNorm",
                seed_codes: [{ code, display: name }],
                clinical_application: "CDS",
                related_mrn: mrn,
              },
              client,
            );
            gapsFiled += 1;
          }

          // --- B. Allergy-class coverage gap — no published value set even
          // names this allergy class, so Rule 1 could never fire for it
          // regardless of what gets ordered. ---
          for (const substance of chartAllergies) {
            const named = publishedVs.some((v) =>
              substanceMatchesClass(substance, classTokens(v.name)),
            );
            if (named) continue;
            await requestTerminologyUpdate(
              {
                requesting_consumer: SWEEP_CONSUMER,
                requested_name: `Allergy-class coverage for "${substance}"`,
                justification: `Active allergy "${substance}" on an admitted patient's chart is not named by any published drug-class value set — Drug-Allergy Conflict checking can never fire for this allergy until one exists.`,
                priority: "normal",
                vocabulary: "RxNorm",
                seed_codes: [],
                clinical_application: "CDS",
                related_mrn: mrn,
              },
              client,
            );
            gapsFiled += 1;
          }
        }

        // --- C. Standing condition coverage gap ---
        for (const c of (conditionRows ?? []) as Array<{
          snomed_code: string | null;
          icd10_code: string | null;
          display_text: string | null;
        }>) {
          const snomed = String(c?.snomed_code ?? "").trim();
          const icd10 = String(c?.icd10_code ?? "").trim();
          if (!snomed && !icd10) continue;
          const covered =
            (!!snomed && publishedVs.some((v) => extensionalContains(v, snomed))) ||
            (!!icd10 && publishedVs.some((v) => extensionalContains(v, icd10)));
          if (covered) continue;
          const display = String(c?.display_text ?? snomed ?? icd10 ?? "").trim();
          if (!display) continue;
          const code = snomed || icd10;
          const vocabulary = snomed ? "SNOMED CT" : "ICD-10";
          await requestTerminologyUpdate(
            {
              requesting_consumer: SWEEP_CONSUMER,
              requested_name: `Condition coverage for "${display}"`,
              justification: `Active condition "${display}" (${vocabulary} ${code}) on an admitted patient's chart is not contained in any published value set — value-set-keyed CDS rules (e.g. High-Acuity Triage, Sepsis Bundle) can never classify it.`,
              priority: "normal",
              vocabulary,
              seed_codes: [{ code, display }],
              clinical_application: "CDS",
              related_mrn: mrn,
            },
            client,
          );
          gapsFiled += 1;
        }

        patientsChecked += 1;
      } catch (e) {
        console.warn("[auto-term] proactive sweep failed for patient", mrn, e);
      } finally {
        // Advance the checkpoint regardless of outcome (found a gap, found
        // nothing, or errored) so a persistently-failing patient doesn't
        // monopolize every future cycle's batch.
        try {
          await client
            .from("patients")
            .update({ terminology_sweep_checked_at: new Date().toISOString() })
            .eq("mrn", mrn);
        } catch {
          /* best-effort only */
        }
      }
    }
  } catch (e) {
    console.warn("[auto-term] proactive sweep pass crashed", e);
  }
  return { patientsChecked, gapsFiled };
}

/* ------------------------------------------------------------------ */
/*  NEW — Value-set staleness ("due for review")                       */
/*  Flags published value sets that haven't been published or          */
/*  re-synced from VSAC in VALUE_SET_REVIEW_DUE_MS. Never re-syncs      */
/*  itself — the fix path is the existing human "Re-sync from VSAC"     */
/*  action in the Value Set Library; this only surfaces the flag.       */
/* ------------------------------------------------------------------ */

const staleFlagTracker = new Map<string, number>();

function lastReviewedAt(vs: SweepValueSetRow): number {
  let latest = vs.published_at ? new Date(vs.published_at).getTime() : 0;
  if (Array.isArray(vs.change_history)) {
    for (const entry of vs.change_history) {
      const change = String(entry?.change ?? "");
      if (!change.toLowerCase().startsWith("re-synced from vsac")) continue;
      const at = entry?.at ? new Date(entry.at).getTime() : 0;
      if (at > latest) latest = at;
    }
  }
  return latest;
}

export async function runValueSetStalenessPass(
  client: MinimalUmlsClient,
  publishedVs: SweepValueSetRow[],
): Promise<{ checked: number; dueForReview: number }> {
  let dueForReview = 0;
  const now = Date.now();
  for (const vs of publishedVs) {
    try {
      const reviewedAt = lastReviewedAt(vs);
      if (reviewedAt === 0) continue; // no published_at at all — nothing to compare
      if (now - reviewedAt < VALUE_SET_REVIEW_DUE_MS) continue;

      dueForReview += 1;
      const lastFlagged = staleFlagTracker.get(vs.id);
      if (lastFlagged && now - lastFlagged < STALE_RENOTIFY_MS) continue;

      const months = Math.floor((now - reviewedAt) / (30 * 24 * 60 * 60_000));
      const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const message = `${timeLabel} — "${vs.name}" hasn't been published or re-synced from VSAC in ~${months} month(s) — due for review (use "Re-sync from VSAC" in the Value Set Library to refresh it).`;
      await logActivity(client, {
        action: "review_due",
        message,
        theme: vs.name,
        value_set_id: vs.id,
      });
      await logToBus(client, "library", "review-due", message, vs.id);
      staleFlagTracker.set(vs.id, now);
    } catch (e) {
      console.warn("[auto-term] staleness check failed for value set", vs?.id, e);
    }
  }
  return { checked: publishedVs.length, dueForReview };
}

/* ------------------------------------------------------------------ */
/*  Cycle orchestration                                                 */
/* ------------------------------------------------------------------ */

export type CycleSummary = {
  ran: boolean;
  reason?: string;
  demand?: {
    recommended: number;
    gated: number;
    deprecationSuggested: number;
    rejected: number;
    scanned: number;
  };
  pairsLinked?: number;
  vsacPoll?: { checked: number; readyToImport: number };
  proactiveSweep?: { patientsChecked: number; gapsFiled: number };
  staleness?: { checked: number; dueForReview: number };
};

async function isAutomationEnabled(client: MinimalUmlsClient): Promise<boolean> {
  try {
    const { data, error } = await client
      .from("system_settings")
      .select("automation_enabled")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return true; // fail open, same default as the frontend flag
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data as any).automation_enabled !== false;
  } catch {
    return true;
  }
}

/**
 * Runs one full Auto Terminologist cycle. The CALLER is responsible for
 * claiming the `auto_terminologist` lease first (`claimLease`) — this
 * function assumes it already owns the lease for `holder` and keeps that
 * lease alive (`heartbeatLease` on a ~30s cadence) for as long as the
 * cycle takes, exactly as the original in-hook implementation did.
 */
export async function runAutoTerminologistCycle(
  client: MinimalUmlsClient,
  holder: string,
): Promise<CycleSummary> {
  const automationOn = await isAutomationEnabled(client);

  if (!automationOn) {
    await client.from("automation_watchdog_logs").insert({
      global_control_status: "OFF",
      engines_checked: { auto_terminologist: { skipped: "global automation off" } },
      issues_detected: false,
      actions_taken: "auto_terminologist: paused — global automation OFF.",
      healed_engines: [],
    });
    return { ran: false, reason: "automation-off" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enginesChecked: Record<string, any> = {};
  const actions: string[] = [];

  // Mid-cycle lease renewal — the demand pass and proactive sweep are both
  // unbounded-ish (loop over pending requests / a batch of patients, each
  // with its own network calls) and can run longer than LEADER_LEASE_MS. A
  // single heartbeatLease() call at one fixed point isn't enough to
  // guarantee that, so renew on a fixed ~30s cadence for the lifetime of
  // this cycle and clear it in `finally` on every exit path.
  const heartbeatIntervalId = setInterval(() => {
    void heartbeatLease(client, holder);
  }, 30_000);

  try {
    let demand = { recommended: 0, gated: 0, deprecationSuggested: 0, rejected: 0, scanned: 0 };
    try {
      demand = await processPendingTerminologyRequests(client);
    } catch (e) {
      console.warn("[auto-term] demand pass failed", e);
    }

    let pairsLinked = 0;
    try {
      pairsLinked = await runPairAutoLinkPass(client);
    } catch (e) {
      console.warn("[auto-term] pair auto-link pass failed", e);
    }

    let vsacPoll = { checked: 0, readyToImport: 0 };
    try {
      vsacPoll = await runVsacPublicationPollPass(client);
    } catch (e) {
      console.warn("[auto-term] vsac publication poll pass failed", e);
    }

    const publishedVs = await loadPublishedValueSetsForSweep(client);

    let proactiveSweep = { patientsChecked: 0, gapsFiled: 0 };
    try {
      proactiveSweep = await runProactiveSweepPass(client, publishedVs);
    } catch (e) {
      console.warn("[auto-term] proactive sweep pass failed", e);
    }

    let staleness = { checked: 0, dueForReview: 0 };
    try {
      staleness = await runValueSetStalenessPass(client, publishedVs);
    } catch (e) {
      console.warn("[auto-term] staleness pass failed", e);
    }

    const totalActed =
      demand.recommended + demand.gated + demand.deprecationSuggested + demand.rejected;
    const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    await logActivity(client, {
      action: totalActed === 0 ? "heartbeat" : "cycle_summary",
      message: `${timeLabel} — Scanned ${demand.scanned} pending request(s) — ${demand.recommended} recommendation(s) stamped, ${demand.gated} gated, ${demand.deprecationSuggested} deprecation(s) suggested, ${demand.rejected} rejected. Drug-Allergy pairs auto-linked: ${pairsLinked}. VSAC OIDs checked: ${vsacPoll.checked} (${vsacPoll.readyToImport} newly ready to import). Proactive sweep: ${proactiveSweep.patientsChecked} patient(s) checked, ${proactiveSweep.gapsFiled} gap(s) filed. Value sets due for review: ${staleness.dueForReview}/${staleness.checked}.`,
      codes_count: 0,
    });

    enginesChecked["auto_terminologist"] = {
      requests_scanned: demand.scanned,
      requests_recommended: demand.recommended,
      requests_gated: demand.gated,
      deprecation_suggested: demand.deprecationSuggested,
      requests_rejected: demand.rejected,
      drug_allergy_pairs_linked: pairsLinked,
      vsac_oids_checked: vsacPoll.checked,
      vsac_newly_ready_to_import: vsacPoll.readyToImport,
      proactive_sweep_patients_checked: proactiveSweep.patientsChecked,
      proactive_sweep_gaps_filed: proactiveSweep.gapsFiled,
      value_sets_due_for_review: staleness.dueForReview,
    };
    actions.push(
      `auto_terminologist: demand queue — scanned ${demand.scanned}, recommendation(s) stamped ${demand.recommended}, gated ${demand.gated}, deprecation-suggested ${demand.deprecationSuggested}, rejected ${demand.rejected}; drug-allergy pairs linked ${pairsLinked}; vsac OIDs checked ${vsacPoll.checked} (${vsacPoll.readyToImport} newly ready to import); proactive sweep ${proactiveSweep.patientsChecked} patient(s)/${proactiveSweep.gapsFiled} gap(s); ${staleness.dueForReview} value set(s) due for review.`,
    );

    await client.from("automation_watchdog_logs").insert({
      global_control_status: "ON",
      engines_checked: enginesChecked,
      issues_detected: false,
      actions_taken: actions.join(" "),
      healed_engines: [],
    });

    return { ran: true, demand, pairsLinked, vsacPoll, proactiveSweep, staleness };
  } finally {
    clearInterval(heartbeatIntervalId);
  }
}
