/**
 * Chief Complaint → Standard Order Set
 *
 * Single source of truth that maps a patient's presenting complaint to the
 * exact medications administered and lab tests ordered for them. Used by:
 *   - Admission Randomizer (client + DB cron) to seed the right rows
 *   - Patient chart fallbacks so the UI matches the DB
 *   - Discharge Summary (reads the same DB rows that were seeded)
 *
 * Every patient gets exactly 3 medications and 2 lab tests so the chart's
 * "top 3 meds / top 2 labs" widgets, the MAR, the lab board, and the
 * AI-generated discharge summary all show the SAME items for that MRN.
 */

export interface ProtocolMed {
  name: string;
  dose: string;
  route: string;
}

export interface ProtocolLab {
  name: string;
  unit: string;
  referenceRange: string;
  /** Plausible resulted value used by the DB cron + fallback renderer. */
  resultExample: string;
}

export interface ComplaintProtocol {
  /** Keyword(s) matched (case-insensitive substring) against chief_complaint. */
  matches: string[];
  meds: [ProtocolMed, ProtocolMed, ProtocolMed];
  labs: [ProtocolLab, ProtocolLab];
}

const PROTOCOLS: ComplaintProtocol[] = [
  {
    matches: ["chest pain", "stemi", "nstemi", "acs", "mi"],
    meds: [
      { name: "Aspirin", dose: "325 mg", route: "PO" },
      { name: "Nitroglycerin", dose: "0.4 mg", route: "SL" },
      { name: "Morphine Sulfate", dose: "2 mg", route: "IV" },
    ],
    labs: [
      { name: "Cardiac Troponin I", unit: "ng/mL", referenceRange: "<0.04", resultExample: "0.18 ng/mL [HIGH]" },
      { name: "CK-MB", unit: "ng/mL", referenceRange: "0–6.3", resultExample: "8.2 ng/mL [HIGH]" },
    ],
  },
  {
    matches: ["shortness of breath", "sob", "dyspnea", "copd", "asthma", "respiratory"],
    meds: [
      { name: "Albuterol", dose: "2.5 mg", route: "Nebulizer" },
      { name: "Methylprednisolone", dose: "125 mg", route: "IV" },
      { name: "Furosemide", dose: "40 mg", route: "IV" },
    ],
    labs: [
      { name: "Arterial Blood Gas (ABG)", unit: "", referenceRange: "pH 7.35–7.45", resultExample: "pH 7.31, PaO2 68, PaCO2 52 [ABNORMAL]" },
      { name: "BNP", unit: "pg/mL", referenceRange: "<100", resultExample: "412 pg/mL [HIGH]" },
    ],
  },
  {
    matches: ["stroke", "cva", "tia", "neuro"],
    meds: [
      { name: "Aspirin", dose: "325 mg", route: "PO" },
      { name: "Atorvastatin", dose: "80 mg", route: "PO" },
      { name: "Labetalol", dose: "10 mg", route: "IV" },
    ],
    labs: [
      { name: "Glucose (Fingerstick)", unit: "mg/dL", referenceRange: "70–110", resultExample: "142 mg/dL [HIGH]" },
      { name: "INR", unit: "", referenceRange: "0.8–1.2", resultExample: "1.1" },
    ],
  },
  {
    matches: ["trauma", "fall", "mvc", "fracture"],
    meds: [
      { name: "Morphine Sulfate", dose: "4 mg", route: "IV" },
      { name: "Ondansetron", dose: "4 mg", route: "IV" },
      { name: "Ketorolac", dose: "15 mg", route: "IV" },
    ],
    labs: [
      { name: "Hemoglobin / Hematocrit", unit: "g/dL", referenceRange: "12.0–17.0", resultExample: "11.4 g/dL / 34% [LOW]" },
      { name: "INR", unit: "", referenceRange: "0.8–1.2", resultExample: "1.0" },
    ],
  },
  {
    matches: ["sepsis", "septic", "infection", "bacteremia"],
    meds: [
      { name: "Piperacillin-Tazobactam", dose: "4.5 g", route: "IV" },
      { name: "Vancomycin", dose: "1 g", route: "IV" },
      { name: "Acetaminophen", dose: "650 mg", route: "PO" },
    ],
    labs: [
      { name: "Lactic Acid", unit: "mmol/L", referenceRange: "0.5–2.2", resultExample: "4.8 mmol/L [CRITICAL HIGH]" },
      { name: "WBC", unit: "k/uL", referenceRange: "4.5–11.0", resultExample: "18.3 k/uL [HIGH]" },
    ],
  },
  {
    matches: ["abdominal", "abd pain", "appendicitis", "pancreatitis"],
    meds: [
      { name: "Ondansetron", dose: "4 mg", route: "IV" },
      { name: "Pantoprazole", dose: "40 mg", route: "IV" },
      { name: "Morphine Sulfate", dose: "2 mg", route: "IV" },
    ],
    labs: [
      { name: "Lipase", unit: "U/L", referenceRange: "10–140", resultExample: "260 U/L [HIGH]" },
      { name: "WBC", unit: "k/uL", referenceRange: "4.5–11.0", resultExample: "13.6 k/uL [HIGH]" },
    ],
  },
  {
    matches: ["fever", "pyrexia"],
    meds: [
      { name: "Acetaminophen", dose: "650 mg", route: "PO" },
      { name: "Ceftriaxone", dose: "1 g", route: "IV" },
      { name: "Ibuprofen", dose: "600 mg", route: "PO" },
    ],
    labs: [
      { name: "WBC", unit: "k/uL", referenceRange: "4.5–11.0", resultExample: "12.8 k/uL [HIGH]" },
      { name: "Blood Culture", unit: "", referenceRange: "Negative", resultExample: "Pending — preliminary" },
    ],
  },
  {
    matches: ["dka", "hyperglycemia", "diabetic"],
    meds: [
      { name: "Regular Insulin", dose: "10 units", route: "IV" },
      { name: "Normal Saline", dose: "1 L bolus", route: "IV" },
      { name: "Potassium Chloride", dose: "20 mEq", route: "IV" },
    ],
    labs: [
      { name: "Glucose", unit: "mg/dL", referenceRange: "70–110", resultExample: "452 mg/dL [CRITICAL HIGH]" },
      { name: "Basic Metabolic Panel (BMP)", unit: "", referenceRange: "Anion Gap 8–16", resultExample: "Anion Gap 22 [HIGH]" },
    ],
  },
  {
    matches: ["altered mental", "ams", "confusion", "syncope"],
    meds: [
      { name: "Thiamine", dose: "100 mg", route: "IV" },
      { name: "Dextrose 50%", dose: "25 g", route: "IV" },
      { name: "Ondansetron", dose: "4 mg", route: "IV" },
    ],
    labs: [
      { name: "Glucose (Fingerstick)", unit: "mg/dL", referenceRange: "70–110", resultExample: "62 mg/dL [LOW]" },
      { name: "Sodium", unit: "mEq/L", referenceRange: "135–145", resultExample: "131 mEq/L [LOW]" },
    ],
  },
];

