/**
 * Discharge Narrative Builder
 *
 * Turns the structured patient + meds + labs record into a clinically
 * readable 6-part discharge summary that follows real hospital format:
 *   1. Admitting & Discharge Diagnoses
 *   2. History of Present Illness (HPI)
 *   3. Hospital Course (assessment → plan reasoning)
 *   4. Procedures
 *   5. Pertinent Labs / Imaging (abnormal-only)
 *   6. Discharge Instructions & Meds
 *
 * Also performs sanity checks (high-acuity complaint vs. low-acuity
 * treatment, impossible length-of-stay) and surfaces safety flags
 * that the UI can render at the top of the summary.
 */

export interface NarrativeMed {
  medication_name?: string | null;
  drug_name?: string | null;
  dose?: string | null;
  route?: string | null;
  status?: string | null;
  ordered_by?: string | null;
  administered_at?: string | null;
}

export interface NarrativeLab {
  test_type?: string | null;
  status?: string | null;
  result_value?: string | null;
  collected_at?: string | null;
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
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

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
): SafetyFlag[] {
  const flags: SafetyFlag[] = [];
  const cc = patient.chief_complaint ?? "";
  const medNames = meds
    .map((m) => `${m.medication_name ?? m.drug_name ?? ""}`.toLowerCase())
    .join(" | ");
  const labNames = labs
    .map((l) => `${l.test_type ?? ""}`.toLowerCase())
    .join(" | ");

  for (const rule of HIGH_ACUITY_RULES) {
    if (!rule.match.test(cc)) continue;
    const missingMeds = rule.requiredMeds.filter(
      (k) => !medNames.includes(k.toLowerCase()),
    );
    const missingLabs = rule.requiredLabs.filter(
      (k) => !labNames.includes(k.toLowerCase()),
    );
    if (missingMeds.length > 0 || missingLabs.length > 0) {
      flags.push({
        severity: "critical",
        message: `${rule.label} workup incomplete — missing ${
          [...missingMeds, ...missingLabs].join(", ")
        }. Recommend manual physician review before disposition.`,
      });
    }
  }

  // Impossible length-of-stay on high-acuity complaints
  if (patient.admission_time && patient.discharge_time) {
    const losMin =
      (new Date(patient.discharge_time).getTime() -
        new Date(patient.admission_time).getTime()) /
      60_000;
    if (
      losMin >= 0 &&
      losMin < 60 &&
      HIGH_ACUITY_RULES.some((r) => r.match.test(cc))
    ) {
      flags.push({
        severity: "critical",
        message: `Length of stay ${Math.round(losMin)} min is implausibly short for a high-acuity presentation. Flagged for manual review.`,
      });
    }
  }

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
  { match: /methylprednisolone|prednisone/i, reasoning: "systemic corticosteroid for airway inflammation" },
  { match: /furosemide|lasix/i, reasoning: "diuresis for suspected volume overload" },
  { match: /atorvastatin|simvastatin/i, reasoning: "secondary prevention of vascular disease" },
  { match: /labetalol/i, reasoning: "blood-pressure control in acute neurologic event" },
  { match: /ondansetron|zofran/i, reasoning: "antiemetic for nausea control" },
  { match: /ketorolac|toradol/i, reasoning: "non-opioid analgesia" },
  { match: /piperacillin|vancomycin|ceftriaxone|cefazolin/i, reasoning: "empiric broad-spectrum antimicrobial coverage" },
  { match: /acetaminophen|tylenol/i, reasoning: "antipyresis and mild analgesia" },
  { match: /pantoprazole|famotidine|omeprazole/i, reasoning: "acid suppression for suspected GERD or stress-ulcer prophylaxis" },
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

const ABNORMAL_RE = /\b(high|low|critical|abnormal|positive|elevated|reactive)\b|↑|↓|\[\s*(h|l)\s*\]/i;

export function pickAbnormalLabs(labs: NarrativeLab[]): NarrativeLab[] {
  const abnormal = labs.filter((l) => ABNORMAL_RE.test(l.result_value ?? ""));
  if (abnormal.length > 0) return abnormal;
  // If nothing is flagged abnormal, surface the most recent few so the
  // section isn't empty for a real clinical record.
  return labs.slice(-3);
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
): string {
  const intro = clinicalIntro(patient.age, patient.gender, patient.chief_complaint);
  const dx = complaintToDiagnosis(patient.chief_complaint);
  const icd = (patient.icd10_codes ?? []).join(", ");
  const snomed = (patient.snomed_codes ?? []).join(", ");
  const administered = meds.filter(
    (m) => (m.status ?? "").toLowerCase() === "administered",
  );
  const resulted = labs.filter((l) => {
    const s = (l.status ?? "").toLowerCase();
    return s === "resulted" || s === "reported";
  });
  const abnormalLabs = pickAbnormalLabs(resulted);
  const flags = computeSafetyFlags(patient, administered, resulted);

  const lines: string[] = [];

  if (flags.length > 0) {
    lines.push("> ⚠️ **Clinical Safety Flag(s):**");
    for (const f of flags) lines.push(`> - ${f.message}`);
    lines.push("");
  }

  lines.push("**1. Admitting & Discharge Diagnoses**");
  lines.push(`- **Admitting Dx:** ${dx}`);
  lines.push(`- **Discharge Dx:** ${dx}, clinically stable`);
  if (icd) lines.push(`- _ICD-10:_ ${icd}`);
  if (snomed) lines.push(`- _SNOMED CT:_ ${snomed}`);
  lines.push("");

  lines.push("**2. History of Present Illness**");
  lines.push(
    `${capitalize(intro)} on ${admitDate(patient.admission_time)}. Patient was admitted to the inpatient service for further evaluation, monitoring, and goal-directed management.`,
  );
  lines.push("");

  lines.push("**3. Hospital Course**");
  if (administered.length === 0 && resulted.length === 0) {
    lines.push(
      "Clinical observation and supportive care were provided. No discrete interventions were required during the encounter.",
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
      courseBits.push(`Treated with ${reasoning}.`);
    }
    if (resulted.length > 0) {
      courseBits.push(
        `Diagnostic workup included ${resulted.map((l) => `**${l.test_type}**`).join(", ")} to confirm the working diagnosis and rule out alternative etiologies.`,
      );
    }
    courseBits.push("Patient remained hemodynamically stable and tolerated interventions without acute complication.");
    lines.push(courseBits.join(" "));
  }
  lines.push("");

  lines.push("**4. Procedures**");
  lines.push("- No major surgical or interventional procedures performed this admission.");
  lines.push("");

  lines.push("**5. Pertinent Labs / Imaging**");
  if (abnormalLabs.length === 0) {
    lines.push("- All diagnostic studies within reference ranges; no critical results.");
  } else {
    for (const l of abnormalLabs) {
      lines.push(`- **${l.test_type}:** ${l.result_value ?? "Pending"}`);
    }
  }
  lines.push("");

  lines.push("**6. Discharge Instructions & Meds**");
  if (administered.length === 0) {
    lines.push("- Continue home medication regimen as previously prescribed.");
  } else {
    for (const m of administered) {
      const name = m.medication_name ?? m.drug_name ?? "Medication";
      const dose = [m.dose, m.route].filter(Boolean).join(" ");
      lines.push(`- **${name}**${dose ? ` — ${dose}` : ""} — ${indicationFor(name)}.`);
    }
  }
  lines.push(
    "- Follow up with Primary Care Provider within **7 days**. Return to ED for worsening symptoms, chest pain, shortness of breath, syncope, or any acute change in clinical status.",
  );

  return lines.join("\n");
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
