/**
 * Drug × disease contraindication table used by the CPOE CDS Hook engine.
 * Keyed by lowercase drug-name token + ICD-10/SNOMED code that signals
 * the contraindicated condition. Extend freely.
 */

export type CdsSeverity = "CONTRAINDICATION" | "CAUTION" | "INFO";

export interface ContraindicationRule {
  drug_match: RegExp;          // matches medication name
  drug_rxnorm?: string;
  condition_match: RegExp;      // matches chief complaint or condition name
  condition_icd10?: string;
  condition_snomed?: string;
  severity: CdsSeverity;
  rationale: string;
}

export const CONTRAINDICATIONS: ContraindicationRule[] = [
  {
    drug_match: /\b(ibuprofen|naproxen|ketorolac|nsaid|aspirin)\b/i,
    drug_rxnorm: "5640",
    condition_match: /upper gi bleed|gastric bleed|peptic ulcer|hematemesis|gi bleed/i,
    condition_icd10: "K92.2",
    severity: "CONTRAINDICATION",
    rationale:
      "NSAIDs inhibit prostaglandin-mediated mucosal protection and prolong bleeding time — risk of rebleed and gastric injury.",
  },
  {
    drug_match: /\b(metoprolol|propranolol|atenolol|carvedilol|bisoprolol|beta[- ]blocker)\b/i,
    drug_rxnorm: "866514",
    condition_match: /asthma|reactive airway|bronchospasm/i,
    condition_icd10: "J45",
    severity: "CONTRAINDICATION",
    rationale:
      "Non-selective beta-blockade can precipitate severe bronchospasm in patients with active asthma.",
  },
  {
    drug_match: /\b(lisinopril|enalapril|ramipril|captopril|ace inhibitor|acei)\b/i,
    condition_match: /hyperkal[ae]mia|elevated potassium|k\+ high/i,
    severity: "CAUTION",
    rationale:
      "ACE inhibitors reduce aldosterone-driven potassium excretion and may worsen hyperkalaemia.",
  },
  {
    drug_match: /\b(metformin)\b/i,
    condition_match: /acute kidney injury|aki|egfr.*<.*30|renal failure/i,
    severity: "CONTRAINDICATION",
    rationale:
      "Metformin clearance is renal — accumulation risks life-threatening lactic acidosis in AKI / severe CKD.",
  },
  {
    drug_match: /\b(warfarin|apixaban|rivaroxaban|enoxaparin|heparin)\b/i,
    condition_match: /active bleed|intracranial h[ae]morrhage|brain bleed|hematemesis/i,
    severity: "CONTRAINDICATION",
    rationale: "Active haemorrhage absolutely contraindicates therapeutic anticoagulation.",
  },
  {
    drug_match: /\b(nitroglycerin|sildenafil|tadalafil)\b/i,
    condition_match: /sildenafil|tadalafil|pde-?5/i,
    severity: "CONTRAINDICATION",
    rationale: "Nitrates + PDE-5 inhibitors → severe, refractory hypotension.",
  },
  {
    drug_match: /\b(ondansetron|haloperidol|methadone|azithromycin)\b/i,
    condition_match: /long qt|qtc.*prolong|torsade/i,
    severity: "CAUTION",
    rationale: "Additive QT prolongation increases torsades-de-pointes risk.",
  },
];

export interface CdsHit {
  rule: ContraindicationRule;
  matched_condition: string;
}

export function checkDrugDisease(
  drugName: string,
  patientConditions: string[],
): CdsHit[] {
  if (!drugName) return [];
  const hits: CdsHit[] = [];
  for (const rule of CONTRAINDICATIONS) {
    if (!rule.drug_match.test(drugName)) continue;
    for (const c of patientConditions) {
      if (rule.condition_match.test(c)) {
        hits.push({ rule, matched_condition: c });
        break;
      }
    }
  }
  return hits;
}