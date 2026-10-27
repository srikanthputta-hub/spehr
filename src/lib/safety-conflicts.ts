/**
 * Safety & Conflict library.
 *
 * Powers the System Admin → Medical Dictionary → "Safety Alerts" queue.
 * It detects drug↔allergy conflicts between a patient's intake record
 * and any RxNorm medications mapped by the NLP engine or ordered through
 * the EHR, halts the auto-commit, and gives an EHR specialist /
 * pharmacist a queue to review and either Override or Reject.
 *
 * It also exposes:
 *   - Joint Commission "Do Not Use" banned abbreviations
 *   - Local "NLP custom rules" (hospital-specific slang) editable from the
 *     Catalog tab so the same dictionary is consulted by analyzeNarrative.
 *
 * All persistence is localStorage so the queue survives reloads without
 * requiring a schema change.
 */

import { supabase } from "@/integrations/supabase/client";
import { loadIntake, type IntakeAllergy } from "@/lib/intake-record";

/* ------------------------------------------------------------------ */
/*  Joint Commission "Do Not Use" abbreviations                       */
/* ------------------------------------------------------------------ */

export type BannedAbbrev = { token: string; meaning: string; preferred: string };

export const JC_BANNED: BannedAbbrev[] = [
  { token: "U", meaning: "Unit", preferred: 'Write "unit"' },
  { token: "IU", meaning: "International Unit", preferred: 'Write "international unit"' },
  { token: "QD", meaning: "Daily", preferred: 'Write "daily"' },
  { token: "Q.D.", meaning: "Daily", preferred: 'Write "daily"' },
  { token: "QOD", meaning: "Every other day", preferred: 'Write "every other day"' },
  { token: "Q.O.D.", meaning: "Every other day", preferred: 'Write "every other day"' },
  {
    token: "MS",
    meaning: "Morphine sulfate / MgSO4 (ambiguous)",
    preferred: "Write the full drug name",
  },
  { token: "MSO4", meaning: "Morphine sulfate", preferred: 'Write "morphine sulfate"' },
  { token: "MgSO4", meaning: "Magnesium sulfate", preferred: 'Write "magnesium sulfate"' },
  { token: "cc", meaning: "Cubic centimeters", preferred: 'Write "mL"' },
  { token: "µg", meaning: "Microgram", preferred: 'Write "mcg"' },
];

const SAFETY_QUEUE_KEY = "spehr.safety_queue.v1";

export type CustomRule = { id: string; phrase: string; canonical: string };
export type CustomBanned = BannedAbbrev & { id: string };

function ls(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/* ------------------------------------------------------------------ */
/*  DB-backed NLP custom rules + banned tokens                        */
/*  Persisted in `nlp_custom_rules`. Cached in-memory so detectBanned */
/*  and the NLP engine can stay synchronous.                          */
/* ------------------------------------------------------------------ */

let _bannedCache: CustomBanned[] = [];
let _rulesCache: CustomRule[] = [];
let _hydrated = false;
let _hydratePromise: Promise<void> | null = null;

export function loadCustomBanned(): CustomBanned[] {
  return _bannedCache;
}
export function loadCustomRules(): CustomRule[] {
  return _rulesCache;
}

export async function refreshNlpRulesFromDb(): Promise<void> {
  const { data, error } = await supabase
    .from("nlp_custom_rules")
    .select("id, type, raw_term, canonical_mapping, preferred_form, created_at")
    .order("created_at", { ascending: true });
  if (error || !data) return;
  _bannedCache = data
    .filter((r) => r.type === "banned_token")
    .map((r) => ({
      id: r.id,
      token: r.raw_term,
      meaning: r.canonical_mapping ?? "",
      preferred: r.preferred_form ?? "",
    }));
  _rulesCache = data
    .filter((r) => r.type === "slang_mapping")
    .map((r) => ({ id: r.id, phrase: r.raw_term, canonical: r.canonical_mapping ?? "" }));
  _hydrated = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("spehr:nlp-rules"));
  }
}

