/**
 * Master Clinical Catalog
 * Persistent reference data for medications and lab tests used by the
 * admission randomizer and any downstream patient-generation logic.
 */

export interface MedicationCatalogEntry {
  name: string;
  dose: string;
  route: string;
  category: string;
}

export interface LabCatalogEntry {
  name: string;
  referenceRange: string;
  unit: string;
}

export const MEDICATION_CATALOG: MedicationCatalogEntry[] = [
  // Antibiotics
  { name: "Piperacillin-Tazobactam", dose: "4.5 g", route: "IV", category: "Antibiotics" },
  { name: "Ceftriaxone", dose: "1 g", route: "IV", category: "Antibiotics" },
  { name: "Vancomycin", dose: "1 g", route: "IV", category: "Antibiotics" },
  { name: "Azithromycin", dose: "500 mg", route: "PO", category: "Antibiotics" },
  // Antihypertensives
  { name: "Lisinopril", dose: "10 mg", route: "PO", category: "Antihypertensives" },
  { name: "Amlodipine", dose: "5 mg", route: "PO", category: "Antihypertensives" },
  { name: "Metoprolol Tartrate", dose: "25 mg", route: "PO", category: "Antihypertensives" },
  { name: "Hydralazine", dose: "10 mg", route: "IV", category: "Antihypertensives" },
  // Analgesics
  { name: "Acetaminophen", dose: "650 mg", route: "PO", category: "Analgesics" },
  { name: "Ibuprofen", dose: "600 mg", route: "PO", category: "Analgesics" },
  { name: "Morphine Sulfate", dose: "2 mg", route: "IV", category: "Analgesics" },
  { name: "Ketorolac", dose: "15 mg", route: "IV", category: "Analgesics" },
  // Anticoagulants
  { name: "Enoxaparin", dose: "40 mg", route: "SubQ", category: "Anticoagulants" },
  { name: "Heparin", dose: "5000 units", route: "SubQ", category: "Anticoagulants" },
  { name: "Apixaban", dose: "5 mg", route: "PO", category: "Anticoagulants" },
  { name: "Warfarin", dose: "5 mg", route: "PO", category: "Anticoagulants" },
  // Gastrointestinal
  { name: "Pantoprazole", dose: "40 mg", route: "IV", category: "Gastrointestinal" },
  { name: "Ondansetron", dose: "4 mg", route: "IV", category: "Gastrointestinal" },
  { name: "Famotidine", dose: "20 mg", route: "PO", category: "Gastrointestinal" },
  { name: "Senna-Docusate", dose: "8.6/50 mg", route: "PO", category: "Gastrointestinal" },
];

export const LAB_CATALOG: LabCatalogEntry[] = [
  // Hematology
  { name: "WBC", referenceRange: "4.5–11.0", unit: "k/uL" },
  { name: "Hemoglobin", referenceRange: "12.0–17.0", unit: "g/dL" },
  { name: "Hematocrit", referenceRange: "36–50", unit: "%" },
  { name: "Platelets", referenceRange: "150–400", unit: "k/uL" },
  { name: "INR", referenceRange: "0.8–1.2", unit: "" },
  // Chemistry
  { name: "Sodium", referenceRange: "135–145", unit: "mEq/L" },
  { name: "Potassium", referenceRange: "3.5–5.0", unit: "mEq/L" },
  { name: "Chloride", referenceRange: "98–107", unit: "mEq/L" },
  { name: "Bicarbonate", referenceRange: "22–28", unit: "mEq/L" },
  { name: "BUN", referenceRange: "7–20", unit: "mg/dL" },
  { name: "Creatinine", referenceRange: "0.6–1.2", unit: "mg/dL" },
  { name: "Glucose", referenceRange: "70–110", unit: "mg/dL" },
  // Cardiac markers
  { name: "Troponin I", referenceRange: "<0.04", unit: "ng/mL" },
  { name: "BNP", referenceRange: "<100", unit: "pg/mL" },
  { name: "CK-MB", referenceRange: "0–6.3", unit: "ng/mL" },
  // Urinalysis
  { name: "Urine Specific Gravity", referenceRange: "1.005–1.030", unit: "" },
  { name: "Urine pH", referenceRange: "4.5–8.0", unit: "" },
  { name: "Urine Leukocyte Esterase", referenceRange: "Negative", unit: "" },
  { name: "Urine Nitrites", referenceRange: "Negative", unit: "" },
];
