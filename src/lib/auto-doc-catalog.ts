/**
 * Per-department clinical reasoning catalog used by the headless Auto Doc
 * agent to translate an admission into condition-specific meds (RxNorm) and
 * lab panels (LOINC), plus realistic numeric ranges for synthetic results.
 */

import type { Department } from "./chief-complaints";

export interface MedTemplate {
  rxnorm: string;
  name: string;
  dose: string;
  route: string;
  frequency: string;
}

export interface LabTemplate {
  loinc: string;
  name: string;
  unit: string;
  ref: string;
  /** generator producing a plausible numeric result for this lab */
  gen: () => { value: number; flag: "L" | "H" | "N" | "C" };
}

export interface ConditionTemplate {
  condition: string;        // human label, e.g. "Acute Coronary Syndrome"
  icd10Seed: string;        // initial ICD-10 seed (full set fetched from UMLS)
  snomedSeed: string;       // initial SNOMED seed
  hpi: string;              // History of Present Illness template
  assessment: string;       // assessment template
  plan: string;             // plan template
  discharge: string;        // discharge summary template
  meds: MedTemplate[];
  labs: LabTemplate[];
}

const rand = (min: number, max: number, decimals = 1) => {
  const v = Math.random() * (max - min) + min;
  const m = Math.pow(10, decimals);
  return Math.round(v * m) / m;
};
const inRange = (v: number, lo: number, hi: number) => (v < lo ? "L" : v > hi ? "H" : "N") as "L" | "H" | "N";
const critical = (v: number, lo: number, hi: number) =>
  v < lo * 0.5 || v > hi * 1.8 ? "C" : inRange(v, lo, hi);

// Common lab building blocks reused across departments
const CBC: LabTemplate[] = [
  { loinc: "6690-2", name: "WBC", unit: "10*3/uL", ref: "4.0–11.0", gen: () => { const v = rand(3.5, 16, 1); return { value: v, flag: inRange(v, 4, 11) }; } },
  { loinc: "718-7",  name: "Hemoglobin", unit: "g/dL", ref: "12.0–17.0", gen: () => { const v = rand(8, 17.5, 1); return { value: v, flag: inRange(v, 12, 17) }; } },
  { loinc: "777-3",  name: "Platelets", unit: "10*3/uL", ref: "150–400", gen: () => { const v = rand(110, 450, 0); return { value: v, flag: inRange(v, 150, 400) }; } },
];
const BMP: LabTemplate[] = [
  { loinc: "2345-7", name: "Glucose", unit: "mg/dL", ref: "70–110", gen: () => { const v = rand(70, 260, 0); return { value: v, flag: critical(v, 70, 110) }; } },
  { loinc: "2160-0", name: "Creatinine", unit: "mg/dL", ref: "0.6–1.3", gen: () => { const v = rand(0.5, 2.4, 2); return { value: v, flag: inRange(v, 0.6, 1.3) }; } },
  { loinc: "2951-2", name: "Sodium", unit: "mmol/L", ref: "135–145", gen: () => { const v = rand(130, 148, 0); return { value: v, flag: inRange(v, 135, 145) }; } },
  { loinc: "2823-3", name: "Potassium", unit: "mmol/L", ref: "3.5–5.1", gen: () => { const v = rand(3.0, 5.8, 1); return { value: v, flag: inRange(v, 3.5, 5.1) }; } },
];

/* ---------------------------------------------------------------- */
/*  Catalog                                                          */
/* ---------------------------------------------------------------- */

