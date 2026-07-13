import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAutomationEnabled } from "@/hooks/useAutomationEnabled";

/**
 * Auto Terminologist — autonomous clinical terminologist agent.
 * --------------------------------------------------------------
 * Background loop (10 min cadence, leader-elected across tabs):
 *   1. Scans pending `terminology_requests` filed by consumer engines
 *      (Safety Alerts, Billing, Auto Doc, etc.) — VSAC-style demand mode.
 *   2. For `request_type = 'create'`, prefers an existing real value set
 *      via UMLS; otherwise runs the quality gate and drafts / merges into
 *      `custom_value_sets`.
 *   3. For `request_type = 'deprecate'`, flags the target value set as
 *      `deprecation-suggested` for a human to act on in the Value Set
 *      Library. Never auto-publishes or auto-retires anything.
 *   4. Logs human-readable activity to `auto_terminologist_log` (full
 *      audit trail) and mirrors material events (drafted / extended /
 *      deprecation-suggested / crossmap sanity-checks) onto the shared
 *      `terminology_activity_log` bus with actor "Auto Terminologist" so
 *      the Library / Authoring / Cross-Map activity panels show live
 *      automated activity alongside human actions. A cycle summary lands
 *      in `automation_watchdog_logs`.
 *
 *      Noise-suppression: noop / gated / rejected outcomes and
 *      UMLS-suggested-import staging are NOT mirrored to the shared bus
 *      — those stay confined to `auto_terminologist_log`.
 *
 * The engine NEVER submits for review and NEVER publishes — every drafted
 * value set lands in `status: "draft"`. Promotion to review / published
 * always requires a human action in the Value Set Library.
 */

const RUN_INTERVAL_MS = 10 * 60_000;
// Tick frequently and gate on DB-recorded last_run_at so cycles fire on time
// even when a background tab throttles setInterval or a leader tab is closed.
const TICK_MS = 60_000;
const LEADER_KEY = "spehr.autoterm.leader";
const LEADER_LEASE_MS = 3 * 60_000;
const TAB_ID = Math.random().toString(36).slice(2);

/** Read the last-run timestamp from the activity log (max run_at). */
async function getLastRunAt(): Promise<number | null> {
  try {
    const { data } = await supabase
      .from("auto_terminologist_log" as any)
      .select("run_at")
      .order("run_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ts = (data as any)?.run_at;
    return ts ? new Date(ts).getTime() : null;
  } catch {
    return null;
  }
}

function tryAcquireLeader(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    const now = Date.now();
    if (raw) {
      const { id, ts } = JSON.parse(raw);
      if (id !== TAB_ID && now - ts < LEADER_LEASE_MS) return false;
    }
    localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, ts: now }));
    return true;
  } catch {
    return false;
  }
}

