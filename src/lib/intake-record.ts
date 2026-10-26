/**
 * Admission Intake Record
 * -----------------------
 * Structured case-history data captured by the redesigned Admit modal.
 * Persisted to localStorage keyed by MRN so the patient chart can render
 * a true hospital-style admission history without requiring a schema
 * migration. Mirrors the linguistic structure of a real EHR intake form
 * (Demographics, CC, HPI, PMH/PSH, Allergies/Meds, Family Hx).
 */

export const CHRONIC_OPTIONS = [
  "Hypertension",
  "Type 2 Diabetes",
  "Type 1 Diabetes",
  "Asthma",
  "COPD",
  "Coronary Artery Disease",
  "Heart Failure",
  "CKD",
  "Stroke/TIA",
  "Atrial Fibrillation",
  "Hyperlipidemia",
  "Hypothyroidism",
  "Depression",
  "Anxiety",
  "GERD",
] as const;

export const CHARACTER_OPTIONS = [
  "Sharp",
  "Dull",
  "Throbbing",
  "Burning",
  "Crushing",
  "Aching",
  "Stabbing",
  "Pressure",
  "Cramping",
] as const;

export const FAMILY_OPTIONS = [
  "Hypertension",
  "Diabetes",
  "Heart Attack",
  "Stroke",
  "Cancer",
  "Hereditary Disorder",
  "Mental Illness",
] as const;

export const ENV_ALLERGY_OPTIONS = [
  "Latex",
  "Iodine",
  "Contrast Dye",
  "Peanuts",
  "Tree Nuts",
  "Shellfish",
  "Eggs",
  "Dairy",
  "Pollen",
  "Bee Sting",
] as const;

export const RELATIONSHIP_OPTIONS = [
  "Spouse",
  "Parent",
  "Child",
  "Sibling",
  "Friend",
  "Partner",
  "Guardian",
  "Other",
] as const;

export const SEX_OPTIONS = ["Male", "Female", "Intersex"] as const;
export const GENDER_IDENTITY_OPTIONS = [
  "Man",
  "Woman",
  "Non-binary",
  "Transgender Man",
  "Transgender Woman",
  "Prefer not to say",
] as const;

export const DURATION_OPTIONS = ["Constant", "Intermittent", "Episodic", "Progressive"] as const;

export interface CodedConcept {
  code: string;
  display: string;
  system: string;
}
export interface IntakeAllergy {
  name: string;
  reaction: string;
  code?: CodedConcept;
}
export interface IntakeMed {
  name: string;
  dose: string;
  freq: string;
  code?: CodedConcept;
}

export interface IntakeRecord {
  // Section 1 — Demographics
  firstName: string;
  lastName: string;
  dob: string; // YYYY-MM-DD
  age: number;
  sex: (typeof SEX_OPTIONS)[number] | "";
  genderIdentity: (typeof GENDER_IDENTITY_OPTIONS)[number] | "";
  address: string;
  phone: string;
  occupation: string;
  emergencyName: string;
  emergencyRelationship: (typeof RELATIONSHIP_OPTIONS)[number] | "";
  emergencyPhone: string;
  insuranceProvider: string;
  insurancePolicy: string;
  pcp: string;
  guarantor: string;

  // Section 2 — Chief Complaint
  chiefComplaint: string;
  chiefComplaintCode?: CodedConcept;

  // Section 3 — HPI
  hpiOnset: string;
  hpiLocation: string;
  hpiDuration: (typeof DURATION_OPTIONS)[number] | "";
  hpiCharacter: string[];
  hpiAggravating: string;
  hpiAlleviating: string;
  hpiSeverity: number; // 0-10

  // Section 4 — PMH/PSH
  chronicIllnesses: string[];
  chronicIllnessCodes?: CodedConcept[];
  priorSurgeries: string;
  pastHospitalizations: string;

  // Section 5 — Allergies & Current Meds
  drugAllergies: IntakeAllergy[];
  envAllergies: string[];
  currentMeds: IntakeMed[];

  // Section 6 — Family Hx
  familyConditions: string[];
  familyNotes: string;

  // NLP narrative (mirrors Smart Intake box)
  narrative: string;

