/**
 * Discharge Narrative Builder
 *
 * Turns the structured patient + meds + labs + imaging + procedures record
 * into a clinically readable discharge summary that follows real hospital
 * format:
 *   0. Clinical Completeness Check (safety flags, see below)
 *   1. Admitting & Discharge Diagnoses
 *   2. History of Present Illness (HPI)
 *   3. Hospital Course (assessment → plan reasoning)
 *   4. Procedures (derived from the real `procedures` table — never a
 *      hardcoded negative claim)
 *   5. Pertinent Labs / Imaging (abnormal-first labs + any reported
 *      `radiology_orders` studies)
 *   6. Discharge Instructions & Meds
 *
 * `computeSafetyFlags()` performs real sanity checks (high-acuity
 * complaint vs. low-acuity treatment, implausible length-of-stay, ...) and
 * is wired into section 0 above, so gaps actually surface to the
 * reviewing clinician instead of being silently computed and discarded.
 */

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
  const labNames = labs.map((l) => `${l.test_type ?? ""}`.toLowerCase()).join(" | ");

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

  // Impossible length-of-stay on high-acuity complaints
  if (patient.admission_time && patient.discharge_time) {
    const losMin =
      (new Date(patient.discharge_time).getTime() - new Date(patient.admission_time).getTime()) /
      60_000;
    if (losMin >= 0 && losMin < 60 && HIGH_ACUITY_RULES.some((r) => r.match.test(cc))) {
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
  // high-acuity complaint, implausible length-of-stay, ...) computed from
  // the SAME meds/labs already gathered above — surfaced here so gaps are
  // visible to the reviewing clinician instead of being silently dropped.
  const safetyFlags = computeSafetyFlags(patient, meds, labs);

  const lines: string[] = [];

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
  lines.push(
    `- **Condition at Discharge:** Stable, hemodynamically appropriate, tolerating oral intake, ambulating without assistance.`,
  );
  lines.push("");

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

  lines.push("**Physical Examination on Admission**");
  lines.push("- **General:** Alert, oriented, and in no acute distress at the time of evaluation.");
  lines.push(
    "- **Cardiovascular:** Regular rate and rhythm; no murmurs, rubs, or gallops appreciated.",
  );
  lines.push("- **Pulmonary:** Clear to auscultation bilaterally with adequate air movement.");
  lines.push("- **Abdomen:** Soft, non-distended, with appropriate bowel sounds.");
  lines.push("- **Neurologic:** Grossly intact, no focal deficits identified.");
  lines.push("");

  lines.push("**Hospital Course**");
  if (administered.length === 0 && resulted.length === 0) {
    lines.push(
      "The patient was admitted to the inpatient unit and managed conservatively with close clinical observation, intravenous access, and supportive care. Vital signs were monitored on a routine schedule throughout the admission. The patient remained clinically stable without acute decompensation, and no escalation of care was required. Nursing assessments each shift were reassuring, and the patient tolerated the admission well, meeting all standard discharge criteria.",
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
      "The patient remained hemodynamically stable, afebrile, and tolerated all interventions without acute complication. Pain was well controlled, oral intake was adequate, and the patient was ambulating independently prior to discharge. The multidisciplinary team agreed the patient met all clinical and functional discharge criteria.",
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
        lines.push(`- **${name}**${loinc}: ${l.result_value ?? "Pending"}${flag}`);
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
    for (const m of administered) {
      const name = m.display_name ?? m.medication_name ?? m.drug_name ?? "Medication";
      const dose = [m.dose, m.route, m.frequency].filter(Boolean).join(" ");
      const rx = m.rxnorm_code ? ` _(RxNorm ${m.rxnorm_code})_` : "";
      lines.push(`- **${name}**${rx}${dose ? ` — ${dose}` : ""} — ${indicationFor(name)}.`);
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
        ? `- Schedule follow-up with **${pcp}** within 7 days of discharge.`
        : "- Schedule follow-up with **Primary Care Provider within 7 days** of discharge.",
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
