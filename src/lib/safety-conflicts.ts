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
  { token: "U",     meaning: "Unit",               preferred: 'Write "unit"' },
  { token: "IU",    meaning: "International Unit", preferred: 'Write "international unit"' },
  { token: "QD",    meaning: "Daily",              preferred: 'Write "daily"' },
  { token: "Q.D.",  meaning: "Daily",              preferred: 'Write "daily"' },
  { token: "QOD",   meaning: "Every other day",    preferred: 'Write "every other day"' },
  { token: "Q.O.D.",meaning: "Every other day",    preferred: 'Write "every other day"' },
  { token: "MS",    meaning: "Morphine sulfate / MgSO4 (ambiguous)", preferred: "Write the full drug name" },
  { token: "MSO4",  meaning: "Morphine sulfate",   preferred: 'Write "morphine sulfate"' },
  { token: "MgSO4", meaning: "Magnesium sulfate",  preferred: 'Write "magnesium sulfate"' },
  { token: "cc",    meaning: "Cubic centimeters",  preferred: 'Write "mL"' },
  { token: "µg",    meaning: "Microgram",          preferred: 'Write "mcg"' },
];

const CUSTOM_BANNED_KEY = "spehr.banned_abbrev.v1";
const CUSTOM_RULES_KEY  = "spehr.nlp_rules.v1";
const SAFETY_QUEUE_KEY  = "spehr.safety_queue.v1";

export type CustomRule = { id: string; phrase: string; canonical: string };