export function ensureNlpRulesHydrated(): Promise<void> {
  if (_hydrated) return Promise.resolve();
  if (!_hydratePromise)
    _hydratePromise = refreshNlpRulesFromDb().finally(() => {
      _hydratePromise = null;
    });
  return _hydratePromise;
}

export async function addCustomRuleDb(phrase: string, canonical: string): Promise<void> {
  const { error } = await supabase.from("nlp_custom_rules").insert({
    type: "slang_mapping",
    raw_term: phrase,
    canonical_mapping: canonical,
  });
  if (error) throw error;
  await refreshNlpRulesFromDb();
}

export async function addBannedDb(
  token: string,
  meaning: string,
  preferred: string,
): Promise<void> {
  const { error } = await supabase.from("nlp_custom_rules").insert({
    type: "banned_token",
    raw_term: token,
    canonical_mapping: meaning,
    preferred_form: preferred,
  });
  if (error) throw error;
  await refreshNlpRulesFromDb();
}

export async function removeNlpRuleDb(id: string): Promise<void> {
  const { error } = await supabase.from("nlp_custom_rules").delete().eq("id", id);
  if (error) throw error;
  await refreshNlpRulesFromDb();
}

export function allBanned(): BannedAbbrev[] {
  return [...JC_BANNED, ...loadCustomBanned()];
}

/**
 * Scan a free-text string for any banned abbreviation. Word-boundary
 * aware (matches "QD" but not "QDR") and case-sensitive for the canonical
 * Joint Commission tokens.
 */