  // Internal — set on admit
  mrn?: string;
  capturedAt?: string;
}

export function blankIntake(): IntakeRecord {
  return {
    firstName: "",
    lastName: "",
    dob: "",
    age: 0,
    sex: "",
    genderIdentity: "",
    address: "",
    phone: "",
    occupation: "",
    emergencyName: "",
    emergencyRelationship: "",
    emergencyPhone: "",
    insuranceProvider: "",
    insurancePolicy: "",
    pcp: "",
    guarantor: "",
    chiefComplaint: "",
    hpiOnset: "",
    hpiLocation: "",
    hpiDuration: "",
    hpiCharacter: [],
    hpiAggravating: "",
    hpiAlleviating: "",
    hpiSeverity: 0,
    chronicIllnesses: [],
    priorSurgeries: "",
    pastHospitalizations: "",
    drugAllergies: [],
    envAllergies: [],
    currentMeds: [],
    familyConditions: [],
    familyNotes: "",
    narrative: "",
  };
}

/* --------------------------- persistence ------------------------------- */
const KEY = (mrn: string) => `spehr.intake.${mrn}`;

export function saveIntake(mrn: string, rec: IntakeRecord): void {
  if (typeof window === "undefined" || !mrn) return;
  const payload: IntakeRecord = { ...rec, mrn, capturedAt: new Date().toISOString() };
  try {
    window.localStorage.setItem(KEY(mrn), JSON.stringify(payload));
  } catch {
    /* quota */
  }
}

export function loadIntake(mrn: string): IntakeRecord | null {
  if (typeof window === "undefined" || !mrn) return null;
  try {
    const raw = window.localStorage.getItem(KEY(mrn));
    return raw ? (JSON.parse(raw) as IntakeRecord) : null;
  } catch {
    return null;
  }
}

/* --------------------------- auto-fill --------------------------------- */
const FIRST_NAMES = [
  "James",
  "Mary",
  "Robert",
  "Patricia",
  "John",
  "Linda",
  "Michael",
  "Barbara",
  "William",
  "Elizabeth",
  "David",
  "Jennifer",
  "Richard",
  "Susan",
  "Joseph",
  "Margaret",
];
const LAST_NAMES = [
  "Smith",
  "Johnson",
  "Williams",
  "Brown",
  "Jones",
  "Garcia",
  "Miller",
  "Davis",
  "Rodriguez",
  "Martinez",
  "Hernandez",
  "Lopez",
  "Wilson",
  "Anderson",
  "Thomas",
  "Taylor",
];
const STREETS = [
  "Oak St",
  "Maple Ave",
  "Cedar Ln",
  "Pine Rd",
  "Elm Ct",
  "Birch Way",
  "Sunset Blvd",
  "Lakeview Dr",
];
const CITIES = [
  "Springfield",
  "Riverton",
  "Lakewood",
  "Fairview",
  "Madison",
  "Georgetown",
  "Salem",
  "Bristol",
];
const OCCUPATIONS = [
  "Teacher",
  "Construction Worker",
  "Software Engineer",
  "Retired",
  "Nurse",
  "Driver",
  "Accountant",
  "Chef",
  "Electrician",
  "Sales Manager",
  "Farmer",
  "Mechanic",
];
const INSURERS = [
  "Blue Cross Blue Shield",
  "Aetna",
  "UnitedHealthcare",
  "Cigna",
  "Humana",
  "Kaiser Permanente",
  "Medicare",
  "Medicaid",
];
const PCPS = [
  "Dr. Alan Reyes, MD",
  "Dr. Priya Shah, DO",
  "Dr. Marcus Lee, MD",
  "Dr. Elena Park, MD",
  "Dr. James O'Connor, MD",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickN<T>(arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++)
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}
function rngInt(lo: number, hi: number) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function pad(n: number) {
  return n.toString().padStart(2, "0");
}

