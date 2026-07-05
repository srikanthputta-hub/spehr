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

/**
 * Value-set-backed contraindication check. Queries `custom_value_sets` for
 * published `clinical_application = 'CDS'` sets, matches the drug via the
 * value set's name/description (case-insensitive substring), and returns
 * hits when any patient condition/allergy display text overlaps with a
 * `codes[].display` in that value set.
 *
 * Returns:
 *   - `{ hits, matchedAnyDrugSet: true }`  when at least one CDS value set
 *     governed the drug (whether or not conditions matched).
 *   - `{ hits: [], matchedAnyDrugSet: false }` when NO CDS value set
 *     covered the drug — caller should fall back to `checkDrugDisease`.
 */
export async function checkDrugDiseaseFromValueSets(
  drugName: string,
  patientConditions: string[],
): Promise<{ hits: CdsHit[]; matchedAnyDrugSet: boolean }> {
  if (!drugName) return { hits: [], matchedAnyDrugSet: false };
  const { supabase } = await import("@/integrations/supabase/client");
  const { data, error } = await supabase
    .from("custom_value_sets")
    .select("id, name, description, codes, clinical_application, status")
    .eq("status", "published")
    .eq("clinical_application", "CDS");
  if (error || !data || data.length === 0) {
    return { hits: [], matchedAnyDrugSet: false };
  }
  const drugLower = drugName.toLowerCase();
  const hits: CdsHit[] = [];
  let matchedAnyDrugSet = false;

  for (const vs of data as any[]) {
    const name = String(vs.name ?? "");
    const desc = String(vs.description ?? "");
    const haystack = `${name} ${desc}`.toLowerCase();
    // Value set governs this drug when its name/description mentions it
    // (substring, either direction — tolerates "NSAIDs" naming ibuprofen
    // and "ibuprofen" being contained in the value set name).
    const governs =
      haystack.includes(drugLower) ||
      drugLower.split(/\s+/).some((tok) => tok.length >= 3 && haystack.includes(tok));
    if (!governs) continue;
    matchedAnyDrugSet = true;

    const codes = Array.isArray(vs.codes) ? vs.codes : [];
    // Optional severity/rationale override via description marker
    const severity: CdsSeverity =
      /caution/i.test(desc) ? "CAUTION"
      : /info/i.test(desc) ? "INFO"
      : "CONTRAINDICATION";

    for (const cond of patientConditions) {
      const condLower = String(cond ?? "").toLowerCase();
      if (!condLower) continue;
      const match = codes.find((c: any) => {
        const disp = String(c?.display ?? "").toLowerCase();
        if (!disp) return false;
        return condLower.includes(disp) || disp.includes(condLower);
      });
      if (match) {
        const rule: ContraindicationRule = {
          drug_match: new RegExp(drugLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
          condition_match: new RegExp(String(match.display).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
          condition_snomed: match.code ? String(match.code) : undefined,
          severity,
          rationale: desc
            ? `${name} — ${desc}`
            : `${name}: patient condition "${cond}" is on this contraindication value set.`,
        };
        hits.push({ rule, matched_condition: cond });
        break; // one hit per value set is enough
      }
    }
  }
  return { hits, matchedAnyDrugSet };
}