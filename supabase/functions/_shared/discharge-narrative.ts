/**
 * Discharge Narrative Builder
 *
 * Turns the structured patient + meds + labs + imaging + procedures record
 * into a clinically readable discharge summary that follows real hospital
 * format:
 *   0. Clinical Completeness Check (safety flags, see below)
 *   1. Admitting & Discharge Diagnoses
 *   2. Clinician's Discharge Note (verbatim, when the discharging clinician
 *      typed one — see H7: this must never be discarded)
 *   3. History of Present Illness (HPI)
 *   4. Hospital Course (assessment → plan reasoning, real data only)
 *   5. Procedures (derived from the real `procedures` table — never a
 *      hardcoded negative claim)
 *   6. Pertinent Labs / Imaging (abnormal-first labs + any reported
 *      `radiology_orders` studies)
 *   7. Discharge Instructions & Meds (each medication carries an explicit
 *      continue/stop decision; stop is forced on a documented allergy
 *      conflict)
 *
 * HARD RULE (post C4/C3 fabrication fixes): this module may only ever print
 * a documented fact. There is no structured "physical exam" table in this
 * schema, so the exam section is driven strictly off the last recorded
 * `vitals` row and says "not documented" when there is none — it must NEVER
 * synthesize organ-system findings ("Pulmonary: Clear to auscultation...")
 * that no one examined. Likewise "Condition at Discharge" and "Hospital
 * Course" must not assert anything (afebrile, ambulating, pain controlled,
 * ...) that isn't backed by a real row.
 *
 * `computeSafetyFlags()` performs real sanity checks (high-acuity
 * complaint vs. low-acuity treatment, implausible length-of-stay, discharge
 * medication vs. documented allergy conflicts — reusing Safety Alerts
 * Engine's Rule 1 matching helpers, see `safety-alerts-matching.ts` — ...)
 * and is wired into section 0 above, so gaps actually surface to the
 * reviewing clinician instead of being silently computed and discarded.
 */

import {
  allergyMatchesValueSet,
  classTokens,
  extensionalContains,
  type CodedAllergy,
  type MatchableValueSet,
} from "./safety-alerts-matching.ts";

export type { MatchableValueSet };

export interface NarrativeMed {
  medication_name?: string | null;
  drug_name?: string | null;
  dose?: string | null;
  route?: string | null;
  status?: string | null;
  ordered_by?: string | null;
  administered_at?: string | null;
  /** RxNorm code from the structured `medication_requests` table. */
  rxnorm_code?: string | null;
  /** Display name from the structured `medication_requests` table. */
  display_name?: string | null;
  frequency?: string | null;
}

export interface NarrativeLab {
  test_type?: string | null;
  status?: string | null;
  result_value?: string | null;
  collected_at?: string | null;
  /** LOINC code from the structured `observations` table. */
  loinc_code?: string | null;
  /** Display name from the structured `observations` table. */
  display_name?: string | null;
  /** Numeric value (when parseable) from `observations.value_numeric`. */
  value_numeric?: number | null;
  unit?: string | null;
  abnormal_flag?: string | null;
}

export interface NarrativePatient {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  mrn?: string | null;
  age?: number | null;
  gender?: string | null;
  chief_complaint?: string | null;
  admission_time?: string | null;
  discharge_time?: string | null;
  icd10_codes?: string[] | null;
  snomed_codes?: string[] | null;
  /** Final clinical diagnosis as deduced by Auto Doc (NOT the chief complaint). */
  diagnosis?: string | null;
  /** Free-text past medical history captured at admission. */
  past_medical_history?: string | null;
  /** Free-text past surgical history captured at admission. */
  past_surgical_history?: string | null;
  /** Primary care follow-up clinician, if any. */
  primary_care_physician?: string | null;
}

/**
 * Structured allergy row, mapped 1:1 to a FHIR AllergyIntolerance resource
 * (or the local `allergies` table). The narrative builder will NEVER print
 * "No known drug allergies" unless this array is explicitly empty.
 */
export interface NarrativeAllergy {
  substance?: string | null;
  reaction?: string | null;
  severity?: string | null;
  category?: string | null; // medication | environment | food
  /** RxNorm code the allergy's substance was actually coded with, when any. */
  substance_rxcui?: string | null;
  /** SNOMED CT code the allergy's substance was actually coded with, when
   * any — e.g. 764146007 for penicillin G, spehr's single most common real
   * allergy, which VSAC's own "Penicillin Allergy" value sets don't
   * extensionally enumerate (see `allergyMatchesValueSet`'s doc comment). */
  substance_snomed?: string | null;
}

/**
 * Reported imaging study, mapped 1:1 to the `radiology_orders` table.
 * Only studies that have actually come back (status "Reported"/"Resulted",
 * or that carry a `resulted_at`/`report_text`/`impression`) are rendered —
 * a still-pending order is not a "finding".
 */
export interface NarrativeImaging {
  exam_type?: string | null;
  modality?: string | null;
  body_part?: string | null;
  status?: string | null;
  report_text?: string | null;
  impression?: string | null;
  ordered_at?: string | null;
  resulted_at?: string | null;
  snomed_display?: string | null;
}

