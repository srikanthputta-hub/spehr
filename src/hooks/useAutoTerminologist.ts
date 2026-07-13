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
 *   4. Logs human-readable activity to `auto_terminologist_log` +
 *      `terminology_activity_log`, plus a cycle summary to
 *      `automation_watchdog_logs`.
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

/** Derive a clean clinical theme label from the dominant validated concept. */
function deriveThemeName(
  fallbackTheme: string,
  validated: Array<{ code: string; display: string; vocabulary: string }>,
  occurrences: Map<string, number>,
): string {
  // Rank concepts (SNOMED/ICD preferred) by frequency
  const clinical = validated.filter((v) => v.vocabulary === "SNOMED CT" || v.vocabulary === "ICD-10");
  const pool = clinical.length > 0 ? clinical : validated;
  const ranked = [...pool].sort((a, b) => {
    const na = occurrences.get(`${a.vocabulary}|${a.code}`) ?? 0;
    const nb = occurrences.get(`${b.vocabulary}|${b.code}`) ?? 0;
    return nb - na;
  });
  const top = ranked[0]?.display?.trim();
  let base: string;
  if (top && top.length > 2 && !/^\d+$/.test(top)) {
    base = cleanComplaintName(top);
  } else {
    base = cleanComplaintName(fallbackTheme);
  }
  // Preserve the full concept name — no character truncation.
  return `${base} (Auto)`;
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

/** Pull recent codes from each clinical table joined to a patient row. */
async function collectRecentCodes(): Promise<{ hits: CodeHit[]; admissions: number }> {
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();
  const { data: pts } = await supabase
    .from("patients")
    .select("mrn, chief_complaint, admission_time, updated_at")
    .or(`admission_time.gte.${since},updated_at.gte.${since}`)
    .limit(500);
  const patients = (pts ?? []) as Array<{ mrn: string; chief_complaint: string | null }>;
  if (patients.length === 0) return { hits: [], admissions: 0 };
  const mrns = patients.map((p) => p.mrn);
  const themeByMrn = new Map<string, string>();
  for (const p of patients) themeByMrn.set(p.mrn, themeFromText(p.chief_complaint));

  const [conds, meds, labs] = await Promise.all([
    supabase.from("conditions").select("mrn, icd10_code, snomed_code, display_text, snomed_display, icd10_display").in("mrn", mrns).limit(2000),
    supabase.from("medication_orders").select("patient_mrn, rxnorm_code, drug_name").in("patient_mrn", mrns).limit(2000),
    supabase.from("lab_orders").select("patient_mrn, loinc_code, test_type").in("patient_mrn", mrns).limit(2000),
  ]);

  const hits: CodeHit[] = [];
  for (const c of (conds.data ?? []) as any[]) {
    const theme = themeByMrn.get(c.mrn) ?? themeFromText(c.display_text);
    if (c.snomed_code) hits.push({ code: String(c.snomed_code), vocab: "SNOMED CT", display: c.snomed_display || c.display_text, theme });
    if (c.icd10_code) hits.push({ code: String(c.icd10_code), vocab: "ICD-10", display: c.icd10_display || c.display_text, theme });
  }
  for (const m of (meds.data ?? []) as any[]) {
    if (!m.rxnorm_code) continue;
    const theme = themeByMrn.get(m.patient_mrn) ?? themeFromText(m.drug_name);
    hits.push({ code: String(m.rxnorm_code), vocab: "RxNorm", display: m.drug_name, theme });
  }
  for (const l of (labs.data ?? []) as any[]) {
    if (!l.loinc_code) continue;
    const theme = themeByMrn.get(l.patient_mrn) ?? themeFromText(l.test_type);
    hits.push({ code: String(l.loinc_code), vocab: "LOINC", display: l.test_type, theme });
  }
  return { hits, admissions: patients.length };
}

// Vocab label → UMLS SAB for crosswalk calls (mirrors CrossMapStudio.tsx)
const VOCAB_TO_SAB: Record<string, string> = {
  "SNOMED CT": "SNOMEDCT_US",
  "ICD-10": "ICD10CM",
  "LOINC": "LNC",
  "RxNorm": "RXNORM",
};

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

  // No existing row — insert fresh draft.
  if (!existing) {
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

  const existingRow = existing as any;
  const existingStatus: string = String(existingRow.status ?? "draft");
  const existingCodes: Array<{ code?: string; display?: string; vocabulary?: string; system?: string }> =
    Array.isArray(existingRow.codes) ? existingRow.codes : [];
  const existingHistory: any[] = Array.isArray(existingRow.change_history) ? existingRow.change_history : [];

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
  const mergedHistory = [...existingHistory, payload.changeEntry];

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

/** Loose case-insensitive substring match in either direction. */
function looselyMatches(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/** Try to satisfy an empty-seed request from the current cycle's scan gaps. */
function findScanMatchForRequest(
  requestedName: string,
  byTheme: Map<string, Array<{ hit: CodeHit; n: number }>>,
): SeedCode[] | null {
  for (const [theme, group] of byTheme) {
    if (group.length === 0) continue;
    const themeMatches = looselyMatches(theme, requestedName);
    const displayMatch = group.find((g) =>
      looselyMatches(g.hit.display ?? g.hit.code, requestedName),
    );
    if (!themeMatches && !displayMatch) continue;
    return group.map((g) => ({
      code: g.hit.code,
      display: g.hit.display ?? g.hit.code,
      vocabulary: g.hit.vocab,
    }));
  }
  return null;
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

async function processPendingTerminologyRequests(
  byTheme: Map<string, Array<{ hit: CodeHit; n: number }>>,
): Promise<{ drafted: number; gated: number }> {
  let drafted = 0;
  let gated = 0;
  const { data: pending, error } = await supabase
    .from("terminology_requests" as any)
    .select(
      "id, requesting_consumer, requested_name, justification, priority, vocabulary, seed_codes, clinical_application, related_mrn, quality_gate_notes",
    )
    .eq("status", "pending");
  if (error || !pending) return { drafted, gated };

  const rows = [...(pending as any[])].sort((a, b) => {
    const dp = normalizePriority(a.priority) - normalizePriority(b.priority);
    if (dp !== 0) return dp;
    return String(a.requested_at ?? "").localeCompare(String(b.requested_at ?? ""));
  });

  for (const req of rows) {
    try {
      const requestedName = String(req.requested_name ?? "").trim();
      if (!requestedName) continue;

      // UMLS-first: prefer an existing real value set over self-authoring.
      // If UMLS returns a plausible match, stage it as a suggestion and
      // let a human terminologist approve the import from the panel.
      const suggested = await tryUmlsSuggestion(req);
      if (suggested) {
        requestLogTracker.delete(String(req.id));
        continue;
      }

      let seedCodes: SeedCode[] = Array.isArray(req.seed_codes) ? (req.seed_codes as any[])
        .map((s) => ({
          code: String(s?.code ?? "").trim(),
          display: String(s?.display ?? "").trim(),
          vocabulary: String(s?.vocabulary ?? req.vocabulary ?? "").trim(),
        })) : [];

      // Fallback: try to satisfy an empty-seed request from this cycle's scan gaps
      if (seedCodes.length === 0) {
        const match = findScanMatchForRequest(requestedName, byTheme);
        if (match) seedCodes = match;
      }

      const gate = runQualityGate(seedCodes, req.vocabulary);
      const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
      requestLogTracker.delete(String(req.id));
      drafted += 1;
    } catch (e) {
      console.warn("[auto-term] request processing failed", req?.id, e);
    }
  }

  return { drafted, gated };
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

  const { hits, admissions } = await collectRecentCodes();

  // Frequency count per (code|vocab)
  const freq = new Map<string, { hit: CodeHit; n: number; themes: Map<string, number> }>();
  for (const h of hits) {
    const k = `${h.vocab}|${h.code}`;
    const cur = freq.get(k) ?? { hit: h, n: 0, themes: new Map() };
    cur.n += 1;
    if (h.theme) cur.themes.set(h.theme, (cur.themes.get(h.theme) ?? 0) + 1);
    freq.set(k, cur);
  }

  // Existing coverage set (read-only — used to identify gaps, never written)
  const { data: existingSets } = await supabase
    .from("custom_value_sets")
    .select("id, name, codes");
  const covered = new Set<string>();
  for (const s of (existingSets ?? []) as any[]) {
    const codes = Array.isArray(s.codes) ? s.codes : [];
    for (const c of codes) {
      const code = String(c?.code ?? "").trim();
      const vocab = String(c?.vocabulary ?? c?.system ?? "").trim();
      if (code) covered.add(`${vocab}|${code}`);
    }
  }

  // Coverage gaps (>=3 occurrences and not covered)
  const gaps: Array<{ hit: CodeHit; n: number; theme: string }> = [];
  for (const [k, v] of freq) {
    if (v.n < 3) continue;
    if (covered.has(k)) continue;
    const theme = [...v.themes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "General Clinical";
    gaps.push({ hit: v.hit, n: v.n, theme });
  }

  // Group gaps by theme
  const byTheme = new Map<string, Array<{ hit: CodeHit; n: number }>>();
  for (const g of gaps) {
    const arr = byTheme.get(g.theme) ?? [];
    arr.push({ hit: g.hit, n: g.n });
    byTheme.set(g.theme, arr);
  }

  // Demand-mode pass: fulfill pending terminology_requests before the
  // opportunistic drafter runs. Failures are non-fatal.
  let demand = { drafted: 0, gated: 0 };
  try {
    demand = await processPendingTerminologyRequests(byTheme);
  } catch (e) {
    console.warn("[auto-term] demand pass failed", e);
  }

  let touchedCount = 0;

  // Autonomous drafter: for each qualifying themed cluster, draft a new
  // extensional value set into custom_value_sets (status: "draft" only).
  for (const [theme, group] of byTheme) {
    if (group.length < 2) continue;

    try {
      const occMap = new Map<string, number>();
      const validatedForNaming: Array<{ code: string; display: string; vocabulary: string }> = [];
      const vocabCount: Record<string, number> = {};
      for (const g of group) {
        occMap.set(`${g.hit.vocab}|${g.hit.code}`, g.n);
        vocabCount[g.hit.vocab] = (vocabCount[g.hit.vocab] ?? 0) + 1;
        validatedForNaming.push({
          code: g.hit.code,
          display: g.hit.display ?? g.hit.code,
          vocabulary: g.hit.vocab,
        });
      }
      const rankedVocabs = Object.entries(vocabCount).sort((a, b) => b[1] - a[1]);
      const dominantVocab = rankedVocabs[0][0];
      const themeName = deriveThemeName(theme, validatedForNaming, occMap);
      const totalFreq = group.reduce((s, g) => s + g.n, 0);

      // Build codes array in Authoring Workbench's `Picked` shape.
      const codes = validatedForNaming.map((v) => ({
        code: v.code,
        display: v.display,
        vocabulary: v.vocabulary,
      }));

      // Optional cross-vocab crosswalk if the group spans >1 vocabulary.
      if (rankedVocabs.length > 1) {
        try {
          const secondaryVocab = rankedVocabs[1][0];
          const fromSab = VOCAB_TO_SAB[dominantVocab];
          const toSab = VOCAB_TO_SAB[secondaryVocab];
          const fromCode = group.find((g) => g.hit.vocab === dominantVocab)?.hit.code;
          if (fromSab && toSab && fromCode) {
            const { data: cw, error: cwErr } = await supabase.functions.invoke("umls-proxy", {
              body: { action: "crosswalk", params: { fromSab, fromCode, toSab } },
            });
            if (!cwErr) {
              const matches = Array.isArray(cw?.matches)
                ? cw.matches
                : (cw?.result ? [cw.result] : []);
              await supabase.from("terminology_activity_log" as any).insert({
                feature: "crossmap",
                actor: "Auto Terminologist",
                action: "translated",
                message: `Translated ${fromCode} (${dominantVocab} → ${secondaryVocab}) — ${matches.length} match(es)`,
              });
            }
          }
        } catch {
          // Crosswalk is best-effort — never block draft creation.
        }
      }

      const clinical_application = clinicalApplicationFor(themeName);
      const now = new Date().toISOString();
      const nameSlug = slugify(themeName);

      const outcome = await safeUpsertValueSet({
        name: themeName,
        system: dominantVocab.replace(" ", "-"),
        vocabulary: dominantVocab,
        type: "extensional",
        codes,
        description:
          "Auto-drafted by Auto Terminologist from a recurring coverage gap detected in the last 36h scan.",
        clinical_application,
        fhir_url: `http://spehr.live/fhir/ValueSet/${nameSlug}`,
        oid: `2.16.840.1.113883.3.spehr.${Date.now()}`,
        changeEntry: {
          at: now,
          actor: "Auto Terminologist",
          change: "Extended from coverage-gap detection",
        },
      });
      const valueSetId = outcome.id;

      touchedCount += 1;
      const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      let draftedMsg: string;
      let activityAction = "drafted";
      let logFeatureAction = "drafted_value_set";
      let logFeatureMsg = `Drafted value set "${themeName}" (${codes.length} ${dominantVocab} concept(s)) from coverage-gap detection.`;
      if (outcome.mode === "merged") {
        activityAction = "extended";
        draftedMsg = `${timeLabel} — Coverage gap detected: '${themeName}' already ${outcome.existingStatus} — merged ${outcome.addedCount} new ${dominantVocab} concept(s) into the existing value set (status preserved).`;
        logFeatureAction = "extended_value_set";
        logFeatureMsg = `Extended value set "${themeName}" with ${outcome.addedCount} new ${dominantVocab} concept(s); existing ${outcome.existingStatus} status preserved.`;
      } else if (outcome.mode === "replaced-draft") {
        draftedMsg = `${timeLabel} — Coverage gap detected: '${themeName}' — merged ${outcome.addedCount} new ${dominantVocab} concept(s) into existing draft value set.`;
        logFeatureMsg = `Merged ${outcome.addedCount} new ${dominantVocab} concept(s) into existing draft "${themeName}".`;
      } else if (outcome.mode === "noop") {
        activityAction = "extended";
        draftedMsg = `${timeLabel} — Coverage gap detected: '${themeName}' already ${outcome.existingStatus} and every gap code was already present — no changes made.`;
        logFeatureAction = "extended_value_set";
        logFeatureMsg = `No-op for "${themeName}": all gap codes already present in the ${outcome.existingStatus} value set.`;
      } else {
        draftedMsg = `${timeLabel} — Coverage gap detected: '${themeName}' — ${group.length} uncovered ${dominantVocab} concept(s) across ${totalFreq} occurrences (last 36h). Drafted as new value set (status: draft — awaiting human review).`;
      }

      await logActivity({
        message: draftedMsg,
        action: activityAction,
        theme: themeName,
        codes_count: group.length,
        value_set_id: valueSetId,
      });

      await supabase.from("terminology_activity_log" as any).insert({
        feature: "authoring",
        actor: "Auto Terminologist",
        action: logFeatureAction,
        message: logFeatureMsg,
        ref_id: valueSetId,
      });
    } catch (e) {
      console.warn("[auto-term] theme draft failed", theme, e);
    }
  }

  enginesChecked["auto_terminologist"] = {
    admissions_scanned: admissions,
    unique_codes: freq.size,
    coverage_gaps: gaps.length,
    themes_logged: touchedCount,
    requests_drafted: demand.drafted,
    requests_gated: demand.gated,
  };
  actions.push(
    `auto_terminologist: scanned ${admissions} admissions · ${gaps.length} gap codes · ${touchedCount} theme(s) drafted · demand queue drafted ${demand.drafted}, gated ${demand.gated}.`,
  );

  if (touchedCount === 0 && gaps.length === 0) {
    await logActivity({
      message: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — Scanned ${admissions} admissions (last 36h). No new coverage gaps detected.`,
      action: "no_gaps",
      codes_count: 0,
    });
  }

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