function dobFromAge(age: number): string {
  const now = new Date();
  const year = now.getFullYear() - age;
  const month = rngInt(1, 12);
  const day = rngInt(1, 28);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Generate a plausible intake record. Optional seed nudges the chief
 *  complaint + HPI toward a specific presentation. */
export function autoFillIntake(seed?: Partial<IntakeRecord>): IntakeRecord {
  const age = seed?.age && seed.age > 0 ? seed.age : rngInt(28, 84);
  const sex: "Male" | "Female" = Math.random() < 0.5 ? "Male" : "Female";
  const first = seed?.firstName || pick(FIRST_NAMES);
  const last = seed?.lastName || pick(LAST_NAMES);
  const cc =
    seed?.chiefComplaint?.trim() ||
    pick([
      "Severe chest pain for the last two hours",
      "Shortness of breath since yesterday evening",
      "Sudden onset right-sided weakness",
      "Severe abdominal pain, started this morning",
      "Persistent fever and productive cough for 4 days",
    ]);
  const ccLower = cc.toLowerCase();
  const chronicGuess: string[] = [];
  if (/chest|cardiac|hf|chf/.test(ccLower))
    chronicGuess.push("Hypertension", "Coronary Artery Disease", "Hyperlipidemia");
  if (/breath|sob|copd|asthma/.test(ccLower)) chronicGuess.push("COPD", "Hypertension");
  if (/abdom|stomach|belly/.test(ccLower)) chronicGuess.push("GERD", "Type 2 Diabetes");
  if (/stroke|weakness|tia/.test(ccLower)) chronicGuess.push("Hypertension", "Atrial Fibrillation");
  if (chronicGuess.length === 0) chronicGuess.push(...pickN(CHRONIC_OPTIONS, 2));

  const medSeeds: IntakeMed[] = [];
  if (chronicGuess.includes("Hypertension"))
    medSeeds.push({ name: "Lisinopril", dose: "10 mg", freq: "PO Daily" });
  if (chronicGuess.includes("Type 2 Diabetes"))
    medSeeds.push({ name: "Metformin", dose: "500 mg", freq: "PO BID" });
  if (chronicGuess.includes("Hyperlipidemia"))
    medSeeds.push({ name: "Atorvastatin", dose: "40 mg", freq: "PO QHS" });
  if (chronicGuess.includes("Coronary Artery Disease"))
    medSeeds.push({ name: "Aspirin", dose: "81 mg", freq: "PO Daily" });
  if (chronicGuess.includes("Atrial Fibrillation"))
    medSeeds.push({ name: "Apixaban", dose: "5 mg", freq: "PO BID" });
  if (chronicGuess.includes("GERD"))
    medSeeds.push({ name: "Omeprazole", dose: "20 mg", freq: "PO Daily" });
  if (medSeeds.length === 0)
    medSeeds.push({ name: "Multivitamin", dose: "1 tab", freq: "PO Daily" });

  return {
    firstName: first,
    lastName: last,
    dob: dobFromAge(age),
    age,
    sex,
    genderIdentity: sex === "Male" ? "Man" : "Woman",
    address: `${rngInt(100, 9999)} ${pick(STREETS)}, ${pick(CITIES)}`,
    phone: `(${rngInt(200, 999)}) ${rngInt(200, 999)}-${rngInt(1000, 9999)}`,
    occupation: pick(OCCUPATIONS),
    emergencyName: `${pick(FIRST_NAMES)} ${last}`,
    emergencyRelationship: pick([
      "Spouse",
      "Child",
      "Parent",
      "Sibling",
    ]) as IntakeRecord["emergencyRelationship"],
    emergencyPhone: `(${rngInt(200, 999)}) ${rngInt(200, 999)}-${rngInt(1000, 9999)}`,
    insuranceProvider: pick(INSURERS),
    insurancePolicy: `POL-${rngInt(100000, 999999)}`,
    pcp: pick(PCPS),
    guarantor: "Self",
    chiefComplaint: cc,
    hpiOnset: `${rngInt(1, 12)} hours ago`,
    hpiLocation: /chest/.test(ccLower)
      ? "Substernal, radiates to left arm"
      : /abdom/.test(ccLower)
        ? "Right lower quadrant"
        : /breath/.test(ccLower)
          ? "Diffuse, worse on exertion"
          : /weakness/.test(ccLower)
            ? "Right upper and lower extremity"
            : "Generalized",
    hpiDuration: pick(DURATION_OPTIONS) as IntakeRecord["hpiDuration"],
    hpiCharacter: pickN(CHARACTER_OPTIONS, 2) as unknown as string[],
    hpiAggravating: pick(["Exertion", "Movement", "Deep breathing", "Eating", "Lying flat"]),
    hpiAlleviating: pick(["Rest", "Nitroglycerin", "Antacids", "Sitting upright", "NSAIDs"]),
    hpiSeverity: rngInt(5, 9),
    chronicIllnesses: Array.from(new Set(chronicGuess)).slice(0, 4),
    priorSurgeries: pick([
      "Appendectomy 2008 — no complications",
      "Cholecystectomy 2015 — uneventful recovery",
      "CABG x3 2019 — tolerated anesthesia well",
      "Hip replacement 2021 — physical therapy completed",
      "None reported",
    ]),
    pastHospitalizations: pick([
      "Admitted 2022 for pneumonia — 4 day stay",
      "ED visit 2023 for chest pain — ruled out MI",
      "Admitted 2020 for DKA — ICU 2 days",
      "No prior admissions",
    ]),
    drugAllergies:
      Math.random() < 0.7
        ? [
            {
              name: pick(["Penicillin", "Sulfa", "Codeine", "Morphine", "Cefazolin"]),
              reaction: pick(["Hives", "Rash", "Anaphylaxis", "Nausea", "Swelling"]),
            },
          ]
        : [],
    envAllergies: pickN(ENV_ALLERGY_OPTIONS, rngInt(0, 2)) as unknown as string[],
    currentMeds: medSeeds,
    familyConditions: pickN(FAMILY_OPTIONS, rngInt(1, 3)) as unknown as string[],
    familyNotes: pick([
      "Father deceased age 68 — MI. Mother alive, HTN.",
      "Mother — breast cancer. Father — Type 2 DM.",
      "Sibling with stroke at age 55. No other notable hx.",
      "Non-contributory.",
    ]),
    narrative: seed?.narrative || "",
  };
}

/* ------------------- SOAP-formatted text rendering --------------------- */
export function intakeToSoap(rec: IntakeRecord): string {
  const lines: string[] = [];
  lines.push("=== S.P.E.H.R. ADMISSION INTAKE (SOAP) ===");
  lines.push("");
  lines.push("S — SUBJECTIVE");
  lines.push(`  CC: ${rec.chiefComplaint || "—"}`);
  lines.push(
    `  HPI: Onset ${rec.hpiOnset || "—"}; Location ${rec.hpiLocation || "—"}; ${rec.hpiDuration || "—"}; Character ${rec.hpiCharacter.join("/") || "—"}; Severity ${rec.hpiSeverity}/10. Worse with ${rec.hpiAggravating || "—"}; better with ${rec.hpiAlleviating || "—"}.`,
  );
  if (rec.narrative) lines.push(`  Narrative: ${rec.narrative}`);
  lines.push("");
  lines.push("O — OBJECTIVE");
  lines.push(
    `  Demographics: ${rec.firstName} ${rec.lastName}, ${rec.age}${(rec.sex || "?")[0]}, DOB ${rec.dob || "—"}.`,
  );
  lines.push(`  PMH: ${rec.chronicIllnesses.join(", ") || "None reported"}.`);
  lines.push(`  PSH: ${rec.priorSurgeries || "—"}.`);
  lines.push(
    `  Allergies: ${rec.drugAllergies.map((a) => `${a.name} (${a.reaction})`).join("; ") || "NKDA"}${rec.envAllergies.length ? `; env: ${rec.envAllergies.join(", ")}` : ""}.`,
  );
  lines.push(
    `  Current Meds: ${rec.currentMeds.map((m) => `${m.name} ${m.dose} ${m.freq}`).join("; ") || "None"}.`,
  );
  lines.push(
    `  Family Hx: ${rec.familyConditions.join(", ") || "Non-contributory"}. ${rec.familyNotes}`,
  );
  lines.push("");
  lines.push("A — ASSESSMENT");
  lines.push(`  Working dx: ${rec.chiefComplaint || "—"}.`);
  lines.push("");
  lines.push("P — PLAN");
  lines.push("  Admit, monitor vitals, initiate workup per protocol. See orders.");
  return lines.join("\n");
}
