import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getAutomationEnabled } from "@/hooks/useAutomationEnabled";

/**
 * Auto Terminologist — autonomous clinical terminologist agent.
 * --------------------------------------------------------------
 * Background loop (10 min cadence, leader-elected across tabs) that:
 *   1. Scans the last 24h of patient / condition / medication / lab data.
 *   2. Counts unique clinical codes and finds the ones not yet covered
 *      by any row in `custom_value_sets`.
 *   3. Clusters gap codes into clinical themes (by dominant complaint /
 *      condition text) and validates each via the `umls-proxy` `validate`
 *      action.
 *   4. Drafts a new value set per theme (status `review` or `draft`
 *      depending on confidence) — never `published`.
 *   5. Writes human-readable activity to `auto_terminologist_log` and a
 *      heartbeat to `automation_watchdog_logs` so it shows up alongside
 *      Auto Doc / Auto Admin / Auto IT / AUTO API in the Watchdog UI.
 *
 * Idempotent: the same theme+code-set never produces a duplicate draft —
 * an existing matching draft is "touched" (change_history append) instead.
 */

const RUN_INTERVAL_MS = 10 * 60_000;
const LEADER_KEY = "spehr.autoterm.leader";
const LEADER_LEASE_MS = 12 * 60_000;
const TAB_ID = Math.random().toString(36).slice(2);

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
  // fall back to first 4 words capitalised
  const words = s.split(/\s+/).slice(0, 4).join(" ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "General Clinical";
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

async function validateCode(code: string, vocab: CodeHit["vocab"]): Promise<{ active: boolean; display?: string }> {
  const sab =
    vocab === "SNOMED CT" ? "SNOMEDCT_US" :
    vocab === "ICD-10" ? "ICD10CM" :
    vocab === "LOINC" ? "LNC" : "RXNORM";
  try {
    const { data, error } = await supabase.functions.invoke("umls-proxy", {
      body: { action: "validate", params: { code, sab } },
    });
    if (error) return { active: false };
    const r = (data as any)?.result;
    if (!r || !r.name) return { active: false };
    return { active: r.status !== "obsolete", display: r.name };
  } catch {
    return { active: false };
  }
}

/** Pull recent codes from each clinical table joined to a patient row. */
async function collectRecentCodes(): Promise<{ hits: CodeHit[]; admissions: number }> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
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
    supabase.from("conditions").select("mrn, icd10_code, snomed_code, display_text").in("mrn", mrns).limit(2000),
    supabase.from("medication_orders").select("patient_mrn, rxnorm_code, drug_name").in("patient_mrn", mrns).limit(2000),
    supabase.from("lab_orders").select("patient_mrn, loinc_code, test_type").in("patient_mrn", mrns).limit(2000),
  ]);

  const hits: CodeHit[] = [];
  for (const c of (conds.data ?? []) as any[]) {
    const theme = themeByMrn.get(c.mrn) ?? themeFromText(c.display_text);
    if (c.snomed_code) hits.push({ code: String(c.snomed_code), vocab: "SNOMED CT", display: c.display_text, theme });
    if (c.icd10_code) hits.push({ code: String(c.icd10_code), vocab: "ICD-10", display: c.display_text, theme });
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

  // Existing coverage set
  const { data: existingSets } = await supabase
    .from("custom_value_sets")
    .select("id, name, codes, change_history, steward");
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

  let draftedCount = 0;
  let heldCount = 0;
  let touchedCount = 0;

  for (const [theme, group] of byTheme) {
    if (group.length < 2) continue;

    // Validate each code via umls-proxy
    const validated: Array<{ code: string; display: string; vocabulary: string; status: string; active: boolean }> = [];
    for (const g of group) {
      const v = await validateCode(g.hit.code, g.hit.vocab);
      validated.push({
        code: g.hit.code,
        display: v.display ?? g.hit.display ?? g.hit.code,
        vocabulary: g.hit.vocab,
        status: v.active ? "active" : "unknown",
        active: v.active,
      });
    }

    const activeFrac = validated.filter((c) => c.active).length / validated.length;
    const vocabCount: Record<string, number> = {};
    for (const c of validated) vocabCount[c.vocabulary] = (vocabCount[c.vocabulary] ?? 0) + 1;
    const dominantVocab = Object.entries(vocabCount).sort((a, b) => b[1] - a[1])[0][0];
    const tightness = (vocabCount[dominantVocab] ?? 0) / validated.length;
    const totalFreq = group.reduce((s, g) => s + g.n, 0);
    const freqBoost = Math.min(1, totalFreq / (group.length * 6));
    const confidence = Math.min(1, activeFrac * 0.55 + tightness * 0.3 + freqBoost * 0.15);

    if (confidence < 0.5) {
      heldCount += 1;
      await logActivity({
        message: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — ${group.length} uncovered ${theme.toLowerCase()} concept(s) found but confidence ${confidence.toFixed(2)} — held, not drafted.`,
        action: "skipped",
        confidence,
        theme,
        codes_count: group.length,
      });
      continue;
    }

    const status = confidence >= 0.8 ? "review" : "draft";
    const codeKeySig = validated.map((c) => `${c.vocabulary}|${c.code}`).sort().join(",");

    // Idempotency — look for existing auto-drafted set with same theme + signature
    const { data: priorSets } = await supabase
      .from("custom_value_sets")
      .select("id, name, codes, change_history")
      .eq("steward", "Auto Terminologist")
      .ilike("name", `Auto · ${theme}%`);

    let prior: any = null;
    for (const ps of (priorSets ?? []) as any[]) {
      const sig = (Array.isArray(ps.codes) ? ps.codes : [])
        .map((c: any) => `${c.vocabulary}|${c.code}`)
        .sort()
        .join(",");
      if (sig === codeKeySig) { prior = ps; break; }
    }

    if (prior) {
      const history = Array.isArray(prior.change_history) ? prior.change_history : [];
      history.push({ at: new Date().toISOString(), event: "last_seen", confidence, n: totalFreq });
      await supabase
        .from("custom_value_sets")
        .update({ change_history: history, updated_at: new Date().toISOString() } as any)
        .eq("id", prior.id);
      touchedCount += 1;
      await logActivity({
        message: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — Recurring gap '${theme}' (${group.length} codes) — refreshed last-seen on existing draft (${prior.name}).`,
        action: "touched",
        confidence,
        theme,
        codes_count: group.length,
        value_set_id: prior.id,
      });
      continue;
    }

    const ts = Date.now();
    const name = `Auto · ${theme} (${ts.toString(36)})`;
    const oid = `2.16.840.1.113883.3.spehr.auto.${ts}`;
    const insert = {
      name,
      system: dominantVocab,
      vocabulary: dominantVocab,
      type: "extensional",
      codes: validated.map(({ active, ...rest }) => rest),
      status,
      author: "Auto Terminologist",
      steward: "Auto Terminologist",
      oid,
      description: `Auto-detected coverage gap on ${new Date().toLocaleDateString()}. Theme: ${theme}. Drafted by the autonomous terminologist agent from ${totalFreq} occurrences in last 24h.`,
      clinical_application: theme,
      change_history: [
        {
          at: new Date().toISOString(),
          event: "auto_drafted",
          confidence,
          source: "auto_terminologist",
          codes: validated.length,
        },
      ],
    } as any;

    const { data: created, error: insErr } = await supabase
      .from("custom_value_sets")
      .insert(insert)
      .select("id")
      .maybeSingle();

    if (insErr) {
      console.warn("[auto-term] insert failed", insErr);
      continue;
    }
    draftedCount += 1;
    await logActivity({
      message: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — Scanned ${admissions} admissions (last 24h). Detected ${group.length} uncovered ${theme.toLowerCase()} concepts. Drafted '${theme}' (${validated.length} codes, ${dominantVocab}) → submitted for ${status} · confidence ${confidence.toFixed(2)}.`,
      action: status === "review" ? "drafted_for_review" : "drafted",
      confidence,
      theme,
      codes_count: validated.length,
      value_set_id: created?.id ?? null,
    });
  }

  enginesChecked["auto_terminologist"] = {
    admissions_scanned: admissions,
    unique_codes: freq.size,
    coverage_gaps: gaps.length,
    themes_drafted: draftedCount,
    themes_held: heldCount,
    drafts_touched: touchedCount,
  };
  actions.push(
    `auto_terminologist: scanned ${admissions} admissions · ${gaps.length} gap codes · drafted ${draftedCount} · held ${heldCount} · refreshed ${touchedCount}.`,
  );

  if (draftedCount === 0 && heldCount === 0 && touchedCount === 0 && gaps.length === 0) {
    await logActivity({
      message: `${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — Scanned ${admissions} admissions (last 24h). No new coverage gaps detected.`,
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
    const tick = () => {
      if (!tryAcquireLeader()) return;
      runAutoTerminologistCycle().catch((e) =>
        console.warn("[auto-term] cycle failed", e),
      );
    };
    // Stagger first run by 25s so it doesn't race other boot tasks.
    const boot = setTimeout(tick, 25_000);
    const id = setInterval(tick, RUN_INTERVAL_MS);
    return () => {
      clearTimeout(boot);
      clearInterval(id);
    };
  }, []);
}