function ls(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/* ---- Custom banned abbreviations ---- */
export function loadCustomBanned(): BannedAbbrev[] {
  const s = ls(); if (!s) return [];
  try { return JSON.parse(s.getItem(CUSTOM_BANNED_KEY) || "[]"); } catch { return []; }
}
export function saveCustomBanned(list: BannedAbbrev[]) {
  ls()?.setItem(CUSTOM_BANNED_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent("spehr:nlp-rules"));
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

/* ---- Custom NLP rules ---- */
export function loadCustomRules(): CustomRule[] {
  const s = ls(); if (!s) return [];
  try { return JSON.parse(s.getItem(CUSTOM_RULES_KEY) || "[]"); } catch { return []; }
}
export function saveCustomRules(rules: CustomRule[]) {
  ls()?.setItem(CUSTOM_RULES_KEY, JSON.stringify(rules));
  window.dispatchEvent(new CustomEvent("spehr:nlp-rules"));
}

/* ------------------------------------------------------------------ */
/*  Allergy ↔ Drug conflict detection                                 */
/* ------------------------------------------------------------------ */

/**
 * Cross-reactivity map. Each entry: an allergy keyword → list of drug
 * keywords (RxNorm display strings or order text) that should halt
 * auto-commit and surface in the Safety Queue.
 */
const CROSS_REACT: Array<{ allergy: RegExp; drugs: RegExp; family: string }> = [
  { allergy: /penicillin|pcn|amoxicillin|ampicillin/i,
    drugs:  /amoxicillin|ampicillin|penicillin|piperacillin|nafcillin|oxacillin|dicloxacillin|augmentin/i,
    family: "Beta-lactam / Penicillin family" },
  { allergy: /penicillin|cephalosporin|cefazolin/i,
    drugs:  /cefazolin|cephalexin|ceftriaxone|cefepime|cefuroxime|cefdinir/i,
    family: "Cephalosporin (β-lactam cross-reactivity)" },
  { allergy: /sulfa|sulfonamide|bactrim|tmp[- ]?smx/i,
    drugs:  /sulfamethoxazole|trimethoprim|bactrim|tmp[- ]?smx|sulfadiazine|sulfasalazine/i,
    family: "Sulfonamide antibiotic" },
  { allergy: /codeine|opioid|morphine|hydrocodone|oxycodone/i,
    drugs:  /codeine|morphine|hydrocodone|oxycodone|fentanyl|hydromorphone|tramadol/i,
    family: "Opioid analgesic" },
  { allergy: /nsaid|ibuprofen|aspirin|asa|naproxen/i,
    drugs:  /ibuprofen|naproxen|ketorolac|aspirin|diclofenac|meloxicam/i,
    family: "NSAID" },
  { allergy: /latex/i, drugs: /latex/i, family: "Latex exposure" },
  { allergy: /contrast|iodine/i, drugs: /iohexol|iodixanol|iopamidol|contrast/i, family: "Iodinated contrast" },
  { allergy: /statin/i, drugs: /atorvastatin|simvastatin|rosuvastatin|pravastatin/i, family: "HMG-CoA reductase inhibitor" },
];

export type SafetyConflict = {
  id: string;                       // stable: `${mrn}|${drug}`
  mrn: string;
  patient_name: string;
  facility_name: string | null;
  detected_at: string;
  kind: "allergy" | "ddi";          // allergy↔drug OR drug↔drug interaction
  drug: string;                     // ordered / proposed drug (or "Drug A")
  drug_source: "order" | "nlp";
  allergy?: IntakeAllergy;          // populated when kind === "allergy"
  drug_b?: string;                  // populated when kind === "ddi"
  family: string;                   // human-readable family / interaction summary
  severity?: "Major" | "Moderate";  // for DDIs
  status: "Pending" | "Overridden" | "Rejected";
  decided_by?: string;
  decided_at?: string;
  rationale?: string;
};
/* ---- Drug ↔ Drug interactions (clinically significant subset) ----- */
const DDI_RULES: Array<{ a: RegExp; b: RegExp; severity: "Major" | "Moderate"; summary: string }> = [
  { a: /warfarin/i, b: /aspirin|ibuprofen|naproxen|ketorolac|clopidogrel/i,
    severity: "Major", summary: "↑ bleeding risk (antiplatelet + anticoagulant)" },
  { a: /warfarin/i, b: /sulfamethoxazole|trimethoprim|bactrim|ciprofloxacin|metronidazole|fluconazole/i,
    severity: "Major", summary: "↑ INR — warfarin potentiation" },
  { a: /(sertraline|fluoxetine|paroxetine|citalopram|escitalopram)/i,
    b: /(tramadol|linezolid|maoi|triptan|ondansetron)/i,
    severity: "Major", summary: "Serotonin syndrome risk" },
  { a: /metformin/i, b: /iohexol|iodixanol|iopamidol|contrast/i,
    severity: "Major", summary: "Hold metformin around iodinated contrast (lactic acidosis)" },
  { a: /clopidogrel/i, b: /omeprazole|esomeprazole/i,
    severity: "Moderate", summary: "PPI ↓ clopidogrel activation (CYP2C19)" },
  { a: /simvastatin|atorvastatin/i, b: /clarithromycin|erythromycin|itraconazole|ketoconazole/i,
    severity: "Major", summary: "↑ statin levels — rhabdomyolysis risk" },
  { a: /digoxin/i, b: /amiodarone|verapamil|clarithromycin/i,
    severity: "Major", summary: "↑ digoxin levels — toxicity risk" },
  { a: /lisinopril|enalapril|losartan|valsartan/i, b: /spironolactone|potassium chloride/i,
    severity: "Moderate", summary: "Hyperkalemia risk" },
  { a: /(opioid|morphine|hydrocodone|oxycodone|fentanyl|tramadol)/i,
    b: /(benzodiazepine|alprazolam|lorazepam|diazepam|midazolam|clonazepam)/i,
    severity: "Major", summary: "Respiratory depression (opioid + benzodiazepine)" },
];

/* ---- Queue persistence (decisions only; conflicts are recomputed) ---- */
type Decision = Pick<SafetyConflict, "status" | "decided_by" | "decided_at" | "rationale">;
function loadDecisions(): Record<string, Decision> {
  const s = ls(); if (!s) return {};
  try { return JSON.parse(s.getItem(SAFETY_QUEUE_KEY) || "{}"); } catch { return {}; }
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

/**
 * Detect drug↔allergy conflicts across the most recent N patients.
 * Pulls intake records from localStorage (auto-filled at admission) and
 * cross-references medication_orders.
 */
export async function loadSafetyQueue(limit = 50): Promise<SafetyConflict[]> {
  const { data: patients, error } = await supabase
    .from("patients")
    .select("mrn, first_name, last_name, facility_name, admission_time")
    .order("admission_time", { ascending: false })
    .limit(limit);
  if (error || !patients) return [];

  const mrns = patients.map((p: any) => p.mrn).filter(Boolean);
  if (mrns.length === 0) return [];

  const { data: meds } = await supabase
    .from("medication_orders")
    .select("patient_mrn, medication_name, drug_name, ordered_at, created_at")
    .in("patient_mrn", mrns);

  const medsByMrn = new Map<string, string[]>();
  for (const m of (meds ?? []) as any[]) {
    const drug = (m.medication_name || m.drug_name || "").trim();
    if (!drug || !m.patient_mrn) continue;
    const list = medsByMrn.get(m.patient_mrn) ?? [];
    if (!list.includes(drug)) list.push(drug);
    medsByMrn.set(m.patient_mrn, list);
  }

  const decisions = loadDecisions();
  const out: SafetyConflict[] = [];

  for (const p of patients as any[]) {
    const intake = loadIntake(p.mrn);
    const allergies = intake?.drugAllergies ?? [];
    const drugs = medsByMrn.get(p.mrn) ?? [];
    if (allergies.length === 0 && drugs.length < 2) continue;

    // ---- Allergy ↔ Drug
    for (const drug of drugs) {
      for (const allergy of allergies) {
        for (const rule of CROSS_REACT) {
          if (rule.allergy.test(allergy.name) && rule.drugs.test(drug)) {
            const id = `${p.mrn}|${drug.toLowerCase()}`;
            const dec = decisions[id];
            out.push({
              id,
              mrn: p.mrn,
              patient_name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "—",
              facility_name: p.facility_name ?? null,
              detected_at: new Date().toISOString(),
              kind: "allergy",
              drug,
              drug_source: "order",
              allergy,
              family: rule.family,
              status: dec?.status ?? "Pending",
              decided_by: dec?.decided_by,
              decided_at: dec?.decided_at,
              rationale: dec?.rationale,
            });
            break; // first matching rule per (allergy, drug) pair
          }
        }
      }
    }

    // ---- Drug ↔ Drug interactions
    for (let i = 0; i < drugs.length; i++) {
      for (let j = i + 1; j < drugs.length; j++) {
        const da = drugs[i], db = drugs[j];
        for (const r of DDI_RULES) {
          const match = (r.a.test(da) && r.b.test(db)) || (r.a.test(db) && r.b.test(da));
          if (!match) continue;
          const id = `${p.mrn}|ddi|${[da, db].sort().join("+").toLowerCase()}`;
          const dec = decisions[id];
          out.push({
            id,
            mrn: p.mrn,
            patient_name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "—",
            facility_name: p.facility_name ?? null,
            detected_at: new Date().toISOString(),
            kind: "ddi",
            drug: da,
            drug_b: db,
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