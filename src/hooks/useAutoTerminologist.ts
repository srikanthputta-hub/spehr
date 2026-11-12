import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAutomationEnabled } from "@/hooks/useAutomationEnabled";
import { recommendDefinitionType } from "@/lib/value-set-registry";

/**
 * Auto Terminologist — autonomous clinical terminologist agent.
 * --------------------------------------------------------------
 * Background loop (10 min cadence, leader-elected across tabs):
 *   1. Scans pending `terminology_requests` filed by consumer engines
 *      (Safety Alerts, Billing, Auto Doc, etc.) — VSAC-style demand mode.
 *   2. For `request_type = 'create'`, prefers an existing real value set
 *      via UMLS (stages it as `umls-suggested` for human approval);
 *      otherwise runs the quality gate and, once it passes, calls the same
 *      `recommendDefinitionType()` helper the manual Suggestion Brief UI
 *      uses (`src/lib/value-set-registry.ts`, shared — not reimplemented
 *      here) to stamp `recommended_type` / `reasoning` /
 *      `suggested_root_concept` onto the request row. The request stays
 *      `pending` — this engine never creates or merges into
 *      `custom_value_sets` and never assigns a fabricated OID; a human
 *      steward still has to take the brief to real VSAC and either send it
 *      or import the real OID, same as the manual path.
 *   3. For `request_type = 'deprecate'`, flags the target value set as
 *      `deprecation-suggested` for a human to act on in the Value Set
 *      Library. Never auto-publishes or auto-retires anything.
 *   4. Logs human-readable activity to `auto_terminologist_log` (full
 *      audit trail) and mirrors material `custom_value_sets` events
 *      (deprecation-suggested) onto the shared `terminology_activity_log`
 *      bus with actor "Auto Terminologist" so the Library / Authoring /
 *      Cross-Map activity panels show live automated activity alongside
 *      human actions. A cycle summary lands in `automation_watchdog_logs`.
 *
 *      Noise-suppression: noop / gated / rejected outcomes,
 *      recommendation-stamping, and UMLS-suggested-import staging are NOT
 *      mirrored to the shared bus — those stay confined to
 *      `auto_terminologist_log` since no `custom_value_sets` row changed.
 *
 * The engine NEVER drafts a value set, NEVER submits for review, and NEVER
 * publishes. Every `custom_value_sets` write still requires a human action
 * (the Authoring Workbench, or importing a real OID via the Value Set
 * Library's "Import from VSAC" flow).
 */

const RUN_INTERVAL_MS = 10 * 60_000;
// Tick frequently and gate on DB-recorded last_run_at so cycles fire on time
// even when a background tab throttles setInterval or a leader tab is closed.
const TICK_MS = 60_000;
const LEADER_KEY = "spehr.autoterm.leader";
const LEADER_LEASE_MS = 3 * 60_000;
const TAB_ID = Math.random().toString(36).slice(2);

/* ------------------------------------------------------------------ */
/*  Atomic DB-backed lease (replaces the old localStorage              */
/*  tryAcquireLeader() read-then-write + getLastRunAt() check-then-act  */
/*  pair — see docs/leader-election-fix-design.md).                    */
/*                                                                      */
/*  *** PAIRED CHANGE ***                                               */
/*  These RPCs (claim_automation_lease / heartbeat_automation_lease)    */
/*  are defined in supabase/migrations/20260918000000_automation_leases */
/*  .sql, which is NOT yet applied to any Supabase project — it is a    */
/*  reviewable migration file only. This code path must not be deployed */
/*  ahead of that migration being applied to the target project: until  */
/*  then the RPCs don't exist, every claim/heartbeat call errors, and   */
/*  claimLease() below fails safe by returning false (tick() no-ops,    */
/*  same as "another tab is leader" today) — so it degrades safely but  */
/*  the engine simply never runs. Apply the migration first.            */
/*                                                                      */
/*  LEADER_KEY is no longer read or written — removing it from this     */
/*  file entirely is a separate follow-up commit per the design doc.    */
/*  TAB_ID is reused below as the lease `holder` identifier.            */
/* ------------------------------------------------------------------ */

