import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAutomationEnabled } from "@/hooks/useAutomationEnabled";

/**
 * Auto Terminologist — autonomous clinical terminologist agent.
 * --------------------------------------------------------------
 * Background loop (10 min cadence, leader-elected across tabs):
 *   1. Scans the last 36h of patient / condition / medication / lab data.
 *   2. Counts unique clinical codes and identifies coverage gaps by theme.
 *   3. For genuine recurring gaps, drafts a new value set into
 *      `custom_value_sets` — exactly as a human terminologist would via
 *      the Authoring Workbench.
 *   4. Logs human-readable activity to `auto_terminologist_log` +
 *      `terminology_activity_log`, plus a heartbeat to
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

type CodeHit = {
  code: string;
  vocab: "SNOMED CT" | "ICD-10" | "RxNorm" | "LOINC";
  display?: string;
  theme?: string;
};

function themeFromText(s?: string | null): string {
  if (!s) return "General Clinical";
  const t = s.toLowerCase();
  if (/(stroke|cva|cerebrovascular)/.test(t)) return "Acute Stroke Presentations";
  if (/(sepsis|septic)/.test(t)) return "Sepsis & Severe Infection";
  if (/(mi|myocardial|stemi|nstemi|chest pain|acs)/.test(t)) return "Acute Coronary Syndrome";
  if (/(antiplatelet|aspirin|clopidogrel|ticagrelor)/.test(t)) return "Antiplatelet Therapy";
  if (/(anticoag|warfarin|apixaban|rivaroxaban|heparin)/.test(t)) return "Anticoagulation Therapy";
  if (/(asthma|copd|bronch|respirator)/.test(t)) return "Respiratory Conditions";
  if (/(diabet|hyperglyc|insulin)/.test(t)) return "Diabetes Management";
  if (/(pneumon)/.test(t)) return "Community-Acquired Pneumonia";
  if (/(trauma|fracture|injury)/.test(t)) return "Trauma & Injury";
  if (/(pregn|obstetr|labor|delivery)/.test(t)) return "Obstetric Care";
  if (/(antibio|infection|cellulitis|uti)/.test(t)) return "Infection Management";
  if (/(pain|analges)/.test(t)) return "Pain Management";
  if (/(renal|kidney|dialys)/.test(t)) return "Renal Care";
  return cleanComplaintName(s);
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

      const { data: upserted, error: upsertErr } = await supabase
        .from("custom_value_sets")
        .upsert(
          {
            name: themeName,
            system: dominantVocab.replace(" ", "-"),
            vocabulary: dominantVocab,
            type: "extensional",
            codes,
            status: "draft",
            description:
              "Auto-drafted by Auto Terminologist from a recurring coverage gap detected in the last 36h scan.",
            clinical_application,
            fhir_url: `http://spehr.live/fhir/ValueSet/${nameSlug}`,
            oid: `2.16.840.1.113883.3.spehr.${Date.now()}`,
            change_history: [
              { at: now, actor: "Auto Terminologist", change: "Drafted from coverage-gap detection" },
            ],
          } as any,
          { onConflict: "name" },
        )
        .select("id")
        .maybeSingle();

      if (upsertErr) throw upsertErr;
      const valueSetId = (upserted as any)?.id ?? null;

      touchedCount += 1;
      const timeLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const draftedMsg = `${timeLabel} — Coverage gap detected: '${themeName}' — ${group.length} uncovered ${dominantVocab} concept(s) across ${totalFreq} occurrences (last 36h). Drafted as new value set (status: draft — awaiting human review).`;

      await logActivity({
        message: draftedMsg,
        action: "drafted",
        theme: themeName,
        codes_count: group.length,
        value_set_id: valueSetId,
      });

      await supabase.from("terminology_activity_log" as any).insert({
        feature: "authoring",
        actor: "Auto Terminologist",
        action: "drafted_value_set",
        message: `Drafted value set "${themeName}" (${codes.length} ${dominantVocab} concept(s)) from coverage-gap detection.`,
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
  };
  actions.push(
    `auto_terminologist: scanned ${admissions} admissions · ${gaps.length} gap codes · ${touchedCount} theme(s) drafted as value sets.`,
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