const CATALOG: Partial<Record<Department, ConditionTemplate>> = {
  Cardiology: {
    condition: "Acute Coronary Syndrome",
    icd10Seed: "I24.9",
    snomedSeed: "394659003",
    hpi: "Patient presents with acute chest discomfort radiating to the left arm, associated with diaphoresis and shortness of breath. Symptoms began within the last several hours and are progressive.",
    assessment: "Suspected acute coronary syndrome. Differential includes unstable angina vs NSTEMI; serial troponins and ECG ordered.",
    plan: "Aspirin 325 mg chewed, sublingual nitroglycerin PRN, continuous telemetry, serial troponins q3h, cardiology consult, admit to telemetry.",
    discharge: "Patient managed for acute coronary syndrome with dual antiplatelet therapy and statin. Troponins trended down, ECG stabilized. Discharged on aspirin, atorvastatin and metoprolol with cardiology follow-up in 1 week.",
    meds: [
      { rxnorm: "243670", name: "Aspirin", dose: "325 mg", route: "PO", frequency: "Once" },
      { rxnorm: "83367",  name: "Atorvastatin", dose: "40 mg", route: "PO", frequency: "QHS" },
      { rxnorm: "866924", name: "Metoprolol Tartrate", dose: "25 mg", route: "PO", frequency: "BID" },
    ],
    labs: [
      { loinc: "10839-9", name: "Troponin I", unit: "ng/mL", ref: "<0.04", gen: () => { const v = rand(0.01, 2.5, 2); return { value: v, flag: v > 0.04 ? (v > 0.5 ? "C" : "H") : "N" }; } },
      { loinc: "2157-6",  name: "Creatine Kinase", unit: "U/L", ref: "30–200", gen: () => { const v = rand(40, 600, 0); return { value: v, flag: inRange(v, 30, 200) }; } },
      ...BMP,
    ],
  },
  Neurology: {
    condition: "Acute Ischemic Stroke",
    icd10Seed: "I63.9",
    snomedSeed: "422504002",
    hpi: "Acute-onset unilateral weakness and slurred speech noted within the last 3 hours. NIH stroke scale completed at the bedside. Patient last seen normal earlier today.",
    assessment: "Acute ischemic stroke vs TIA. Imaging required to rule out hemorrhage prior to consideration of thrombolytic therapy.",
    plan: "Stat non-contrast head CT, NIHSS, glucose, coags. Permissive hypertension protocol. Neurology consult; consider tPA if eligible. Admit to stroke unit.",
    discharge: "Ischemic stroke confirmed on imaging. Stabilized on antiplatelet and statin therapy. Speech and physical therapy initiated. Discharged on clopidogrel and atorvastatin with neurology follow-up.",
    meds: [
      { rxnorm: "309362", name: "Clopidogrel", dose: "75 mg", route: "PO", frequency: "Daily" },
      { rxnorm: "83367",  name: "Atorvastatin", dose: "80 mg", route: "PO", frequency: "QHS" },
    ],
    labs: [
      ...BMP,
      { loinc: "5902-2", name: "PT/INR", unit: "—", ref: "0.9–1.2", gen: () => { const v = rand(0.9, 1.6, 1); return { value: v, flag: inRange(v, 0.9, 1.2) }; } },
    ],
  },
  Pulmonology: {
    condition: "Community-Acquired Pneumonia",
    icd10Seed: "J18.9",
    snomedSeed: "385093006",
    hpi: "Productive cough, fever, pleuritic chest pain over the last several days. Increased work of breathing on exam.",
    assessment: "Community-acquired pneumonia, moderate severity.",
    plan: "Chest X-ray, CBC, BMP, blood cultures, sputum gram stain. Empiric ceftriaxone + azithromycin. Supplemental O2 to maintain SpO2 > 92%.",
    discharge: "Pneumonia treated with course of ceftriaxone/azithromycin transitioning to oral amoxicillin-clavulanate. Symptomatic improvement. Discharged with PCP follow-up in 5 days.",
    meds: [
      { rxnorm: "2193", name: "Azithromycin", dose: "500 mg", route: "PO", frequency: "Daily" },
      { rxnorm: "2191", name: "Amoxicillin-Clavulanate", dose: "875/125 mg", route: "PO", frequency: "BID" },
    ],
    labs: [
      ...CBC,
      ...BMP,
    ],
  },
  Gastroenterology: {
    condition: "Upper GI Bleed",
    icd10Seed: "K92.2",
    snomedSeed: "37372002",
    hpi: "Hematemesis with associated melena reported by the patient. History of NSAID use.",
    assessment: "Acute upper gastrointestinal bleed.",
    plan: "Type & screen, CBC, BMP, PT/PTT. IV pantoprazole drip. GI consult for urgent EGD.",
    discharge: "Upper GI bleed resolved post-EGD with no active bleeding identified. Discharged on PPI therapy and instructed to avoid NSAIDs.",
    meds: [
      { rxnorm: "40790", name: "Pantoprazole", dose: "40 mg", route: "IV", frequency: "Q12H" },
    ],
    labs: [
      ...CBC,
      { loinc: "5902-2", name: "PT/INR", unit: "—", ref: "0.9–1.2", gen: () => { const v = rand(0.9, 1.6, 1); return { value: v, flag: inRange(v, 0.9, 1.2) }; } },
    ],
  },
  Endocrinology: {
    condition: "Diabetic Ketoacidosis",
    icd10Seed: "E11.10",
    snomedSeed: "420422005",
    hpi: "Polyuria, polydipsia, nausea and weakness. Home glucose readings persistently > 400 mg/dL.",
    assessment: "Diabetic ketoacidosis.",
    plan: "IV fluids, IV insulin drip, replace electrolytes (K, Mg, Phos), q1h glucose, q2h BMP until anion gap closes.",
    discharge: "DKA resolved with insulin drip and aggressive fluid resuscitation. Anion gap closed. Transitioned to subcutaneous insulin regimen. Endocrinology follow-up arranged.",
    meds: [
      { rxnorm: "253182", name: "Insulin Regular", dose: "0.1 units/kg/hr", route: "IV", frequency: "Continuous" },
      { rxnorm: "5856",  name: "Insulin Glargine", dose: "20 units", route: "SC", frequency: "QHS" },
    ],
    labs: [
      ...BMP,
      { loinc: "2532-0", name: "Lactate", unit: "mmol/L", ref: "0.5–2.2", gen: () => { const v = rand(1, 5, 1); return { value: v, flag: inRange(v, 0.5, 2.2) }; } },
    ],
  },
  "Intensive Care Unit": {
    condition: "Severe Sepsis",
    icd10Seed: "A41.9",
    snomedSeed: "91302008",
    hpi: "Fever, altered mental status, tachycardia and hypotension consistent with severe sepsis.",
    assessment: "Severe sepsis, source under investigation.",
    plan: "Sepsis bundle: blood cultures x2, lactate, broad spectrum antibiotics within 1 hour, 30 mL/kg crystalloid resuscitation, ICU admission.",
    discharge: "Sepsis sourced to urinary tract; completed antibiotic course. Hemodynamics stabilized off pressors. Discharged with PCP and home health follow-up.",
    meds: [
      { rxnorm: "1665060", name: "Piperacillin-Tazobactam", dose: "4.5 g", route: "IV", frequency: "Q8H" },
      { rxnorm: "11124",  name: "Vancomycin", dose: "20 mg/kg", route: "IV", frequency: "Q12H" },
    ],
    labs: [
      ...CBC,
      ...BMP,
      { loinc: "2532-0", name: "Lactate", unit: "mmol/L", ref: "0.5–2.2", gen: () => { const v = rand(1, 6, 1); return { value: v, flag: critical(v, 0.5, 2.2) }; } },
    ],
  },
  "Emergency Department": {
    condition: "Undifferentiated Acute Presentation",
    icd10Seed: "R69",
    snomedSeed: "84229001",
    hpi: "Acute symptoms prompting ED visit. Triaged per ESI protocol.",
    assessment: "Undifferentiated acute illness pending workup.",
    plan: "Vitals q15 min, IV access, CBC/BMP, targeted imaging by complaint. Specialist consult as indicated.",
    discharge: "Workup completed; primary diagnosis treated and patient stabilized in ED. Discharged with return precautions and PCP follow-up.",
    meds: [
      { rxnorm: "161",   name: "Acetaminophen", dose: "650 mg", route: "PO", frequency: "Q6H PRN" },
      { rxnorm: "1807627", name: "Ondansetron", dose: "4 mg", route: "IV", frequency: "Q8H PRN" },
    ],
    labs: [...CBC, ...BMP],
  },
  Traumatology: {
    condition: "Blunt Trauma",
    icd10Seed: "T07",
    snomedSeed: "417163006",
    hpi: "Mechanism consistent with blunt trauma. Primary and secondary surveys per ATLS.",
    assessment: "Polytrauma — multiple potential injuries pending imaging.",
    plan: "Trauma panel labs, type & cross, FAST exam, CT pan-scan, ortho/neuro consults as indicated.",
    discharge: "Trauma evaluation complete; no operative injuries identified. Pain controlled. Discharged with trauma clinic follow-up.",
    meds: [
      { rxnorm: "1819", name: "Morphine", dose: "4 mg", route: "IV", frequency: "Q4H PRN pain" },
      { rxnorm: "161",  name: "Acetaminophen", dose: "1 g", route: "PO", frequency: "Q6H" },
    ],
    labs: [...CBC, ...BMP],
  },
  "General Surgery": {
    condition: "Acute Appendicitis",
    icd10Seed: "K35.80",
    snomedSeed: "85189001",
    hpi: "Periumbilical pain migrating to right lower quadrant with anorexia, nausea and low-grade fever.",
    assessment: "Acute appendicitis.",
    plan: "NPO, IV fluids, IV ceftriaxone + metronidazole, surgical consult for laparoscopic appendectomy.",
    discharge: "Status post laparoscopic appendectomy; uncomplicated. Pain controlled, tolerating diet. Discharged with surgical follow-up in 2 weeks.",
    meds: [
      { rxnorm: "2193",   name: "Ceftriaxone", dose: "1 g", route: "IV", frequency: "Daily" },
      { rxnorm: "6922",   name: "Metronidazole", dose: "500 mg", route: "IV", frequency: "Q8H" },
    ],
    labs: [...CBC, ...BMP],
  },
  "Orthopedic Surgery": {
    condition: "Closed Fracture",
    icd10Seed: "S82.001A",
    snomedSeed: "125605004",
    hpi: "Mechanical injury with focal pain and deformity; neurovascularly intact distally.",
    assessment: "Closed fracture pending orthopedic surgical evaluation.",
    plan: "Plain films of the affected extremity, splinting, pain control, ortho consult.",
    discharge: "Fracture reduced and splinted; pain controlled. Discharged with orthopedic follow-up in 1 week.",
    meds: [
      { rxnorm: "5640", name: "Ibuprofen", dose: "600 mg", route: "PO", frequency: "Q6H PRN" },
      { rxnorm: "161",  name: "Acetaminophen", dose: "1 g", route: "PO", frequency: "Q6H" },
    ],
    labs: [...CBC],
  },
  Neurosurgery: {
    condition: "Traumatic Brain Injury",
    icd10Seed: "S06.9X0A",
    snomedSeed: "127295002",
    hpi: "Recent head trauma with persistent headache, vomiting and intermittent confusion.",
    assessment: "Traumatic brain injury, severity pending imaging.",
    plan: "Stat head CT, neuro checks q1h, neurosurgery consult, seizure precautions.",
    discharge: "TBI managed conservatively; imaging without surgical lesion. Discharged with strict return precautions and neurosurgery follow-up.",
    meds: [
      { rxnorm: "161", name: "Acetaminophen", dose: "1 g", route: "PO", frequency: "Q6H PRN" },
    ],
    labs: [...BMP],
  },
  "Cardiothoracic Surgery": {
    condition: "Aortic Pathology",
    icd10Seed: "I71.4",
    snomedSeed: "67362008",
    hpi: "Known aortic pathology with recent imaging showing progression. Pre-op evaluation.",
    assessment: "Aortic aneurysm — surgical candidate.",
    plan: "CTA chest, CBC, BMP, type & screen, cardiothoracic surgery consult.",
    discharge: "Pre-operative optimization complete. Patient scheduled for elective repair; discharged home with pre-op instructions.",
    meds: [
      { rxnorm: "866924", name: "Metoprolol Tartrate", dose: "25 mg", route: "PO", frequency: "BID" },
    ],
    labs: [...CBC, ...BMP],
  },
  "Obstetrics and Gynecology": {
    condition: "Antepartum Hemorrhage",
    icd10Seed: "O46.90",
    snomedSeed: "289682006",
    hpi: "Pregnant patient presenting with vaginal bleeding; fetal monitoring initiated.",
    assessment: "Antepartum hemorrhage — etiology pending evaluation.",
    plan: "Type & screen, CBC, fibrinogen, fetal heart monitoring, OB consult, transabdominal ultrasound.",
    discharge: "Bleeding controlled; fetus reassuring on monitoring. Discharged with strict precautions and OB follow-up in 48 hours.",
    meds: [
      { rxnorm: "27084", name: "Prenatal Vitamins", dose: "1 tab", route: "PO", frequency: "Daily" },
    ],
    labs: [
      ...CBC,
      { loinc: "3255-7", name: "Fibrinogen", unit: "mg/dL", ref: "200–400", gen: () => { const v = rand(150, 500, 0); return { value: v, flag: inRange(v, 200, 400) }; } },
    ],
  },
  Pediatrics: {
    condition: "Pediatric Febrile Illness",
    icd10Seed: "R50.9",
    snomedSeed: "386661006",
    hpi: "Pediatric patient with fever, decreased oral intake and irritability.",
    assessment: "Pediatric febrile illness pending evaluation.",
    plan: "Weight-based acetaminophen, oral hydration, CBC and urinalysis if persistent, pediatric admission criteria reviewed.",
    discharge: "Febrile illness resolved with supportive care. Discharged with pediatrician follow-up in 48 hours.",
    meds: [
      { rxnorm: "161", name: "Acetaminophen", dose: "15 mg/kg", route: "PO", frequency: "Q6H PRN fever" },
    ],
    labs: [...CBC],
  },
  "Family Medicine": {
    condition: "Viral Upper Respiratory Infection",
    icd10Seed: "J06.9",
    snomedSeed: "54150009",
    hpi: "Several days of sore throat, congestion and low-grade fever consistent with viral URI.",
    assessment: "Viral upper respiratory infection.",
    plan: "Supportive care: rest, fluids, acetaminophen PRN, return if symptoms worsen or > 10 days.",
    discharge: "Self-limited viral illness; symptomatic care provided. Routine PCP follow-up if not improved in 7 days.",
    meds: [
      { rxnorm: "161", name: "Acetaminophen", dose: "650 mg", route: "PO", frequency: "Q6H PRN" },
    ],
    labs: [...CBC],
  },
  "Internal Medicine": {
    condition: "Hypertensive Urgency",
    icd10Seed: "I16.0",
    snomedSeed: "443482000",
    hpi: "Elevated home blood pressures with mild headache, no end-organ damage symptoms.",
    assessment: "Hypertensive urgency.",
    plan: "Re-check BP after rest, oral labetalol, BMP, ECG, schedule outpatient follow-up.",
    discharge: "Blood pressure controlled with oral therapy. Discharged on lisinopril with PCP follow-up in 1 week.",
    meds: [
      { rxnorm: "29046", name: "Lisinopril", dose: "10 mg", route: "PO", frequency: "Daily" },
    ],
    labs: [...BMP],
  },
  Oncology: {
    condition: "Oncologic Evaluation",
    icd10Seed: "Z03.89",
    snomedSeed: "395557000",
    hpi: "Constitutional symptoms and palpable mass prompting oncologic evaluation.",
    assessment: "Suspected malignancy — staging workup.",
    plan: "CBC, CMP, LDH, imaging as indicated, oncology consult.",
    discharge: "Initial oncology workup completed. Outpatient biopsy and oncology clinic follow-up arranged.",
    meds: [
      { rxnorm: "1807627", name: "Ondansetron", dose: "8 mg", route: "PO", frequency: "Q8H PRN" },
    ],
    labs: [
      ...CBC,
      { loinc: "14804-9", name: "Lactate Dehydrogenase", unit: "U/L", ref: "140–280", gen: () => { const v = rand(120, 500, 0); return { value: v, flag: inRange(v, 140, 280) }; } },
    ],
  },
  Dermatology: {
    condition: "Cutaneous Lesion",
    icd10Seed: "L98.9",
    snomedSeed: "95320005",
    hpi: "New or changing cutaneous lesion noted by the patient.",
    assessment: "Cutaneous lesion — biopsy considered.",
    plan: "Dermatology consult, dermoscopy, consider punch biopsy.",
    discharge: "Lesion evaluated; biopsy pending. Routine dermatology follow-up arranged.",
    meds: [],
    labs: [],
  },
  Radiology: {
    condition: "Diagnostic Imaging Visit",
    icd10Seed: "Z01.6",
    snomedSeed: "363679005",
    hpi: "Patient referred for scheduled diagnostic imaging.",
    assessment: "Imaging study completed; results forwarded to ordering provider.",
    plan: "Image acquisition per protocol; radiologist read released to ordering clinician.",
    discharge: "Imaging study completed without complication. Results released to referring provider.",
    meds: [],
    labs: [],
  },
  Pathology: {
    condition: "Pathology Consultation",
    icd10Seed: "Z01.89",
    snomedSeed: "168184006",
    hpi: "Patient here to review submitted specimen pathology.",
    assessment: "Pathology results reviewed with patient.",
    plan: "Discuss biopsy results, arrange specialty follow-up as indicated.",
    discharge: "Pathology results reviewed; appropriate referrals placed.",
    meds: [],
    labs: [],
  },
  Anesthesiology: {
    condition: "Pre-operative Anesthesia Evaluation",
    icd10Seed: "Z01.818",
    snomedSeed: "182777000",
    hpi: "Pre-operative anesthesia evaluation prior to scheduled procedure.",
    assessment: "ASA classification assigned; airway documented.",
    plan: "Routine pre-op labs, NPO instructions, anesthesia plan documented.",
    discharge: "Pre-op anesthesia evaluation complete. Cleared for procedure.",
    meds: [],
    labs: [...CBC, ...BMP],
  },
  Psychiatry: {
    condition: "Acute Psychiatric Presentation",
    icd10Seed: "F32.9",
    snomedSeed: "35489007",
    hpi: "Acute mood / safety concerns prompting psychiatric evaluation.",
    assessment: "Acute psychiatric presentation requiring safety assessment.",
    plan: "Safety screen, Columbia Suicide Severity Rating Scale, psychiatry consult, initiate SSRI if indicated.",
    discharge: "Safety established with outpatient follow-up plan. Started on sertraline; psychiatry follow-up in 1 week.",
    meds: [
      { rxnorm: "36437", name: "Sertraline", dose: "50 mg", route: "PO", frequency: "Daily" },
    ],
    labs: [],
  },
};

export function templateForDepartment(d: Department | null | undefined): ConditionTemplate {
  return (
    (d && CATALOG[d]) ||
    CATALOG["Family Medicine"]!
  );
}