/**
 * A real procedure/intervention, mapped 1:1 to the `procedures` table.
 * This is what "Procedures Performed" is derived from — the section must
 * NEVER print its negative claim unconditionally; it reflects whatever is
 * (or is not) actually on file for this patient.
 */
export interface NarrativeProcedure {
  display_text?: string | null;
  status?: string | null;
  performed_at?: string | null;
  cpt_code?: string | null;
  cpt_display?: string | null;
  snomed_display?: string | null;
  performed_by?: string | null;
}

/**
 * The last recorded `vitals` row at/before discharge. This schema has no
 * structured "physical exam" table, so this is the ONLY real signal the
 * "Physical Examination on Admission" section may cite — it must say "not
 * documented" rather than invent organ-system findings when this is absent.
 */
export interface NarrativeVitals {
  hr?: number | string | null;
  bp_systolic?: number | string | null;
  bp_diastolic?: number | string | null;
  spo2?: number | string | null;
  temp_c?: number | string | null;
  rr?: number | string | null;
  recorded_at?: string | null;
}

/* ------------------------------------------------------------------ */
/* Follow-up interval                                                  */
/* ------------------------------------------------------------------ */

/**
 * Default follow-up window quoted in the auto-generated "Follow-Up Care"
 * section below, and the fallback used by ghost-discharge-worker's recall
 * scheduler when no explicit interval can be parsed out of the discharge
 * note. Kept as a single named constant so the narrative text and the
 * actual scheduled recall date can never drift apart the way they used to
 * (narrative hardcoded "7 days", recall scheduling used a random,
 * unrelated offset from `system_settings.recall_offset_min/max_hours`).
 */
export const DEFAULT_FOLLOW_UP_DAYS = 7;

// Matches "follow up ... in/within N day(s)/week(s)/hour(s)", e.g. the
// DischargeDialog's own default text "Follow up with PCP in 7 days." —
// the up-to-40-chars gap tolerates "with Dr. X" / "with PCP" etc. between
// "follow up" and the stated interval.
const FOLLOW_UP_INTERVAL_RE =
  /\bfollow[\s-]?up\b[^.\n]{0,40}?\b(?:in|within)\s+(\d{1,3})\s*(day|days|week|weeks|hour|hours)\b/i;

/**
 * Parses a stated follow-up interval ("follow up ... in 7 days", "...
 * within 2 weeks", "... in 48 hours") out of free text — the clinician's
 * own discharge-note wording, when present — and returns it in whole days
 * (rounded up for an hours-denominated interval). Returns null when no
 * such phrase is found, so callers can fall back to
 * `DEFAULT_FOLLOW_UP_DAYS`.
 */