/**
 * Atomically claim the auto_terminologist lease via a single UPDATE ...
 * WHERE ... RETURNING call in Postgres (claim_automation_lease). Zero rows
 * returned means another tab currently holds the lease or the cadence
 * interval hasn't elapsed — this cycle should be skipped. One row means
 * this tab now owns the cycle and `last_run_at` has already been advanced
 * atomically (same "heartbeat first, never drift" guarantee as before).
 */
export async function claimLease(): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc(
      "claim_automation_lease" as any,
      {
        _engine: "auto_terminologist",
        _holder: TAB_ID,
        _lease_ms: LEADER_LEASE_MS,
        _min_interval_ms: RUN_INTERVAL_MS,
      } as any,
    );
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
 * Best-effort mid-cycle lease renewal (heartbeat_automation_lease) so a
 * long-running cycle can't have its lease stolen by another tab before it
 * finishes. Never throws — a failed renewal just means the lease may lapse
 * and another tab could pick up the *next* cycle, which is an acceptable
 * degradation, not a correctness bug.
 */
export async function heartbeatLease(): Promise<void> {
  try {
    const { error } = await supabase.rpc(
      "heartbeat_automation_lease" as any,
      {
        _engine: "auto_terminologist",
        _holder: TAB_ID,
        _lease_ms: LEADER_LEASE_MS,
      } as any,
    );
    if (error) console.warn("[auto-term] heartbeat_automation_lease failed", error);
  } catch (e) {
    console.warn("[auto-term] heartbeat_automation_lease threw", e);
  }
}

/**
 * Best-effort release on unmount, purely as an optimisation (per the design
 * doc) — never awaited, never lets cleanup depend on it succeeding. Reuses
 * heartbeat_automation_lease with a negative lease so `leased_until` moves
 * into the past, making the row immediately claimable by the next tab
 * rather than making that tab wait out the full TTL.
 */
export function releaseLeaseBestEffort(): void {
  try {
    // supabase-js query/rpc builders are thenables — the HTTP request is
    // only actually sent once `.then()` (or `.catch()`) is called on them.
    // A bare `void supabase.rpc(...)` never fires the request at all. Chain
    // a no-op `.then()` so it executes, without awaiting it here — React
    // cleanup functions can't be async and this must stay fire-and-forget.
    supabase
      .rpc(
        "heartbeat_automation_lease" as any,
        {
          _engine: "auto_terminologist",
          _holder: TAB_ID,
          _lease_ms: -1000,
        } as any,
      )
      .then(
        () => {},
        () => {},
      );
  } catch {
    /* best-effort only — cleanup must not depend on this */
  }
}

