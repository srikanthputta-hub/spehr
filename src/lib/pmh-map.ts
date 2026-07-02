/**
 * Static PMH checkbox → SNOMED / ICD-10 lookup used by Stream B of the
 * six-stream coding pipeline. Direct pre-mapped values — no API call.
 */
export type PmhCode = {
  label: string;
  aliases: string[]; // extra keywords that can appear in past_medical_history text
  snomed_code: string;
  snomed_display: string;
  icd10_code: string;
  icd10_display: string;
};

export const PMH_MAP: PmhCode[] = [
  { label: "Hypertension",          aliases: ["hypertension", "htn", "high blood pressure"], snomed_code: "38341003",  snomed_display: "Hypertension",              icd10_code: "I10",     icd10_display: "Essential hypertension" },
  { label: "Type 2 Diabetes",       aliases: ["type 2 diabetes", "t2dm", "type ii diabetes"], snomed_code: "44054006",  snomed_display: "Type 2 diabetes mellitus", icd10_code: "E11.9",   icd10_display: "Type 2 DM without complications" },
  { label: "Type 1 Diabetes",       aliases: ["type 1 diabetes", "t1dm"],                    snomed_code: "46635009",  snomed_display: "Type 1 diabetes mellitus", icd10_code: "E10.9",   icd10_display: "Type 1 DM without complications" },
  { label: "Asthma",                aliases: ["asthma"],                                     snomed_code: "195967001", snomed_display: "Asthma",                    icd10_code: "J45.909", icd10_display: "Unspecified asthma" },
  { label: "COPD",                  aliases: ["copd", "emphysema"],                          snomed_code: "13645005",  snomed_display: "COPD",                      icd10_code: "J44.9",   icd10_display: "COPD unspecified" },
  { label: "Coronary Artery Disease", aliases: ["coronary artery disease", "cad"],           snomed_code: "53741008",  snomed_display: "Coronary arteriosclerosis", icd10_code: "I25.10",  icd10_display: "CAD of native coronary artery" },
  { label: "Heart Failure",         aliases: ["heart failure", "chf", "congestive heart failure"], snomed_code: "84114007",  snomed_display: "Heart failure",             icd10_code: "I50.9",   icd10_display: "Heart failure unspecified" },
  { label: "CKD",                   aliases: ["ckd", "chronic kidney disease"],              snomed_code: "709044004", snomed_display: "Chronic kidney disease",    icd10_code: "N18.9",   icd10_display: "CKD unspecified" },
  { label: "Stroke/TIA",            aliases: ["stroke", "tia", "cva"],                       snomed_code: "230690007", snomed_display: "Cerebrovascular accident",  icd10_code: "I63.9",   icd10_display: "Cerebral infarction unspecified" },
  { label: "Atrial Fibrillation",   aliases: ["atrial fibrillation", "afib", "a-fib"],       snomed_code: "49436004",  snomed_display: "Atrial fibrillation",       icd10_code: "I48.91",  icd10_display: "Unspecified AFib" },
  { label: "Hyperlipidemia",        aliases: ["hyperlipidemia", "high cholesterol", "dyslipidemia"], snomed_code: "55822004",  snomed_display: "Hyperlipidemia",            icd10_code: "E78.5",   icd10_display: "Hyperlipidemia unspecified" },
  { label: "Hypothyroidism",        aliases: ["hypothyroidism", "underactive thyroid"],      snomed_code: "40930008",  snomed_display: "Hypothyroidism",            icd10_code: "E03.9",   icd10_display: "Hypothyroidism unspecified" },
  { label: "Depression",            aliases: ["depression", "depressive disorder"],          snomed_code: "35489007",  snomed_display: "Depressive disorder",       icd10_code: "F32.9",   icd10_display: "Major depressive disorder" },
  { label: "Anxiety",               aliases: ["anxiety", "anxiety disorder"],                snomed_code: "48694002",  snomed_display: "Anxiety",                   icd10_code: "F41.9",   icd10_display: "Anxiety disorder unspecified" },
  { label: "GERD",                  aliases: ["gerd", "reflux", "gastroesophageal reflux"],  snomed_code: "235595009", snomed_display: "GERD",                      icd10_code: "K21.0",   icd10_display: "GERD with esophagitis" },
];

/** Match a raw PMH string (comma/semicolon list) → PMH codes. */
export function matchPmh(pmhText: string | null | undefined): PmhCode[] {
  if (!pmhText) return [];
  const t = pmhText.toLowerCase();
  const hits: PmhCode[] = [];
  const seen = new Set<string>();
  for (const row of PMH_MAP) {
    if (row.aliases.some((a) => t.includes(a))) {
      if (!seen.has(row.snomed_code)) {
        seen.add(row.snomed_code);
        hits.push(row);
      }
    }
  }
  return hits;
}