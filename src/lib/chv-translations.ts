/**
 * Consumer Health Vocabulary (CHV) lay translations for codes appearing
 * in synthetic patient data. Keyed by both the standardised code AND a
 * fuzzy substring match on the canonical term, so a brand-new code with
 * a known display label still resolves.
 *
 * Returning `null` is intentional — the patient portal hides the sub-line
 * entirely rather than rendering "translation unavailable" filler.
 */

type System = "ICD-10" | "SNOMED CT" | "LOINC" | "RxNorm";

const BY_CODE: Record<string, string> = {
  // ICD-10
  "I21.9": "A sudden reduction in blood flow to the heart, also called a heart attack.",
  "I24.9":
    "A sudden reduction of blood flow to the heart muscle, related to coronary artery disease.",
  "I63.9": "A stroke — a part of the brain has lost its blood supply.",
  "I26.99": "A blood clot lodged in the lungs.",
  "I62.9": "Bleeding inside the skull or brain tissue.",
  "J18.9": "Pneumonia — an infection of the lungs.",
  J45: "Asthma — narrowing of the airways causing wheezing and shortness of breath.",
  "E11.9": "Type 2 diabetes — the body has trouble controlling blood sugar.",
  "K92.2": "Bleeding from the upper part of the digestive tract.",
  T07: "An injury caused by a physical impact or trauma.",
  "R47.01": "Difficulty producing clear speech.",
  R05: "A persistent cough.",
  "R10.9": "Abdominal pain whose cause is not yet identified.",
  "K56.6": "An intestinal blockage.",
  // SNOMED CT
  "22298006": "A heart attack — heart muscle is damaged because its blood supply was blocked.",
  "699353001": "A stroke caused by a blocked blood vessel in the brain.",
  "280844000": "Difficulty producing clear, understandable speech.",
  "417163006": "Injury caused by a physical impact.",
  "424863004": "Trauma resulting from blunt impact.",
  "425359009": "Soft-tissue injury from blunt force.",
  // LOINC
  "10839-9":
    "Troponin I — a protein released when the heart muscle is damaged. High levels can indicate a heart attack.",
  "6690-2": "White blood cell count — used to look for infection or inflammation.",
  "2345-7": "Blood glucose — measures the sugar in your blood.",
  "2160-0": "Creatinine — measures how well your kidneys are filtering waste.",
  "243670": "An antibiotic in the penicillin family.",
  // RxNorm
  "1819": "Buprenorphine — a medicine used to treat pain or opioid dependence.",
  "2193": "Captopril — a blood-pressure medicine (ACE inhibitor).",
  "866514": "Metoprolol — a beta-blocker that helps control heart rate and blood pressure.",
  "5640": "Ibuprofen — an anti-inflammatory pain reliever.",
};

const BY_DISPLAY_KEYWORD: Array<[RegExp, string]> = [
  [
    /heart attack|myocardial infarction|acute coronary/i,
    "A sudden reduction in blood flow to the heart muscle.",
  ],
  [/stroke|cerebrovascular|cerebral infarct/i, "A part of the brain has lost its blood supply."],
  [/pneumonia/i, "An infection of the lungs."],
  [/upper gi bleed|gastric bleed/i, "Bleeding from the upper part of the digestive tract."],
  [/blunt trauma/i, "Injury caused by blunt physical impact."],
  [/asthma/i, "Narrowing of the airways causing wheezing or shortness of breath."],
  [/diabetes/i, "A condition where the body has trouble controlling blood sugar."],
  [/troponin/i, "A protein released when the heart muscle is damaged."],
  [
    /metoprolol|atenolol|propranolol/i,
    "A beta-blocker that helps control heart rate and blood pressure.",
  ],
  [/lisinopril|enalapril|ramipril/i, "An ACE inhibitor that lowers blood pressure."],
  [/metformin/i, "A medicine that helps control blood sugar in type 2 diabetes."],
  [/aspirin/i, "A pain reliever that also helps prevent blood clots."],
  [/atorvastatin|rosuvastatin|simvastatin/i, "A statin medication that lowers cholesterol."],
  [/penicillin|amoxicillin|cefazolin/i, "An antibiotic in the penicillin family."],
  [/sulfa|sulfamethoxazole/i, "A sulfa antibiotic."],
  [/morphine|hydromorphone|fentanyl/i, "An opioid pain medication."],
];

export function translateCode(
  _system: System | string,
  code: string | null | undefined,
  display?: string | null,
): string | null {
  if (code && BY_CODE[code]) return BY_CODE[code];
  // Strip dot-suffix (e.g. J45.x → J45)
  if (code) {
    const stem = code.split(".")[0];
    if (BY_CODE[stem]) return BY_CODE[stem];
  }
  if (display) {
    for (const [re, txt] of BY_DISPLAY_KEYWORD) {
      if (re.test(display)) return txt;
    }
  }
  return null;
}