const STOP_TAIL = new Set([
  "since",
  "for",
  "and",
  "or",
  "with",
  "of",
  "to",
  "the",
  "a",
  "an",
  "on",
  "in",
  "at",
  "by",
  "from",
  "productive",
  "started",
  "started.",
  "began",
  "ongoing",
  "worsening",
  "improving",
  "about",
  "over",
]);

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function cleanComplaintName(raw: string): string {
  // Strip trailing SNOMED semantic tags like "(finding)", "(disorder)", "(procedure)"
  let cleaned = raw.replace(
    /\s*\((finding|disorder|procedure|situation|observable entity|body structure|qualifier value|event|substance|product)\)\s*$/i,
    "",
  );
  // Strip trailing ", unspecified" / ", NOS" / "not otherwise specified"
  cleaned = cleaned.replace(/,\s*(unspecified|not otherwise specified|nos)\.?\s*$/i, "");
  const words = cleaned
    .replace(/[^a-zA-Z0-9\s\/-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Trim trailing stop / preposition / conjunction fragments
  while (words.length > 1 && STOP_TAIL.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  if (words.length === 0) return "General Clinical";
  // No character/word cap — preserve full clinical concept so downstream
  // UMLS lookups don't get mid-word truncation (e.g. "Chest Pressur").
  return titleCase(words.join(" "));
}

async function logActivity(opts: {
  message: string;
  value_set_id?: string | null;
  confidence?: number | null;
  action: string;
  theme?: string | null;
  codes_count?: number | null;
}) {
  try {
    await supabase.from("auto_terminologist_log" as any).insert({
      message: opts.message,
      value_set_id: opts.value_set_id ?? null,
      confidence: opts.confidence ?? null,
      action: opts.action,
      theme: opts.theme ?? null,
      codes_count: opts.codes_count ?? null,
    } as any);
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
  feature: "library" | "crossmap",
  action: string,
  message: string,
  ref_id?: string | null,
) {
  try {
    await supabase.from("terminology_activity_log" as any).insert({
      feature,
      actor: "Auto Terminologist",
      action,
      message,
      ref_id: ref_id ?? null,
    } as any);
  } catch (e) {
    console.warn("[auto-term] bus log failed", feature, action, e);
  }
}

/* ------------------------------------------------------------------ */
/*  Demand mode — terminology_requests quality gate + recommendation   */
/* ------------------------------------------------------------------ */

type SeedCode = { code: string; display: string; vocabulary: string };

const VALID_VOCABS = new Set(["SNOMED CT", "ICD-10", "RxNorm", "LOINC"]);

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
// every 60s tick — key = request id, value = last log timestamp + notes.
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
 * plausible set (≥3 coded matches in a real vocabulary), record the
 * suggestion on the request row and skip self-authoring — the terminologist
 * can approve the import from the Auto Terminologist Activity panel.
 *
 * Returns true when a suggestion was staged (caller should skip drafting).
 */
async function tryUmlsSuggestion(req: any): Promise<boolean> {
  const requestedName = String(req?.requested_name ?? "").trim();
  if (!requestedName) return false;
  const { sab, vocabLabel } = pickSabForRequest(req?.vocabulary);

  try {
    const { data, error } = await supabase.functions.invoke("umls-proxy", {
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
    await supabase
      .from("terminology_requests" as any)
      .update({
        status: "umls-suggested",
        seed_codes: codes,
        vocabulary: vocabLabel,
        quality_gate_notes: notes,
        updated_at: now,
      } as any)
      .eq("id", req.id);

    const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    await logActivity({
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

async function processPendingTerminologyRequests(): Promise<{
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
  const { data: pending, error } = await supabase
    .from("terminology_requests" as any)
    .select(
      "id, requesting_consumer, requested_name, justification, priority, vocabulary, seed_codes, clinical_application, related_mrn, quality_gate_notes, request_type, target_value_set_id, requested_at, recommended_type",
    )
    .eq("status", "pending");
  if (error || !pending) return { recommended, gated, deprecationSuggested, rejected, scanned: 0 };

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
          await supabase
            .from("terminology_requests" as any)
            .update({
              quality_gate_notes: "Deprecation request missing target_value_set_id",
              updated_at: nowIso,
            } as any)
            .eq("id", req.id);
          await logActivity({
            action: "gated",
            message: `${timeLabel} — Deprecation request from ${req.requesting_consumer} rejected: no target_value_set_id supplied.`,
            theme: requestedName || null,
          });
          continue;
        }
        const { data: target, error: targetErr } = await supabase
          .from("custom_value_sets")
          .select("id, name, status, change_history")
          .eq("id", targetId)
          .maybeSingle();
        if (targetErr || !target) {
          gated += 1;
          await supabase
            .from("terminology_requests" as any)
            .update({ quality_gate_notes: "Target value set not found", updated_at: nowIso } as any)
            .eq("id", req.id);
          await logActivity({
            action: "gated",
            message: `${timeLabel} — Deprecation request from ${req.requesting_consumer} rejected: target value set ${targetId} not found.`,
            theme: requestedName || null,
          });
          continue;
        }
        const tRow = target as any;
        const tStatus = String(tRow.status ?? "draft");
        const tName = String(tRow.name ?? "");
        if (tStatus === "draft") {
          rejected += 1;
          await supabase
            .from("terminology_requests" as any)
            .update({
              status: "rejected",
              resolved_at: nowIso,
              updated_at: nowIso,
              quality_gate_notes:
                "Target is a draft — delete drafts directly instead of deprecating.",
            } as any)
            .eq("id", req.id);
          await logActivity({
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
          await supabase
            .from("custom_value_sets")
            .update({
              status: "deprecation-suggested",
              change_history: [...history, entry],
              updated_at: nowIso,
            } as any)
            .eq("id", tRow.id);
          await supabase
            .from("terminology_requests" as any)
            .update({
              status: "drafted",
              value_set_id: tRow.id,
              resolved_at: nowIso,
              updated_at: nowIso,
              quality_gate_notes: null,
            } as any)
            .eq("id", req.id);
          await logActivity({
            action: "deprecation-suggested",
            message:
              `${timeLabel} — Deprecation suggested for '${tName}' (was ${tStatus}) — requested by ${req.requesting_consumer}: ${req.justification ?? ""}`.trim(),
            theme: tName,
            value_set_id: tRow.id ?? null,
          });
          await logToBus(
            "library",
            "deprecation-suggested",
            `${timeLabel} — Deprecation suggested for '${tName}' (was ${tStatus}) — requested by ${req.requesting_consumer}: ${req.justification ?? ""}`.trim(),
            tRow.id ?? null,
          );
          deprecationSuggested += 1;
          continue;
        }
        // Any other status (e.g. already deprecation-suggested / retired) — no-op
        await supabase
          .from("terminology_requests" as any)
          .update({
            status: "rejected",
            resolved_at: nowIso,
            updated_at: nowIso,
            quality_gate_notes: `Target value set is '${tStatus}' — no deprecation action taken.`,
          } as any)
          .eq("id", req.id);
        rejected += 1;
        continue;
      }

      // ---------------- Create branch (default) ----------------
      if (!requestedName) continue;

      // UMLS-first: prefer an existing real value set over self-authoring.
      // If UMLS returns a plausible match, stage it as a suggestion and
      // let a human terminologist approve the import from the panel.
      const suggested = await tryUmlsSuggestion(req);
      if (suggested) {
        requestLogTracker.delete(String(req.id));
        continue;
      }

      const seedCodes: SeedCode[] = Array.isArray(req.seed_codes)
        ? (req.seed_codes as any[]).map((s) => ({
            code: String(s?.code ?? "").trim(),
            display: String(s?.display ?? "").trim(),
            vocabulary: String(s?.vocabulary ?? req.vocabulary ?? "").trim(),
          }))
        : [];

      const gate = runQualityGate(seedCodes, req.vocabulary);

      if (!gate.ok) {
        gated += 1;
        // Update the request row so humans can see why it was held.
        await supabase
          .from("terminology_requests" as any)
          .update({ quality_gate_notes: gate.notes, updated_at: new Date().toISOString() } as any)
          .eq("id", req.id);

        // Log to activity, but no more than once per RUN_INTERVAL_MS per request
        // unless the failure reason has changed.
        const prev = requestLogTracker.get(String(req.id));
        const changed = !prev || prev.notes !== gate.notes;
        const stale = !prev || Date.now() - prev.loggedAt >= RUN_INTERVAL_MS;
        if (changed || stale) {
          await logActivity({
            action: "requested",
            message: `${timeLabel} — Terminology request from ${req.requesting_consumer}: '${requestedName}' — quality gate failed: ${gate.notes}`,
            theme: requestedName,
            codes_count: seedCodes.length,
          });
          requestLogTracker.set(String(req.id), { loggedAt: Date.now(), notes: gate.notes });
        }
        continue;
      }

      // Gate passed. If this request hasn't been given a recommendation
      // yet, stamp one — the same recommendDefinitionType() helper the
      // manual Suggestion Brief UI uses (src/lib/value-set-registry.ts,
      // shared — not reimplemented here) — onto the terminology_requests
      // row and stop. This NEVER creates or merges into
      // `custom_value_sets` and NEVER assigns a fabricated OID: that was
      // exactly the "spehr invents its own value sets" pattern PR #56
      // removed from the manual UI, and this closes the same gap for the
      // autonomous path. The request stays `pending` — the status the
      // Suggestion Brief UI treats as actionable — so a human steward
      // still has to take the brief to real VSAC and either "Mark as Sent
      // to VSAC" or import the real OID once it's authored.
      if (req.recommended_type) {
        // Already stamped on an earlier cycle — nothing left for this
        // engine to do until a human acts on it via the brief.
        requestLogTracker.delete(String(req.id));
        continue;
      }

      const dominantVocab = seedCodes[0].vocabulary;
      const now = new Date().toISOString();
      const recommendation = await recommendDefinitionType({
        vocabulary: dominantVocab,
        candidates: seedCodes.map((s) => ({
          code: s.code,
          display: s.display,
          vocabulary: s.vocabulary,
        })),
      });

      await supabase
        .from("terminology_requests" as any)
        .update({
          recommended_type: recommendation.recommendedType,
          reasoning: recommendation.reasoning,
          suggested_root_concept: recommendation.suggestedRootConcept ?? null,
          quality_gate_notes: null,
          updated_at: now,
        } as any)
        .eq("id", req.id);

      const activityMessage =
        `${timeLabel} — Terminology request from ${req.requesting_consumer}: '${requestedName}' — quality gate passed; stamped a ${recommendation.recommendedType} recommendation for the Suggestion Brief (no value set created — awaiting human review and authoring in VSAC). ${req.justification ?? ""}`.trim();

      await logActivity({
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
        await supabase
          .from("terminology_requests" as any)
          .update({ quality_gate_notes: errorNote, updated_at: new Date().toISOString() } as any)
          .eq("id", req.id);
        await logActivity({
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
/*  Drug-Allergy pair auto-link pass                                   */
/*  Wires up value_set_dependencies rows with NULL value_set_id when   */
/*  a matching PUBLISHED custom_value_sets row exists by exact name.   */
/*  Never touches draft/review rows and never re-links.                */
/* ------------------------------------------------------------------ */
async function runPairAutoLinkPass(): Promise<number> {
  try {
    const { data: unlinked, error } = await supabase
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
    for (const dep of unlinked as any[]) {
      const name = String(dep?.value_set_name ?? "").trim();
      if (!name) continue;
      try {
        // Use .limit(1) instead of .maybeSingle() — maybeSingle throws when
        // more than one row matches, which would kill the whole cycle if any
        // duplicate-named published rows ever slipped in.
        const { data: vsRows, error: vsErr } = await supabase
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
        const vsId = (vs as any).id as string;
        const { error: updErr } = await supabase
          .from("value_set_dependencies")
          .update({ value_set_id: vsId, updated_at: new Date().toISOString() } as any)
          .eq("id", dep.id);
        if (updErr) {
          console.warn("[auto-term] pair link update failed", dep?.id, updErr);
          continue;
        }

        const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const msg = `${timeLabel} — Activated Drug-Allergy pair '${dep.purpose}' (${dep.lookup_mode} side) — linked published value set '${name}'.`;
        await logActivity({
          action: "pair-linked",
          message: msg,
          theme: String(dep.purpose ?? null),
          value_set_id: vsId,
        });
        await logToBus("library", "pair-linked", msg, vsId);
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

async function runAutoTerminologistCycle() {
  const automationOn = await getAutomationEnabled();

  const enginesChecked: Record<string, any> = {};
  const actions: string[] = [];

  if (!automationOn) {
    await supabase.from("automation_watchdog_logs").insert({
      global_control_status: "OFF",
      engines_checked: { auto_terminologist: { skipped: "global automation off" } },
      issues_detected: false,
      actions_taken: "auto_terminologist: paused — global automation OFF.",
      healed_engines: [],
    } as any);
    return;
  }

  // Mid-cycle lease renewal — the demand pass below is unbounded (loops
  // over every pending request, each with its own UMLS network calls) and
  // can easily run longer than LEADER_LEASE_MS. A single
  // heartbeatLease() call at one fixed point isn't enough to guarantee that.
  // Instead, renew on a fixed ~30s cadence for the entire lifetime of this
  // cycle, independent of what the cycle is doing, and clear it in the
  // `finally` below on every exit path (success, error, or early return)
  // so it can never leak. See docs/leader-election-fix-design.md.
  const heartbeatIntervalId = setInterval(() => {
    void heartbeatLease();
  }, 30_000);

  try {
    // Demand-mode only: fulfill pending terminology_requests. There is no
    // opportunistic scanner anymore — Auto Terminologist behaves like VSAC.
    let demand = { recommended: 0, gated: 0, deprecationSuggested: 0, rejected: 0, scanned: 0 };
    try {
      demand = await processPendingTerminologyRequests();
    } catch (e) {
      console.warn("[auto-term] demand pass failed", e);
    }

    // Pair auto-link pass: wire up any value_set_dependencies rows whose
    // matching published `custom_value_sets` row now exists but that were
    // registered before the value set was published. Only ever touches
    // NULL value_set_id rows — never re-links or downgrades.
    let pairsLinked = 0;
    try {
      pairsLinked = await runPairAutoLinkPass();
    } catch (e) {
      console.warn("[auto-term] pair auto-link pass failed", e);
    }

    const totalActed =
      demand.recommended + demand.gated + demand.deprecationSuggested + demand.rejected;
    const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    await logActivity({
      action: totalActed === 0 ? "heartbeat" : "cycle_summary",
      message: `${timeLabel} — Scanned ${demand.scanned} pending request(s) — ${demand.recommended} recommendation(s) stamped, ${demand.gated} gated, ${demand.deprecationSuggested} deprecation(s) suggested, ${demand.rejected} rejected. Drug-Allergy pairs auto-linked: ${pairsLinked}.`,
      codes_count: 0,
    });

    enginesChecked["auto_terminologist"] = {
      requests_scanned: demand.scanned,
      requests_recommended: demand.recommended,
      requests_gated: demand.gated,
      deprecation_suggested: demand.deprecationSuggested,
      requests_rejected: demand.rejected,
      drug_allergy_pairs_linked: pairsLinked,
    };
    actions.push(
      `auto_terminologist: demand queue — scanned ${demand.scanned}, recommendation(s) stamped ${demand.recommended}, gated ${demand.gated}, deprecation-suggested ${demand.deprecationSuggested}, rejected ${demand.rejected}; drug-allergy pairs linked ${pairsLinked}.`,
    );

    await supabase.from("automation_watchdog_logs").insert({
      global_control_status: "ON",
      engines_checked: enginesChecked,
      issues_detected: false,
      actions_taken: actions.join(" "),
      healed_engines: [],
    } as any);
  } finally {
    clearInterval(heartbeatIntervalId);
  }
}

export function useAutoTerminologist() {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const tick = async () => {
      // Single atomic claim replaces the old localStorage leader check +
      // getLastRunAt() cadence check (two separate check-then-act races).
      // Zero rows / false = another tab holds the lease or the interval
      // hasn't elapsed — skip this cycle, same outcome as before.
      const claimed = await claimLease();
      if (!claimed) return;
      // last_run_at was already advanced atomically inside the claim RPC
      // (same "advance before running" anti-drift guarantee as the old
      // pre-cycle heartbeat insert). This log insert is just the audit-trail
      // row, not part of the gating logic anymore.
      await supabase
        .from("auto_terminologist_log" as any)
        .insert({
          message: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — Cycle started.`,
          action: "heartbeat",
        } as any)
        .then(
          () => {},
          () => {},
        );
      runAutoTerminologistCycle().catch((e) => console.warn("[auto-term] cycle failed", e));
    };
    // Stagger first run by 25s so it doesn't race other boot tasks.
    const boot = setTimeout(tick, 25_000);
    const id = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(boot);
      clearInterval(id);
      // Best-effort lease release — purely an optimisation so another tab
      // doesn't have to wait out the full TTL. Never blocks unmount.
      releaseLeaseBestEffort();
    };
  }, []);
}