const DEFAULT_PROTOCOL: ComplaintProtocol = {
  matches: [],
  meds: [
    { name: "Acetaminophen", dose: "650 mg", route: "PO" },
    { name: "Lisinopril", dose: "10 mg", route: "PO" },
    { name: "Famotidine", dose: "20 mg", route: "PO" },
  ],
  labs: [
    { name: "Complete Blood Count (CBC)", unit: "", referenceRange: "WBC 4.5–11.0", resultExample: "WBC 7.4, Hgb 13.6, Plt 244" },
    { name: "Basic Metabolic Panel (BMP)", unit: "", referenceRange: "Na 135–145", resultExample: "Na 139, K 4.1, Cr 0.9" },
  ],
};

export function protocolForComplaint(
  complaint: string | null | undefined,
): ComplaintProtocol {
  const c = (complaint ?? "").toLowerCase().trim();
  if (!c) return DEFAULT_PROTOCOL;
  for (const p of PROTOCOLS) {
    if (p.matches.some((m) => c.includes(m))) return p;
  }
  return DEFAULT_PROTOCOL;
}

export function medsForComplaint(complaint: string | null | undefined): ProtocolMed[] {
  return [...protocolForComplaint(complaint).meds];
}

export function labsForComplaint(complaint: string | null | undefined): ProtocolLab[] {
  return [...protocolForComplaint(complaint).labs];
}