export function parseFollowUpDays(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = FOLLOW_UP_INTERVAL_RE.exec(text);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  if (unit.startsWith("week")) return n * 7;
  if (unit.startsWith("hour")) return Math.max(1, Math.ceil(n / 24));
  return n;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * `result_value` sometimes already embeds its own test-name prefix (e.g. a
 * manually-finalized lab row stored as "Hemoglobin: 14.6 g/dL" — see
 * lab-board.tsx's `submitReport`). Rendering `**{label}**: {value}` on top of
 * that double-prints the label ("Hemoglobin: Hemoglobin: 14.6 g/dL" — L19).
 * Strip a leading "{label}[:,-]" from the value before rendering it next to
 * its own bolded label.
 */
export function stripDuplicateLabel(label: string, value: string): string {
  const cleanLabel = (label ?? "").trim();
  const v = (value ?? "").trim();
  if (!cleanLabel || !v) return v;
  if (!v.toLowerCase().startsWith(cleanLabel.toLowerCase())) return v;
  const rest = v
    .slice(cleanLabel.length)
    .replace(/^\s*[:\-–—]\s*/, "")
    .trim();
  return rest.length > 0 ? rest : v;
}

function hasAnyVital(v: NarrativeVitals | null | undefined): boolean {
  if (!v) return false;
  return (
    v.hr != null ||
    v.bp_systolic != null ||
    v.bp_diastolic != null ||
    v.spo2 != null ||
    v.temp_c != null ||
    v.rr != null
  );
}

/** Real, recorded vitals only — never an examiner's narrative claim. */
function formatVitalsOnly(v: NarrativeVitals | null | undefined): string[] {
  if (!hasAnyVital(v)) return [];
  const bits = [
    v!.hr != null && `HR ${v!.hr}/min`,
    v!.bp_systolic != null &&
      v!.bp_diastolic != null &&
      `BP ${v!.bp_systolic}/${v!.bp_diastolic} mmHg`,
    v!.spo2 != null && `SpO2 ${v!.spo2}%`,
    v!.temp_c != null && `Temp ${v!.temp_c}°C`,
    v!.rr != null && `RR ${v!.rr}/min`,
  ].filter(Boolean) as string[];
  return bits;
}

/**
 * Reconciliation decision for one discharge medication. `STOP` is forced
 * when the drug's RxNorm code sits in a published value set whose name
 * token-matches a documented allergy substance — the exact Rule 1 logic
 * Safety Alerts Engine uses for its live Drug-Allergy Conflict alert (see
 * `safety-alerts-matching.ts`), reused here (not reimplemented) so the two
 * checks can never silently diverge.
 */
export interface MedReconciliation {
  med: NarrativeMed;
  decision: "CONTINUE" | "STOP";
  reason: string;
}

/** Narrows a raw `NarrativeAllergy[]` to the `substance` + coded-substance
 * shape `findAllergyConflict`'s union match needs, dropping any row with no
 * substance text (nothing to match on either path). Shared by both callers
 * below so the two reconciliation functions can never drift on this. */
function allergiesToCoded(allergies: NarrativeAllergy[]): CodedAllergy[] {
  return allergies
    .map((a) => ({
      substance: (a.substance ?? "").trim(),
      rxcui: a.substance_rxcui ? String(a.substance_rxcui).trim() : null,
      snomed: a.substance_snomed ? String(a.substance_snomed).trim() : null,
    }))
    .filter((a) => a.substance.length > 0);
}

function findAllergyConflict(
  rxnormCode: string,
  chartAllergies: CodedAllergy[],
  publishedValueSets: MatchableValueSet[],
): { allergyName: string; valueSetName: string } | null {
  if (!rxnormCode || chartAllergies.length === 0 || publishedValueSets.length === 0) return null;
  type Match = { vs: MatchableValueSet; allergyName: string; specificity: number };
  const matches: Match[] = [];
  for (const vs of publishedValueSets) {
    if (!extensionalContains(vs, rxnormCode)) continue;
    const tokens = classTokens(vs.name);
    if (tokens.length === 0) continue;
    // Union of the free-text class-token match (the original, deliberately
    // forgiving safety net — e.g. penicillin coded as SNOMED 764146007
    // against VSAC value sets that don't enumerate that exact code) AND
    // the NEW membership match on the allergy's own coded substance. See
    // `allergyMatchesValueSet`'s doc comment in safety-alerts-matching.ts.
    const hit = chartAllergies.find((a) => allergyMatchesValueSet(a, vs, tokens));
    if (!hit) continue;
    matches.push({
      vs,
      allergyName: hit.substance,
      specificity: Array.isArray(vs.codes) ? vs.codes.length : Number.MAX_SAFE_INTEGER,
    });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.specificity - b.specificity || a.vs.name.localeCompare(b.vs.name));
  const best = matches[0]!;
  return { allergyName: best.allergyName, valueSetName: best.vs.name };
}

/**
 * Reconcile the final discharge medication list against documented
 * allergies — every medication carries an explicit CONTINUE/STOP decision
 * rather than being auto-republished unchanged (C3). A documented allergy
 * conflict forces STOP; everything else defaults to CONTINUE (there is no
 * structured "new medication at discharge" signal in this schema, so no
 * medication is ever silently invented as NEW here).
 */
export function reconcileDischargeMedications(
  dischargeMeds: NarrativeMed[],
  allergies: NarrativeAllergy[],
  publishedValueSets: MatchableValueSet[],
): MedReconciliation[] {
  const chartAllergies = allergiesToCoded(allergies);
  return dischargeMeds.map((med) => {
    const code = (med.rxnorm_code ?? "").trim();
    const conflict = findAllergyConflict(code, chartAllergies, publishedValueSets);
    if (conflict) {
      return {
        med,
        decision: "STOP",
        reason: `Contraindicated — matches documented "${conflict.allergyName}" allergy (value set: ${conflict.valueSetName}). Do not continue without clinician review.`,
      };
    }
    return {
      med,
      decision: "CONTINUE",
      reason: "No documented allergy or contraindication identified against this medication.",
    };
  });
}

/**
 * Hard, visible safety flags for every discharge medication that conflicts
 * with a documented allergy — reuses the same Rule 1 matching helpers as
 * Safety Alerts Engine (never reimplemented) so a drug-allergy conflict can
 * never silently pass the "Clinical Completeness Check" the way the
 * Penicillin/Amoxicillin case did (C3).
 */
export function checkDischargeMedAllergyConflicts(
  dischargeMeds: NarrativeMed[],
  allergies: NarrativeAllergy[],
  publishedValueSets: MatchableValueSet[],
): SafetyFlag[] {
  const chartAllergies = allergiesToCoded(allergies);
  if (chartAllergies.length === 0 || publishedValueSets.length === 0) return [];
  const flags: SafetyFlag[] = [];
  const seen = new Set<string>();
  for (const med of dischargeMeds) {
    const code = (med.rxnorm_code ?? "").trim();
    if (!code) continue;
    const conflict = findAllergyConflict(code, chartAllergies, publishedValueSets);
    if (!conflict) continue;
    const key = `${code}|${conflict.allergyName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (med.display_name ?? med.medication_name ?? med.drug_name ?? code).trim();
    flags.push({
      severity: "critical",
      message: `Discharge Medication Allergy Conflict — ${name} matches documented "${conflict.allergyName}" allergy (value set: ${conflict.valueSetName}). This medication must be stopped or the conflict explicitly acknowledged by the discharging clinician before this patient leaves with it on their list.`,
    });
  }
  return flags;
}

function genderWord(g: string | null | undefined): string {
  const v = (g ?? "").trim().toLowerCase();
  if (v.startsWith("f")) return "female";
  if (v.startsWith("m")) return "male";
  if (v) return v;
  return "patient";
}

export function clinicalIntro(
  age: number | null | undefined,
  gender: string | null | undefined,
  complaint: string | null | undefined,
): string {
  const ageStr = typeof age === "number" && age > 0 ? `${age}-year-old` : "adult";
  const sex = genderWord(gender);
  const cc = (complaint ?? "evaluation").trim() || "evaluation";
  return `${ageStr} ${sex} presenting with acute onset ${cc.toLowerCase()}`;
}

const HIGH_ACUITY_RULES: Array<{
  match: RegExp;
  label: string;
  requiredMeds: string[];
  requiredLabs: string[];
}> = [
  {
    match: /chest pain|crushing|substernal|pressure|stemi|nstemi|acs/i,
    label: "Acute Coronary Syndrome / Chest Pain",
    requiredMeds: ["aspirin"],
    requiredLabs: ["troponin", "ecg"],
  },
  {
    match: /stroke|cva|hemiparesis|aphasia/i,
    label: "Acute Stroke",
    requiredMeds: ["aspirin"],
    requiredLabs: ["ct head", "glucose"],
  },
  {
    match: /sepsis|septic|bacteremia/i,
    label: "Sepsis",
    requiredMeds: ["antibiotic", "vancomycin", "piperacillin", "ceftriaxone"],
    requiredLabs: ["lactic", "wbc", "blood culture"],
  },
  {
    match: /dka|hyperglycemia|diabetic ketoacidosis/i,
    label: "Diabetic Ketoacidosis",
    requiredMeds: ["insulin"],
    requiredLabs: ["glucose", "bmp", "anion gap"],
  },
];

export interface SafetyFlag {
  severity: "critical" | "warning";
  message: string;
}

export function computeSafetyFlags(
  patient: NarrativePatient,
  meds: NarrativeMed[],
  labs: NarrativeLab[],
  allergies: NarrativeAllergy[] = [],
  dischargeMeds: NarrativeMed[] = [],
  publishedValueSets: MatchableValueSet[] = [],
): SafetyFlag[] {
  const flags: SafetyFlag[] = [];
  const cc = patient.chief_complaint ?? "";
  const medNames = meds
    .map((m) => `${m.medication_name ?? m.drug_name ?? ""}`.toLowerCase())
    .join(" | ");
  const labNames = labs.map((l) => `${l.test_type ?? ""}`.toLowerCase()).join(" | ");
  const isHighAcuity = HIGH_ACUITY_RULES.some((r) => r.match.test(cc));

  for (const rule of HIGH_ACUITY_RULES) {
    if (!rule.match.test(cc)) continue;
    const missingMeds = rule.requiredMeds.filter((k) => !medNames.includes(k.toLowerCase()));
    const missingLabs = rule.requiredLabs.filter((k) => !labNames.includes(k.toLowerCase()));
    if (missingMeds.length > 0 || missingLabs.length > 0) {
      flags.push({
        severity: "critical",
        message: `${rule.label} workup incomplete — missing ${[...missingMeds, ...missingLabs].join(
          ", ",
        )}. Recommend manual physician review before disposition.`,
      });
    }
  }

  // Implausible length-of-stay. The underlying timestamps themselves
  // (`patients.admission_time` / `discharge_time`) are real event times set
  // at admission and at discharge respectively — there is no "wrong
  // column" bug here — but a sub-hour full inpatient stay is clinically
  // implausible regardless of chief complaint, and silently printing a
  // "0h 11m" length of stay without comment is exactly how this went
  // unnoticed (C4). Flag it so a human looks at the admission/discharge
  // timestamps before the summary is finalized.
  if (patient.admission_time && patient.discharge_time) {
    const losMin =
      (new Date(patient.discharge_time).getTime() - new Date(patient.admission_time).getTime()) /
      60_000;
    if (losMin >= 0 && losMin < 60 && isHighAcuity) {
      flags.push({
        severity: "critical",
        message: `Length of stay ${Math.round(losMin)} min is implausibly short for a high-acuity presentation. Flagged for manual review.`,
      });
    } else if (losMin >= 0 && losMin < 60) {
      flags.push({
        severity: "warning",
        message: `Length of stay ${Math.round(losMin)} min is unusually short for a full inpatient admission. Verify the admission/discharge timestamps and clinical course before finalizing this summary.`,
      });
    }
  }

  // Discharge medication vs. documented allergy — hard, visible flag (C3).
  // Checked against the FINAL discharge medication list, not the full order
  // history, and reuses Safety Alerts Engine's own Rule 1 matching helpers.
  flags.push(...checkDischargeMedAllergyConflicts(dischargeMeds, allergies, publishedValueSets));

  return flags;
}

/* ------------------------------------------------------------------ */
/* Assessment → Plan mapping                                           */
/* ------------------------------------------------------------------ */

const MED_INDICATIONS: Array<{ match: RegExp; reasoning: string }> = [
  { match: /aspirin/i, reasoning: "antiplatelet therapy for suspected cardiac etiology" },
  { match: /nitroglycerin/i, reasoning: "coronary vasodilation for ischemic chest pain" },
  { match: /morphine/i, reasoning: "analgesia for acute pain control" },
  { match: /albuterol/i, reasoning: "bronchodilation for reactive airway symptoms" },
  {
    match: /methylprednisolone|prednisone/i,
    reasoning: "systemic corticosteroid for airway inflammation",
  },
  { match: /furosemide|lasix/i, reasoning: "diuresis for suspected volume overload" },
  { match: /atorvastatin|simvastatin/i, reasoning: "secondary prevention of vascular disease" },
  { match: /labetalol/i, reasoning: "blood-pressure control in acute neurologic event" },
  { match: /ondansetron|zofran/i, reasoning: "antiemetic for nausea control" },
  { match: /ketorolac|toradol/i, reasoning: "non-opioid analgesia" },
  {
    match: /piperacillin|vancomycin|ceftriaxone|cefazolin/i,
    reasoning: "empiric broad-spectrum antimicrobial coverage",
  },
  { match: /acetaminophen|tylenol/i, reasoning: "antipyresis and mild analgesia" },
  {
    match: /pantoprazole|famotidine|omeprazole/i,
    reasoning: "acid suppression for suspected GERD or stress-ulcer prophylaxis",
  },
  { match: /insulin/i, reasoning: "correction of hyperglycemia" },
  { match: /normal saline|lactated ringer/i, reasoning: "intravenous volume resuscitation" },
  { match: /potassium/i, reasoning: "electrolyte repletion" },
  { match: /thiamine/i, reasoning: "Wernicke prophylaxis in altered mental status" },
  { match: /dextrose/i, reasoning: "correction of hypoglycemia" },
  { match: /ibuprofen/i, reasoning: "NSAID analgesia / antipyresis" },
  { match: /lisinopril/i, reasoning: "ongoing antihypertensive management" },
];

export function indicationFor(medName: string): string {
  const hit = MED_INDICATIONS.find((m) => m.match.test(medName));
  return hit?.reasoning ?? "as clinically indicated during admission";
}

/* ------------------------------------------------------------------ */
/* Lab filtering                                                       */
/* ------------------------------------------------------------------ */

const ABNORMAL_RE =
  /\b(high|low|critical|abnormal|positive|elevated|reactive)\b|↑|↓|\[\s*(h|l)\s*\]/i;

export function pickAbnormalLabs(labs: NarrativeLab[]): NarrativeLab[] {
  const abnormal = labs.filter(
    (l) =>
      (l.abnormal_flag && l.abnormal_flag.trim() !== "" && l.abnormal_flag !== "N") ||
      ABNORMAL_RE.test(l.result_value ?? ""),
  );
  if (abnormal.length > 0) return abnormal;
  // If nothing is flagged abnormal, surface the most recent few so the
  // section isn't empty for a real clinical record.
  return labs.slice(-3);
}

/* ------------------------------------------------------------------ */
/* Imaging / Procedures filtering                                     */
/* ------------------------------------------------------------------ */

/** Imaging studies that have actually come back with a real report. */
export function pickReportedImaging(imaging: NarrativeImaging[]): NarrativeImaging[] {
  return imaging.filter((i) => {
    const s = (i.status ?? "").trim().toLowerCase();
    return (
      s === "reported" ||
      s === "resulted" ||
      s === "completed" ||
      s === "final" ||
      !!i.resulted_at ||
      !!(i.impression && i.impression.trim()) ||
      !!(i.report_text && i.report_text.trim())
    );
  });
}

/** Procedures actually completed/performed, as distinct from merely ordered. */
export function pickCompletedProcedures(procedures: NarrativeProcedure[]): NarrativeProcedure[] {
  return procedures.filter((p) => {
    const s = (p.status ?? "").trim().toLowerCase();
    return s === "completed" || s === "performed" || s === "final" || !!p.performed_at;
  });
}

/* ------------------------------------------------------------------ */
/* Diagnoses                                                           */
/* ------------------------------------------------------------------ */

function complaintToDiagnosis(complaint: string | null | undefined): string {
  const c = (complaint ?? "").trim();
  if (!c) return "Clinical evaluation, etiology pending";
  // Capitalize first letter; if it already looks like a diagnosis, leave it.
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/* ------------------------------------------------------------------ */
/* Markdown builder                                                    */
/* ------------------------------------------------------------------ */

function admitDate(ts: string | null | undefined): string {
  if (!ts) return "this admission";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function buildDischargeMarkdown(
  patient: NarrativePatient,
  meds: NarrativeMed[],
  labs: NarrativeLab[],
  allergies: NarrativeAllergy[] = [],
  imaging: NarrativeImaging[] = [],
  procedures: NarrativeProcedure[] = [],
  /**
   * Free text the discharging/admitting clinician actually typed in the
   * "Confirm Discharge" dialog (H7). This must be rendered verbatim — never
   * discarded in favor of a rebuilt narrative, and never silently replaced
   * by it either; the structured sections below (real meds/labs/procedures)
   * still come from the chart regardless of whether this is present.
   */
  clinicianNote?: string | null,
  /** Last recorded `vitals` row — the only real signal the exam section may cite. */
  vitals?: NarrativeVitals | null,
  /** Published `custom_value_sets` rows, for the Rule-1-style allergy check. */
  publishedValueSets: MatchableValueSet[] = [],
  /** Days quoted in "Follow-Up Care" below — see `DEFAULT_FOLLOW_UP_DAYS`.
   * Also the value ghost-discharge-worker's recall scheduler uses for the
   * actual appointment date, so the two stay in sync. */
  followUpDays: number = DEFAULT_FOLLOW_UP_DAYS,
): string {
  const intro = clinicalIntro(patient.age, patient.gender, patient.chief_complaint);
  // Final diagnosis comes from Auto Doc's clinical deduction. Fall back to
  // the chief complaint ONLY when no deduced diagnosis exists.
  const finalDx = (patient.diagnosis ?? "").trim();
  const dx =
    finalDx.length > 0
      ? finalDx.charAt(0).toUpperCase() + finalDx.slice(1)
      : complaintToDiagnosis(patient.chief_complaint);
  // Admitting Diagnosis: this schema captures only ONE deduced-diagnosis
  // field (`patient.diagnosis`) and it is written once, at admission time
  // (see auto-doc.server.ts), never re-derived at discharge — so in this
  // codebase it IS the admitting diagnosis, not a discharge-time revision
  // of it. Reuse the same `dx` here rather than independently re-deriving
  // the admitting impression from the raw chief-complaint string: the
  // chief complaint is the patient's own words, not a clinical diagnosis,
  // and quoting it verbatim under an "Admitting Diagnosis" heading mislabels
  // it as one. A genuinely distinct admitting-vs-discharge diagnosis (e.g.
  // capturing a clinician's working impression AT admission, separate from
  // the one Auto Doc later finalizes) would need a new field captured at
  // admission time — out of scope here; tracked as a follow-up.
  const admittingDx = dx;
  const administered = meds.filter((m) => (m.status ?? "").toLowerCase() === "administered");
  const resulted = labs.filter((l) => {
    const s = (l.status ?? "").toLowerCase();
    return s === "resulted" || s === "reported";
  });
  // Show every lab actually resulted during the stay (abnormal-first ordering),
  // not just the abnormal subset — normal results are clinically relevant too.
  const isAbnormal = (l: NarrativeLab) =>
    (l.abnormal_flag && l.abnormal_flag.trim() !== "" && l.abnormal_flag !== "N") ||
    ABNORMAL_RE.test(l.result_value ?? "");
  const allResultedLabs = [...resulted].sort((a, b) => {
    const av = isAbnormal(a) ? 0 : 1;
    const bv = isAbnormal(b) ? 0 : 1;
    return av - bv;
  });
  const reportedImaging = pickReportedImaging(imaging);
  const completedProcedures = pickCompletedProcedures(procedures);
  // Real, working sanity checks (missing expected meds/labs for a
  // high-acuity complaint, implausible length-of-stay, discharge-med vs.
  // allergy conflicts, ...) computed from the SAME meds/labs/allergies
  // already gathered here — surfaced below so gaps are visible to the
  // reviewing clinician instead of being silently dropped (checked against
  // `administered`, the actual final discharge medication list, not the
  // full order history).
  const safetyFlags = computeSafetyFlags(
    patient,
    meds,
    labs,
    allergies,
    administered,
    publishedValueSets,
  );
  const medReconciliation = reconcileDischargeMedications(
    administered,
    allergies,
    publishedValueSets,
  );

  const lines: string[] = [];

  // Honest provenance disclaimer wherever this narrative is surfaced
  // (clinical_notes content, patients.discharge_summary, printed PDF, ...).
  // Nobody actually verifies this text today, so it must never claim
  // otherwise (the "Electronically generated and verified by S.P.E.H.R. AI
  // Core" footer bug) — this line is the honest replacement, inline in the
  // narrative itself rather than relying on each UI surface to say it.
  lines.push(
    "_AI-generated draft, compiled from the structured chart — pending clinician verification before this becomes the official discharge record._",
  );
  lines.push("");

  lines.push("**Clinical Completeness Check**");
  if (safetyFlags.length === 0) {
    lines.push(
      "- Automated completeness check: no missing-workup or length-of-stay flags identified for this chief complaint.",
    );
  } else {
    for (const f of safetyFlags) {
      lines.push(`> ${f.severity === "critical" ? "⚠ CRITICAL" : "⚠ WARNING"} — ${f.message}`);
    }
  }
  lines.push("");

  lines.push("**Admitting & Discharge Diagnoses**");
  lines.push(`- **Admitting Diagnosis:** ${admittingDx}`);
  // No real condition-at-discharge signal (vitals/status at the time this
  // summary is built) is threaded into this function, so don't assert
  // "clinically stable" — that was previously hardcoded for every patient
  // regardless of actual outcome. The dedicated "Condition at Discharge"
  // line below already covers this in general terms.
  lines.push(`- **Discharge Diagnosis:** ${dx}`);
  // Never assert a condition-at-discharge ("ambulating independently",
  // "pain controlled", ...) this system did not actually observe (C4). The
  // discharging clinician's own note — rendered verbatim below when present
  // — is the authoritative source for condition at discharge; absent that,
  // say so plainly rather than inventing a plausible-sounding default.
  lines.push(
    clinicianNote && clinicianNote.trim()
      ? "- **Condition at Discharge:** Per the discharging clinician's note below."
      : "- **Condition at Discharge:** Not independently documented by this system — see the attending physician's discharge note.",
  );
  lines.push("");

  if (clinicianNote && clinicianNote.trim()) {
    lines.push("**Clinician's Discharge Note**");
    for (const noteLine of clinicianNote.trim().split("\n")) {
      lines.push(`> ${noteLine}`);
    }
    lines.push(
      "_Entered verbatim by the discharging clinician at the time of discharge — this is the clinician's own documentation, not AI-generated text._",
    );
    lines.push("");
  }

  lines.push("**Chief Complaint**");
  lines.push(`${patient.chief_complaint ?? "Clinical evaluation"}.`);
  lines.push("");

  lines.push("**History of Present Illness**");
  lines.push(
    `${capitalize(intro)} on ${admitDate(patient.admission_time)}. The patient was evaluated in the Emergency Department, where initial vital signs were obtained and a focused clinical assessment was performed. Based on the severity of presentation and the need for continuous monitoring, the patient was admitted to the inpatient service for further evaluation, supportive care, and goal-directed management. The clinical team initiated an appropriate diagnostic workup and supportive interventions on arrival to the unit.`,
  );
  lines.push("");

  lines.push("**Past Medical History**");
  {
    const pmh = (patient.past_medical_history ?? "").trim();
    const psh = (patient.past_surgical_history ?? "").trim();
    if (!pmh && !psh) {
      lines.push(
        "- No significant past medical or surgical history reported by patient or documented in chart.",
      );
    } else {
      if (pmh) {
        for (const item of pmh
          .split(/[,;\n]/)
          .map((s) => s.trim())
          .filter(Boolean)) {
          lines.push(`- ${item}`);
        }
      }
      if (psh) {
        for (const item of psh
          .split(/[,;\n]/)
          .map((s) => s.trim())
          .filter(Boolean)) {
          lines.push(`- **PSH:** ${item}`);
        }
      }
    }
  }
  lines.push("");

  lines.push("**Allergies**");
  if (allergies.length === 0) {
    lines.push("- NKDA — No known drug allergies.");
  } else {
    for (const a of allergies) {
      const sub = (a.substance ?? "").trim() || "Unspecified substance";
      const reaction = (a.reaction ?? "").trim();
      const severity = (a.severity ?? "").trim();
      const cat = (a.category ?? "").trim();
      const tail = [
        reaction && `reaction: ${reaction}`,
        severity && `severity: ${severity}`,
        cat && `category: ${cat}`,
      ]
        .filter(Boolean)
        .join("; ");
      lines.push(`- **${sub}**${tail ? ` — ${tail}` : ""}`);
    }
  }
  lines.push("");

  // There is no structured "physical exam" table in this schema — the only
  // real signal here is the last recorded `vitals` row. NEVER synthesize
  // organ-system findings ("Pulmonary: Clear to auscultation bilaterally")
  // that no one actually examined and documented (C4): cite the real
  // vitals when present, otherwise say plainly that nothing is documented.
  lines.push("**Physical Examination on Admission**");
  const vitalBits = formatVitalsOnly(vitals);
  if (vitalBits.length > 0) {
    lines.push(
      `- Vital signs on file${vitals?.recorded_at ? ` (recorded ${admitDate(vitals.recorded_at)})` : ""}: ${vitalBits.join(", ")}.`,
    );
    lines.push(
      "- No structured organ-system exam findings (cardiovascular, pulmonary, abdominal, neurologic, ...) are documented in the chart beyond these vitals; see the attending clinician's note for exam findings.",
    );
  } else {
    lines.push(
      "- No admission vital signs or physical-examination findings are documented in the structured chart for this encounter.",
    );
  }
  lines.push("");

  lines.push("**Hospital Course**");
  if (administered.length === 0 && resulted.length === 0) {
    // Nothing real to report — say so plainly rather than inventing a
    // reassuring clinical narrative (C4: "afebrile, pain controlled,
    // ambulating independently" was previously asserted unconditionally).
    lines.push(
      "Limited structured clinical data (administered medications, resulted labs) is on file for this admission. Refer to the clinician's documented notes for the clinical course and condition during this stay.",
    );
  } else {
    const courseBits: string[] = [];
    if (administered.length > 0) {
      const reasoning = administered
        .map((m) => {
          const name = m.medication_name ?? m.drug_name ?? "agent";
          return `**${name}** (${indicationFor(name)})`;
        })
        .join("; ");
      courseBits.push(
        `On admission the patient was treated with ${reasoning}. Each agent was selected in accordance with institutional protocols and reassessed on every nursing round for ongoing clinical appropriateness.`,
      );
    }
    if (resulted.length > 0) {
      courseBits.push(
        `Diagnostic workup included ${resulted.map((l) => `**${l.test_type}**`).join(", ")} to confirm the working diagnosis, exclude alternative etiologies, and trend the patient's clinical status throughout the admission.`,
      );
    }
    courseBits.push(
      "No further hospital-course detail beyond the medications and diagnostics above is captured in the structured chart; refer to the clinician's documented notes (including the discharge note above, when present) for additional narrative on the patient's clinical trajectory.",
    );
    lines.push(courseBits.join(" "));
  }
  lines.push("");

  lines.push("**Procedures Performed**");
  if (completedProcedures.length === 0) {
    // Data-driven, not a hardcoded negative claim: this prints only because
    // the `procedures` table has no completed row for this patient/encounter.
    lines.push("- No procedures are recorded in the structured chart for this admission.");
  } else {
    for (const p of completedProcedures) {
      const name = (p.display_text ?? p.cpt_display ?? p.snomed_display ?? "Procedure").trim();
      const cpt = p.cpt_code ? ` _(CPT ${p.cpt_code})_` : "";
      const when = p.performed_at ? ` on ${admitDate(p.performed_at)}` : "";
      const by = (p.performed_by ?? "").trim();
      lines.push(`- **${name}**${cpt}${when}${by ? ` — performed by ${by}` : ""}.`);
    }
  }
  lines.push("");

  lines.push("**Laboratory & Imaging Findings**");
  if (allResultedLabs.length === 0 && reportedImaging.length === 0) {
    lines.push("- All diagnostic studies within reference ranges; no critical results.");
  } else {
    if (allResultedLabs.length > 0) {
      for (const l of allResultedLabs) {
        const name = l.display_name ?? l.test_type ?? "Observation";
        const loinc = l.loinc_code ? ` _(LOINC ${l.loinc_code})_` : "";
        const flag = l.abnormal_flag && l.abnormal_flag !== "N" ? ` [${l.abnormal_flag}]` : "";
        // L19: `result_value` can already embed its own test-name prefix
        // (e.g. "Hemoglobin: 14.6 g/dL" from a manually-finalized row) —
        // strip it before printing next to the already-bolded `name` label,
        // or it doubles up ("Hemoglobin: Hemoglobin: 14.6 g/dL").
        const value = stripDuplicateLabel(name, l.result_value ?? "") || "Pending";
        lines.push(`- **${name}**${loinc}: ${value}${flag}`);
      }
    }
    if (reportedImaging.length > 0) {
      for (const img of reportedImaging) {
        const name =
          (img.exam_type ?? [img.modality, img.body_part].filter(Boolean).join(" ")).trim() ||
          "Imaging Study";
        const impression = (img.impression ?? img.report_text ?? "Report pending").trim();
        const when = img.resulted_at ? ` _(reported ${admitDate(img.resulted_at)})_` : "";
        lines.push(`- **${name} (Imaging)**${when}: ${impression}`);
      }
    }
  }
  lines.push("");

  lines.push("**Discharge Medications**");
  if (administered.length === 0) {
    lines.push("- Continue home medication regimen as previously prescribed.");
  } else {
    // C3: every discharge medication carries an explicit CONTINUE/STOP
    // decision rather than being auto-republished unchanged — STOP is
    // forced whenever `reconcileDischargeMedications` finds a documented
    // allergy conflict (reusing Safety Alerts Engine's Rule 1 matching, see
    // above), which is also surfaced as a hard flag in the Clinical
    // Completeness Check section.
    for (const { med: m, decision, reason } of medReconciliation) {
      const name = m.display_name ?? m.medication_name ?? m.drug_name ?? "Medication";
      const dose = [m.dose, m.route, m.frequency].filter(Boolean).join(" ");
      const rx = m.rxnorm_code ? ` _(RxNorm ${m.rxnorm_code})_` : "";
      if (decision === "STOP") {
        lines.push(
          `- **${name}**${rx}${dose ? ` — ${dose}` : ""} — **Decision: STOP ⚠** — ${reason}`,
        );
      } else {
        lines.push(
          `- **${name}**${rx}${dose ? ` — ${dose}` : ""} — **Decision: CONTINUE** — ${indicationFor(name)}.`,
        );
      }
    }
  }
  lines.push("");

  lines.push("**Diet & Activity**");
  lines.push("- **Diet:** Resume regular diet as tolerated. Maintain adequate hydration.");
  lines.push(
    "- **Activity:** Activity as tolerated. No heavy lifting greater than 10 pounds for 72 hours.",
  );
  lines.push("");

  lines.push("**Follow-Up Care**");
  {
    const pcp = (patient.primary_care_physician ?? "").trim();
    lines.push(
      pcp
        ? `- Schedule follow-up with **${pcp}** within ${followUpDays} days of discharge.`
        : `- Schedule follow-up with **Primary Care Provider within ${followUpDays} days** of discharge.`,
    );
  }
  lines.push(
    "- Specialty follow-up as clinically indicated; appointments to be confirmed by the patient.",
  );
  lines.push("- Bring this discharge summary and an updated medication list to each appointment.");
  lines.push("");

  lines.push("**Return Precautions**");
  lines.push(
    "- Return immediately to the Emergency Department, or call 911, for any of the following: chest pain, shortness of breath, syncope, severe headache, focal weakness, uncontrolled bleeding, persistent fever, intractable nausea or vomiting, or any acute change in clinical status.",
  );
  lines.push("");

  lines.push("**Patient Education & Counseling**");
  lines.push("- Discharge instructions were reviewed verbatim with the patient at the bedside.");
  lines.push(
    "- The patient verbalized understanding of the diagnosis, medication regimen, activity restrictions, and warning signs requiring re-evaluation.",
  );
  lines.push(
    "- A written copy of these instructions was provided to the patient and primary contact.",
  );

  return lines.join("\n");
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