const STOP_TAIL = new Set([
  "since", "for", "and", "or", "with", "of", "to", "the", "a", "an",
  "on", "in", "at", "by", "from", "productive", "started", "started.",
  "began", "ongoing", "worsening", "improving", "about", "over",
]);

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function cleanComplaintName(raw: string): string {
  // Strip trailing SNOMED semantic tags like "(finding)", "(disorder)", "(procedure)"
  let cleaned = raw.replace(/\s*\((finding|disorder|procedure|situation|observable entity|body structure|qualifier value|event|substance|product)\)\s*$/i, "");
  // Strip trailing ", unspecified" / ", NOS" / "not otherwise specified"
  cleaned = cleaned.replace(/,\s*(unspecified|not otherwise specified|nos)\.?\s*$/i, "");
  let words = cleaned.replace(/[^a-zA-Z0-9\s\/-]/g, " ").split(/\s+/).filter(Boolean);
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
/*  Library / Authoring / Cross-Map panels see automated activity.     */
/*  Uses actor "Auto Terminologist" (vs. human handlers' actor         */
/*  "S.P.E.H.R. Terminology Services") so reviewers can distinguish    */
/*  automated rows from manual ones at a glance.                       */
/* ------------------------------------------------------------------ */
async function logToBus(
  feature: "library" | "authoring" | "crossmap",
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
/*  Crosswalk sanity-check                                             */
/*  Best-effort UMLS crosswalk on newly-drafted codes, mirroring the   */
/*  Cross-Map Studio's use of umls-proxy `crosswalk`. Never fails the  */
/*  draft — always caught. Logs one consolidated crossmap bus row per  */
/*  value set (not per code).                                          */
/* ------------------------------------------------------------------ */
const CROSSWALK_SAB: Record<string, string> = {
  "SNOMED CT": "SNOMEDCT_US",
  "ICD-10": "ICD10CM",
  "RxNorm": "RXNORM",
  "LOINC": "LNC",
  "CPT": "CPT",
};

const CROSSWALK_TARGET: Record<string, string> = {
  "SNOMED CT": "ICD-10-CM",
  "ICD-10": "SNOMED CT",
  "RxNorm": "SNOMED CT",
  "LOINC": "CPT",
};

// Target-label → SAB (target labels use ICD-10-CM, not ICD-10)
const TARGET_SAB: Record<string, string> = {
  "SNOMED CT": "SNOMEDCT_US",
  "ICD-10-CM": "ICD10CM",
  "CPT": "CPT",
};

async function runCrosswalkSanityCheck(opts: {
  valueSetId: string | null;
  valueSetName: string;
  dominantVocab: string;
  codesToCheck: Array<{ code: string }>;
}): Promise<void> {
  try {
    const fromSab = CROSSWALK_SAB[opts.dominantVocab];
    const targetVocab = CROSSWALK_TARGET[opts.dominantVocab];
    const toSab = targetVocab ? TARGET_SAB[targetVocab] : undefined;
    if (!fromSab || !targetVocab || !toSab) return;

    const sample = opts.codesToCheck.slice(0, 3).filter((c) => c && c.code);
    if (sample.length === 0) return;

    let matches = 0;
    for (const c of sample) {
      try {
        const { data, error } = await supabase.functions.invoke("umls-proxy", {
          body: { action: "crosswalk", params: { fromSab, fromCode: c.code, toSab } },
        });
        if (error) continue;
        const hit = (data as any)?.result ?? (data as any)?.matches?.[0] ?? null;
        if (hit && (hit.code || (Array.isArray((data as any)?.matches) && (data as any).matches.length > 0))) {
          matches += 1;
        }
      } catch {
        /* per-code failure ignored — sanity check is best-effort */
      }
    }

    const msg = matches > 0
      ? `Cross-mapped ${sample.length} code(s) from '${opts.valueSetName}' (${opts.dominantVocab} → ${targetVocab}) during drafting — ${matches} equivalence(s) found.`
      : `Cross-mapped ${sample.length} code(s) from '${opts.valueSetName}' (${opts.dominantVocab} → ${targetVocab}) during drafting — no equivalences found in UMLS.`;
    await logToBus("crossmap", "cross-mapped", msg, opts.valueSetId);
  } catch (e) {
    console.warn("[auto-term] crosswalk sanity-check failed", e);
  }
}

function clinicalApplicationFor(theme: string): string {
  const t = theme.toLowerCase();
  if (/(diabet|heart failure|chf|copd|renal|chronic kidney|dialysis)/.test(t)) return "Billing";
  if (/(anticoag|antiplatelet|drug|allerg|contraindicat)/.test(t)) return "CDS";
  return "Population Health";
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/* ------------------------------------------------------------------ */
/*  Safe upsert — never downgrade published/review value sets          */
/* ------------------------------------------------------------------ */

type ValueSetPayload = {
  name: string;
  system: string;
  vocabulary: string;
  type: string;
  codes: Array<{ code: string; display: string; vocabulary: string }>;
  description: string;
  clinical_application: string;
  fhir_url: string;
  oid: string;
  changeEntry: { at: string; actor: string; change: string };
};

type SafeUpsertOutcome = {
  id: string | null;
  mode: "created" | "merged" | "replaced-draft" | "noop";
  addedCount: number;
  existingStatus: string | null;
};

/**
 * Upsert a value set WITHOUT ever downgrading an existing `published` or
 * `review` row back to `draft`. Behavior by existing state:
 *   - none         → insert as new draft (original behavior).
 *   - draft        → merge incoming codes into existing codes (dedupe by
 *                    code), keep status draft, append change_history.
 *   - review/published → keep status untouched, merge new codes only,
 *                    append change_history noting extension.
 */
async function safeUpsertValueSet(payload: ValueSetPayload): Promise<SafeUpsertOutcome> {
  const { data: existing, error: fetchErr } = await supabase
    .from("custom_value_sets")
    .select("id, status, codes, change_history")
    .eq("name", payload.name)
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  // No exact-name match: look for a substantively duplicate value set
  // in the same vocabulary whose codes overlap ≥50% with the payload.
  // If found, merge into it instead of creating a differently-named twin.
  let overlapMatch: any = null;
  if (!existing) {
    const incomingCodes = new Set(
      payload.codes.map((c) => String(c?.code ?? "").trim()).filter(Boolean),
    );
    if (incomingCodes.size > 0) {
      const { data: candidates } = await supabase
        .from("custom_value_sets")
        .select("id, name, status, codes, change_history")
        .eq("vocabulary", payload.vocabulary);
      const threshold = Math.ceil(incomingCodes.size * 0.5);
      let bestOverlap = 0;
      for (const row of ((candidates ?? []) as any[])) {
        const rowCodes: any[] = Array.isArray(row?.codes) ? row.codes : [];
        let overlap = 0;
        for (const c of rowCodes) {
          const k = String(c?.code ?? "").trim();
          if (k && incomingCodes.has(k)) overlap += 1;
        }
        if (overlap >= threshold && overlap > bestOverlap) {
          bestOverlap = overlap;
          overlapMatch = row;
        }
      }
    }
  }

  // No existing row and no code-overlap match — insert fresh draft.
  if (!existing && !overlapMatch) {
    const { data: inserted, error: insErr } = await supabase
      .from("custom_value_sets")
      .insert({
        name: payload.name,
        system: payload.system,
        vocabulary: payload.vocabulary,
        type: payload.type,
        codes: payload.codes,
        status: "draft",
        description: payload.description,
        clinical_application: payload.clinical_application,
        fhir_url: payload.fhir_url,
        oid: payload.oid,
        change_history: [payload.changeEntry],
      } as any)
      .select("id")
      .maybeSingle();
    if (insErr) throw insErr;
    return {
      id: (inserted as any)?.id ?? null,
      mode: "created",
      addedCount: payload.codes.length,
      existingStatus: null,
    };
  }

  const matchedByOverlap = !existing && !!overlapMatch;
  const existingRow = (existing ?? overlapMatch) as any;
  const existingStatus: string = String(existingRow.status ?? "draft");
  const existingCodes: Array<{ code?: string; display?: string; vocabulary?: string; system?: string }> =
    Array.isArray(existingRow.codes) ? existingRow.codes : [];
  const existingHistory: any[] = Array.isArray(existingRow.change_history) ? existingRow.change_history : [];

  // Annotate the change entry when we merged via code-overlap rather than
  // an exact name match, so reviewers can see why the request was folded
  // into a differently-named value set.
  const changeEntry = matchedByOverlap
    ? {
        ...payload.changeEntry,
        change: `${payload.changeEntry.change} — matched by code overlap with existing value set '${String(existingRow.name ?? "")}', not exact name match`,
      }
    : payload.changeEntry;

  // Merge codes (dedupe by trimmed `code`).
  const haveCodes = new Set(existingCodes.map((c) => String(c?.code ?? "").trim()).filter(Boolean));
  const additions = payload.codes.filter((c) => {
    const k = String(c.code ?? "").trim();
    return k && !haveCodes.has(k);
  });

  // Nothing new AND row is already published/review → don't even bump
  // updated_at, and don't add a noisy change_history entry.
  if (additions.length === 0 && (existingStatus === "published" || existingStatus === "review")) {
    return {
      id: existingRow.id ?? null,
      mode: "noop",
      addedCount: 0,
      existingStatus,
    };
  }

  const mergedCodes = additions.length > 0 ? [...existingCodes, ...additions] : existingCodes;
  const mergedHistory = [...existingHistory, changeEntry];

  const updatePatch: Record<string, unknown> = {
    codes: mergedCodes,
    change_history: mergedHistory,
    updated_at: new Date().toISOString(),
  };

  // CRITICAL: never write `status` for published/review rows — that's the
  // whole point of this helper. For drafts we also don't need to touch it
  // (already "draft").
  const { data: updated, error: updErr } = await supabase
    .from("custom_value_sets")
    .update(updatePatch as any)
    .eq("id", existingRow.id)
    .select("id")
    .maybeSingle();
  if (updErr) throw updErr;

  return {
    id: (updated as any)?.id ?? existingRow.id ?? null,
    mode: existingStatus === "draft" ? "replaced-draft" : "merged",
    addedCount: additions.length,
    existingStatus,
  };
}

/* ------------------------------------------------------------------ */
/*  Demand mode — terminology_requests quality gate + drafting         */
/* ------------------------------------------------------------------ */

type SeedCode = { code: string; display: string; vocabulary: string };

const VALID_VOCABS = new Set(["SNOMED CT", "ICD-10", "RxNorm", "LOINC"]);

function codeShapeMatches(vocab: string, code: string): boolean {
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
    return { ok: false, empty: true, notes: "No seed codes supplied — no scan match available yet" };
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  let missingDisp = 0, missingCode = 0, missingVocab = 0, badVocab = 0, badDisp = 0, dupCount = 0, badShape = 0;
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
  if (missingDisp) problems.push(`${missingDisp} of ${total} seed codes are missing a display name`);
  if (missingVocab) problems.push(`${missingVocab} of ${total} seed codes missing a vocabulary`);
  if (badVocab) problems.push(`${badVocab} seed code(s) use an unsupported vocabulary (must be SNOMED CT, ICD-10, RxNorm, or LOINC)`);
  if (badDisp) problems.push(`${badDisp} seed code display(s) are too short or non-descriptive`);
  if (dupCount) problems.push(`${dupCount} duplicate code value(s) within the request`);
  if (badShape) problems.push(`${badShape} seed code(s) don't match the shape expected for their declared vocabulary`);
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
  sab: string; vocabLabel: SeedCode["vocabulary"];
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
      body: { action: "search", params: { string: requestedName, sabs: sab, pageSize: 15, searchType: "words", returnIdType: "sourceUi" } },
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
  drafted: number;
  gated: number;
  deprecationSuggested: number;
  rejected: number;
  scanned: number;
}> {
  let drafted = 0;
  let gated = 0;
  let deprecationSuggested = 0;
  let rejected = 0;
  const { data: pending, error } = await supabase
    .from("terminology_requests" as any)
    .select(
      "id, requesting_consumer, requested_name, justification, priority, vocabulary, seed_codes, clinical_application, related_mrn, quality_gate_notes, request_type, target_value_set_id",
    )
    .eq("status", "pending");
  if (error || !pending) return { drafted, gated, deprecationSuggested, rejected, scanned: 0 };

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
          await supabase.from("terminology_requests" as any)
            .update({ quality_gate_notes: "Deprecation request missing target_value_set_id", updated_at: nowIso } as any)
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
          await supabase.from("terminology_requests" as any)
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
          await supabase.from("terminology_requests" as any)
            .update({
              status: "rejected",
              resolved_at: nowIso,
              updated_at: nowIso,
              quality_gate_notes: "Target is a draft — delete drafts directly instead of deprecating.",
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
            change: `Deprecation suggested — requested by ${req.requesting_consumer}: ${req.justification ?? ""}`.trim(),
          };
          await supabase
            .from("custom_value_sets")
            .update({
              status: "deprecation-suggested",
              change_history: [...history, entry],
              updated_at: nowIso,
            } as any)
            .eq("id", tRow.id);
          await supabase.from("terminology_requests" as any)
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
            message: `${timeLabel} — Deprecation suggested for '${tName}' (was ${tStatus}) — requested by ${req.requesting_consumer}: ${req.justification ?? ""}`.trim(),
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
        await supabase.from("terminology_requests" as any)
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

      const seedCodes: SeedCode[] = Array.isArray(req.seed_codes) ? (req.seed_codes as any[])
        .map((s) => ({
          code: String(s?.code ?? "").trim(),
          display: String(s?.display ?? "").trim(),
          vocabulary: String(s?.vocabulary ?? req.vocabulary ?? "").trim(),
        })) : [];

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

      // Gate passed — draft as a new value set, exactly mirroring the
      // opportunistic path's shape (status: draft, spehr OID, etc.).
      const dominantVocab = seedCodes[0].vocabulary;
      const codes = seedCodes.map((s) => ({
        code: s.code,
        display: s.display,
        vocabulary: s.vocabulary,
      }));
      const clinical_application =
        (typeof req.clinical_application === "string" && req.clinical_application.trim()) ||
        clinicalApplicationFor(requestedName);
      const now = new Date().toISOString();
      const nameSlug = slugify(requestedName);

      const outcome = await safeUpsertValueSet({
        name: requestedName,
        system: dominantVocab.replace(" ", "-"),
        vocabulary: dominantVocab,
        type: "extensional",
        codes,
        description: `Drafted in response to a terminology request from ${req.requesting_consumer}: ${req.justification ?? ""}`.trim(),
        clinical_application,
        fhir_url: `http://spehr.live/fhir/ValueSet/${nameSlug}`,
        oid: `2.16.840.1.113883.3.spehr.${Date.now()}`,
        changeEntry: {
          at: now,
          actor: "Auto Terminologist",
          change:
            `Extended by Auto Terminologist from a terminology_requests gap by ${req.requesting_consumer}: ${req.justification ?? ""}`.trim(),
        },
      });
      const valueSetId = outcome.id;

      // Reflect outcome on the request row.
      const nextRequestStatus =
        outcome.mode === "merged" ? "extended" : "drafted";
      await supabase
        .from("terminology_requests" as any)
        .update({
          status: nextRequestStatus,
          value_set_id: valueSetId,
          resolved_at: now,
          updated_at: now,
          quality_gate_notes: null,
        } as any)
        .eq("id", req.id);

      let activityAction = "drafted";
      let activityMessage =
        `${timeLabel} — Terminology request from ${req.requesting_consumer}: '${requestedName}' — drafted as new value set (status: draft — awaiting human review). ${req.justification ?? ""}`.trim();
      if (outcome.mode === "merged") {
        activityAction = "extended";
        activityMessage =
          `${timeLabel} — Terminology request from ${req.requesting_consumer}: '${requestedName}' already ${outcome.existingStatus} — merged ${outcome.addedCount} new code(s) into the existing value set instead of re-drafting it.`;
      } else if (outcome.mode === "noop") {
        activityAction = "extended";
        activityMessage =
          `${timeLabel} — Terminology request from ${req.requesting_consumer}: '${requestedName}' already ${outcome.existingStatus} and every requested code was already present — no changes made.`;
      } else if (outcome.mode === "replaced-draft") {
        activityAction = "drafted";
        activityMessage =
          `${timeLabel} — Terminology request from ${req.requesting_consumer}: '${requestedName}' — merged ${outcome.addedCount} new code(s) into existing draft value set.`;
      }

      await logActivity({
        action: activityAction,
        message: activityMessage,
        theme: requestedName,
        codes_count: codes.length,
        value_set_id: valueSetId,
      });

      // Mirror material outcomes onto the shared activity bus so
      // Library + Authoring panels see automated activity. Skip noop.
      if (outcome.mode === "created" || outcome.mode === "replaced-draft") {
        await logToBus("library", "drafted", activityMessage, valueSetId);
        await logToBus("authoring", "drafted", activityMessage, valueSetId);
      } else if (outcome.mode === "merged") {
        await logToBus("library", "extended", activityMessage, valueSetId);
        await logToBus("authoring", "extended", activityMessage, valueSetId);
      }

      // Best-effort crosswalk sanity-check on newly-added codes. For
      // "created" that's the first 3 of `codes`; for merged / replaced-
      // draft that's the first 3 of the incoming request codes as a
      // proxy for the actually-added set (safeUpsertValueSet already
      // guarantees addedCount > 0 for these modes — noop is filtered
      // above). Never blocks the draft.
      if (
        (outcome.mode === "created" ||
          outcome.mode === "merged" ||
          outcome.mode === "replaced-draft") &&
        outcome.addedCount > 0
      ) {
        void runCrosswalkSanityCheck({
          valueSetId,
          valueSetName: requestedName,
          dominantVocab,
          codesToCheck: codes.slice(0, 3),
        });
      }

      requestLogTracker.delete(String(req.id));
      drafted += 1;
    } catch (e) {
      console.warn("[auto-term] request processing failed", req?.id, e);
    }
  }

  return {
    drafted,
    gated,
    deprecationSuggested,
    rejected,
    scanned: rows.length,
  };
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

  // Demand-mode only: fulfill pending terminology_requests. There is no
  // opportunistic scanner anymore — Auto Terminologist behaves like VSAC.
  let demand = { drafted: 0, gated: 0, deprecationSuggested: 0, rejected: 0, scanned: 0 };
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
    demand.drafted + demand.gated + demand.deprecationSuggested + demand.rejected;
  const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  await logActivity({
    action: totalActed === 0 ? "heartbeat" : "cycle_summary",
    message: `${timeLabel} — Scanned ${demand.scanned} pending request(s) — ${demand.drafted} drafted, ${demand.gated} gated, ${demand.deprecationSuggested} deprecation(s) suggested, ${demand.rejected} rejected. Drug-Allergy pairs auto-linked: ${pairsLinked}.`,
    codes_count: 0,
  });

  enginesChecked["auto_terminologist"] = {
    requests_scanned: demand.scanned,
    requests_drafted: demand.drafted,
    requests_gated: demand.gated,
    deprecation_suggested: demand.deprecationSuggested,
    requests_rejected: demand.rejected,
    drug_allergy_pairs_linked: pairsLinked,
  };
  actions.push(
    `auto_terminologist: demand queue — scanned ${demand.scanned}, drafted ${demand.drafted}, gated ${demand.gated}, deprecation-suggested ${demand.deprecationSuggested}, rejected ${demand.rejected}; drug-allergy pairs linked ${pairsLinked}.`,
  );

  await supabase.from("automation_watchdog_logs").insert({
    global_control_status: "ON",
    engines_checked: enginesChecked,
    issues_detected: false,
    actions_taken: actions.join(" "),
    healed_engines: [],
  } as any);
}

export function useAutoTerminologist() {
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const tick = async () => {
      if (!tryAcquireLeader()) return;
      const last = await getLastRunAt();
      if (last && Date.now() - last < RUN_INTERVAL_MS) return;
      // Insert a heartbeat FIRST so last_run_at advances even if the cycle
      // errors mid-flight — prevents multi-hour drift.
      await supabase.from("auto_terminologist_log" as any).insert({
        message: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — Cycle started.`,
        action: "heartbeat",
      } as any).then(() => {}, () => {});
      runAutoTerminologistCycle().catch((e) =>
        console.warn("[auto-term] cycle failed", e),
      );
    };
    // Stagger first run by 25s so it doesn't race other boot tasks.
    const boot = setTimeout(tick, 25_000);
    const id = setInterval(tick, TICK_MS);
    return () => {
      clearTimeout(boot);
      clearInterval(id);
    };
  }, []);
}