export function detectBanned(text: string): BannedAbbrev[] {
  if (!text) return [];
  const out: BannedAbbrev[] = [];
  for (const b of allBanned()) {
    const escaped = b.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`);
    if (re.test(text)) out.push(b);
  }
  return out;
}

/* (custom rules getters moved above next to the DB cache) */

/* ------------------------------------------------------------------ */
/*  Allergy ↔ Drug conflict detection                                 */
/* ------------------------------------------------------------------ */

/**
 * Allergy↔drug cross-reactivity and drug↔drug interaction detection is
 * now driven by two governed tables — `cross_reactivity_rules` and
 * `drug_interaction_rules` — that reference published `custom_value_sets`.
 *
 * The legacy hardcoded `CROSS_REACT` and `DDI_RULES` regex arrays were
 * removed in the Phase 3 consolidation. If a value set referenced by a
 * rule is deleted or renamed, the missing FK is now visible in the rule
 * table instead of silently short-circuiting detection.
 *
 * The `Latex → Latex` case is still handled below as a direct name
 * comparison because latex is not a prescribable drug class.
 */

export type SafetyConflict = {
  id: string; // stable: `${mrn}|${drug}`
  mrn: string;
  patient_name: string;
  facility_name: string | null;
  detected_at: string;
  kind: "allergy" | "ddi"; // allergy↔drug OR drug↔drug interaction
  drug: string; // ordered / proposed drug (or "Drug A")
  drug_source: "order" | "nlp";
  allergy?: IntakeAllergy; // populated when kind === "allergy"
  drug_b?: string; // populated when kind === "ddi"
  family: string; // human-readable family / interaction summary
  severity?: "Major" | "Moderate"; // for DDIs
  status: "Pending" | "Overridden" | "Rejected";
  decided_by?: string;
  decided_at?: string;
  rationale?: string;
};

/* ---- Queue persistence (decisions only; conflicts are recomputed) ---- */
type Decision = Pick<SafetyConflict, "status" | "decided_by" | "decided_at" | "rationale">;
function loadDecisions(): Record<string, Decision> {
  const s = ls();
  if (!s) return {};
  try {
    return JSON.parse(s.getItem(SAFETY_QUEUE_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveDecisions(d: Record<string, Decision>) {
  ls()?.setItem(SAFETY_QUEUE_KEY, JSON.stringify(d));
  window.dispatchEvent(new CustomEvent("spehr:safety-queue"));
}

export function decideConflict(id: string, decision: Decision) {
  const all = loadDecisions();
  all[id] = decision;
  saveDecisions(all);
}

/* ---- Value-set + rule loaders (governed tables) ------------------- */

type VsCodeSet = Set<string>;

async function loadVsCodeMap(ids: string[]): Promise<Map<string, VsCodeSet>> {
  const out = new Map<string, VsCodeSet>();
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return out;
  const { data } = await supabase
    .from("custom_value_sets")
    .select("id, codes, status")
    .in("id", uniq);
  for (const row of data ?? []) {
    if (row?.status && row.status !== "published") continue;
    const set: VsCodeSet = new Set();
    const rowCodes = Array.isArray(row?.codes) ? row.codes : [];
    for (const c of rowCodes) {
      const code = String(
        (c && typeof c === "object" && !Array.isArray(c) ? c.code : null) ?? "",
      ).trim();
      if (code) set.add(code);
    }
    out.set(String(row.id), set);
  }
  return out;
}

type CrossRule = {
  family_label: string;
  allergy_vs_id: string | null;
  drug_vs_id: string | null;
};
type DdiRule = {
  severity: "Major" | "Moderate";
  summary: string;
  a_vs_id: string | null;
  b_vs_id: string | null;
  a_single_code: string | null;
  b_single_code: string | null;
};

async function loadRules(): Promise<{ cross: CrossRule[]; ddi: DdiRule[]; vsIds: string[] }> {
  const [crossRes, ddiRes] = await Promise.all([
    supabase
      .from("cross_reactivity_rules")
      .select("family_label, allergy_value_set_id, drug_value_set_id"),
    supabase
      .from("drug_interaction_rules")
      .select(
        "severity, summary, drug_a_value_set_id, drug_b_value_set_id, drug_a_single_code, drug_b_single_code",
      ),
  ]);
  const cross: CrossRule[] = (crossRes.data ?? []).map((r) => ({
    family_label: String(r?.family_label ?? ""),
    allergy_vs_id: r?.allergy_value_set_id ?? null,
    drug_vs_id: r?.drug_value_set_id ?? null,
  }));
  const ddi: DdiRule[] = (ddiRes.data ?? []).map((r) => ({
    severity: (r?.severity === "Major" ? "Major" : "Moderate") as "Major" | "Moderate",
    summary: String(r?.summary ?? ""),
    a_vs_id: r?.drug_a_value_set_id ?? null,
    b_vs_id: r?.drug_b_value_set_id ?? null,
    a_single_code: r?.drug_a_single_code ?? null,
    b_single_code: r?.drug_b_single_code ?? null,
  }));
  const vsIds = [
    ...cross.flatMap((r) => [r.allergy_vs_id, r.drug_vs_id]),
    ...ddi.flatMap((r) => [r.a_vs_id, r.b_vs_id]),
  ].filter((x): x is string => !!x);
  return { cross, ddi, vsIds };
}

/**
 * Detect drug↔allergy conflicts across the most recent N patients.
 *
 * Rules are loaded from `cross_reactivity_rules` / `drug_interaction_rules`
 * (single source of truth), then evaluated by RxNorm/SNOMED code membership
 * against the joined `custom_value_sets`. Allergy display + reaction still
 * come from the localStorage intake record so the queue UI shape is
 * unchanged.
 */
export async function loadSafetyQueue(limit = 50): Promise<SafetyConflict[]> {
  const { data: patients, error } = await supabase
    .from("patients")
    .select("mrn, first_name, last_name, facility_name, admission_time")
    .order("admission_time", { ascending: false })
    .limit(limit);
  if (error || !patients) return [];

  const mrns = patients.map((p) => p.mrn).filter(Boolean);
  if (mrns.length === 0) return [];

  const { rules, vsCodeMap, medsByMrn, allergiesByMrn } = await (async () => {
    const [{ cross, ddi, vsIds }, medsRes, allergiesRes] = await Promise.all([
      loadRules(),
      supabase
        .from("medication_orders")
        .select("patient_mrn, medication_name, drug_name, rxnorm_code, created_at")
        .in("patient_mrn", mrns),
      supabase
        .from("allergies")
        .select("mrn, substance, substance_rxcui, substance_snomed")
        .in("mrn", mrns),
    ]);
    const vsCodeMap = await loadVsCodeMap(vsIds);

    type MedRec = { name: string; rxcui: string | null };
    const medsByMrn = new Map<string, MedRec[]>();
    for (const m of medsRes.data ?? []) {
      const name = (m.medication_name || m.drug_name || "").trim();
      if (!name || !m.patient_mrn) continue;
      const rxcui = m.rxnorm_code ? String(m.rxnorm_code).trim() : null;
      const list = medsByMrn.get(m.patient_mrn) ?? [];
      const key = `${(rxcui ?? "").toLowerCase()}|${name.toLowerCase()}`;
      if (!list.some((x) => `${(x.rxcui ?? "").toLowerCase()}|${x.name.toLowerCase()}` === key)) {
        list.push({ name, rxcui });
      }
      medsByMrn.set(m.patient_mrn, list);
    }

    type AllergyRec = { substance: string; rxcui: string | null; snomed: string | null };
    const allergiesByMrn = new Map<string, AllergyRec[]>();
    for (const a of allergiesRes.data ?? []) {
      if (!a?.mrn || !a?.substance) continue;
      const list = allergiesByMrn.get(a.mrn) ?? [];
      list.push({
        substance: String(a.substance),
        rxcui: a.substance_rxcui ? String(a.substance_rxcui).trim() : null,
        snomed: a.substance_snomed ? String(a.substance_snomed).trim() : null,
      });
      allergiesByMrn.set(a.mrn, list);
    }

    return { rules: { cross, ddi }, vsCodeMap, medsByMrn, allergiesByMrn };
  })();

  const decisions = loadDecisions();
  const out: SafetyConflict[] = [];

  for (const p of patients) {
    const intake = loadIntake(p.mrn);
    const intakeAllergies = intake?.drugAllergies ?? [];
    const codedAllergies = allergiesByMrn.get(p.mrn) ?? [];
    const drugs = medsByMrn.get(p.mrn) ?? [];
    if (intakeAllergies.length === 0 && codedAllergies.length === 0 && drugs.length < 2) continue;

    const patientName = `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "—";
    const facility = p.facility_name ?? null;

    // Build an intake-allergy lookup by lowercased substance for display/reaction
    const intakeByName = new Map<string, IntakeAllergy>();
    for (const a of intakeAllergies) intakeByName.set((a.name ?? "").toLowerCase(), a);

    const pushed = new Set<string>();

    // ---- Allergy ↔ Drug (governed cross_reactivity_rules) ----
    for (const drug of drugs) {
      if (!drug.rxcui) continue;
      for (const rule of rules.cross) {
        const drugVs = rule.drug_vs_id ? vsCodeMap.get(rule.drug_vs_id) : null;
        if (!drugVs || !drugVs.has(drug.rxcui)) continue;
        const allergyVs = rule.allergy_vs_id ? vsCodeMap.get(rule.allergy_vs_id) : null;
        // Find any patient allergy whose coded substance is in the allergy VS
        const match = codedAllergies.find((a) => {
          if (!allergyVs) return false;
          if (a.snomed && allergyVs.has(a.snomed)) return true;
          if (a.rxcui && allergyVs.has(a.rxcui)) return true;
          return false;
        });
        if (!match) continue;
        const id = `${p.mrn}|${drug.name.toLowerCase()}`;
        if (pushed.has(id)) continue;
        pushed.add(id);
        const dec = decisions[id];
        const intake = intakeByName.get(match.substance.toLowerCase()) ?? {
          name: match.substance,
          reaction: "",
        };
        out.push({
          id,
          mrn: p.mrn,
          patient_name: patientName,
          facility_name: facility,
          detected_at: new Date().toISOString(),
          kind: "allergy",
          drug: drug.name,
          drug_source: "order",
          allergy: intake,
          family: rule.family_label,
          status: dec?.status ?? "Pending",
          decided_by: dec?.decided_by,
          decided_at: dec?.decided_at,
          rationale: dec?.rationale,
        });
        break;
      }
    }

    // ---- Latex → Latex direct-string check (not a prescribable class) ----
    for (const drug of drugs) {
      if (!/latex/i.test(drug.name)) continue;
      const latexAllergy =
        intakeAllergies.find((a) => /latex/i.test(a.name)) ??
        codedAllergies.find((a) => /latex/i.test(a.substance));
      if (!latexAllergy) continue;
      const id = `${p.mrn}|${drug.name.toLowerCase()}`;
      if (pushed.has(id)) continue;
      pushed.add(id);
      const dec = decisions[id];
      const intake: IntakeAllergy =
        "reaction" in latexAllergy ? latexAllergy : { name: latexAllergy.substance, reaction: "" };
      out.push({
        id,
        mrn: p.mrn,
        patient_name: patientName,
        facility_name: facility,
        detected_at: new Date().toISOString(),
        kind: "allergy",
        drug: drug.name,
        drug_source: "order",
        allergy: intake,
        family: "Latex exposure",
        status: dec?.status ?? "Pending",
        decided_by: dec?.decided_by,
        decided_at: dec?.decided_at,
        rationale: dec?.rationale,
      });
    }

    // ---- Drug ↔ Drug interactions (governed drug_interaction_rules) ----
    const drugMatchesSide = (
      drug: { rxcui: string | null },
      vsId: string | null,
      single: string | null,
    ): boolean => {
      if (!drug.rxcui) return false;
      if (single && drug.rxcui === single) return true;
      if (vsId) {
        const vs = vsCodeMap.get(vsId);
        if (vs && vs.has(drug.rxcui)) return true;
      }
      return false;
    };
    for (let i = 0; i < drugs.length; i++) {
      for (let j = i + 1; j < drugs.length; j++) {
        const da = drugs[i],
          db = drugs[j];
        for (const r of rules.ddi) {
          const straight =
            drugMatchesSide(da, r.a_vs_id, r.a_single_code) &&
            drugMatchesSide(db, r.b_vs_id, r.b_single_code);
          const swapped =
            drugMatchesSide(db, r.a_vs_id, r.a_single_code) &&
            drugMatchesSide(da, r.b_vs_id, r.b_single_code);
          if (!straight && !swapped) continue;
          // Guard: don't self-fire when both sides collapse to the same drug
          if (da.rxcui && db.rxcui && da.rxcui === db.rxcui) continue;
          const id = `${p.mrn}|ddi|${[da.name, db.name].sort().join("+").toLowerCase()}`;
          if (pushed.has(id)) continue;
          pushed.add(id);
          const dec = decisions[id];
          out.push({
            id,
            mrn: p.mrn,
            patient_name: patientName,
            facility_name: facility,
            detected_at: new Date().toISOString(),
            kind: "ddi",
            drug: da.name,
            drug_b: db.name,
            drug_source: "order",
            family: r.summary,
            severity: r.severity,
            status: dec?.status ?? "Pending",
            decided_by: dec?.decided_by,
            decided_at: dec?.decided_at,
            rationale: dec?.rationale,
          });
          break;
        }
      }
    }
  }

  // Pending first, then most-recent decided
  out.sort((a, b) => {
    if (a.status === "Pending" && b.status !== "Pending") return -1;
    if (b.status === "Pending" && a.status !== "Pending") return 1;
    return (b.decided_at ?? "").localeCompare(a.decided_at ?? "");
  });
  return out;
}
