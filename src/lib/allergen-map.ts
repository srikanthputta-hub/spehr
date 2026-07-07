/**
 * Static allergen → SNOMED lookup for environmental, food, and drug-class allergens.
 * Used by Stream D of the six-stream coding pipeline.
 */
export const ALLERGEN_SNOMED: Record<string, { snomed: string; display: string }> = {
  latex:        { snomed: "111088007", display: "Latex" },
  iodine:       { snomed: "372639009", display: "Iodine" },
  "contrast dye": { snomed: "372639009", display: "Contrast dye" },
  peanuts:      { snomed: "762952008", display: "Peanut" },
  peanut:       { snomed: "762952008", display: "Peanut" },
  "tree nuts":  { snomed: "762952008", display: "Tree nut" },
  "tree nut":   { snomed: "762952008", display: "Tree nut" },
  shellfish:    { snomed: "735029006", display: "Shellfish" },
  eggs:         { snomed: "102263004", display: "Egg" },
  egg:          { snomed: "102263004", display: "Egg" },
  dairy:        { snomed: "372454002", display: "Dairy product" },
  milk:         { snomed: "372454002", display: "Milk" },
  pollen:       { snomed: "256259004", display: "Pollen" },
  "bee sting":  { snomed: "288328004", display: "Bee sting" },
  bee:          { snomed: "288328004", display: "Bee sting" },
  penicillin:   { snomed: "764146007", display: "Penicillin" },
  "penicillin g": { snomed: "764146007", display: "Penicillin" },
  amoxicillin:  { snomed: "764146007", display: "Penicillin" },
  sulfa:        { snomed: "416897008", display: "Sulfonamide" },
  sulfonamide:  { snomed: "416897008", display: "Sulfonamide" },
  "sulfa drugs": { snomed: "416897008", display: "Sulfonamide" },
  aspirin:      { snomed: "387458008", display: "Aspirin" },
  nsaid:        { snomed: "372687004", display: "NSAID" },
  nsaids:       { snomed: "372687004", display: "NSAID" },
  ibuprofen:    { snomed: "372687004", display: "NSAID" },
  codeine:      { snomed: "319898004", display: "Codeine" },
  morphine:     { snomed: "373492002", display: "Opioid" },
  opioids:      { snomed: "373492002", display: "Opioid" },
  cephalosporin: { snomed: "764146007", display: "Penicillin" },
};

export function lookupAllergenSnomed(name: string): { snomed: string; display: string } | null {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return null;
  const exact = ALLERGEN_SNOMED[key];
  if (exact) return exact;

  // Fallback: substring/keyword match against family "root" terms so that
  // RxNorm salt-form and combination names (e.g. "penicillin V potassium",
  // "amoxicillin trihydrate", "amoxicillin/clavulanate") still resolve to
  // the correct class-level SNOMED code used by Rule 1 in the Safety Alerts
  // Engine. Order families from most-specific class first; environmental /
  // food roots come last so drug-class roots win on ambiguous free text.
  const FAMILY_ROOTS: Array<{
    roots: string[];
    snomed: string;
    display: string;
  }> = [
    {
      // Penicillin / beta-lactam family (cephalosporins folded in to match
      // sweep_stalled_clinical_orders() cross-reactivity assumption).
      roots: [
        "penicillin", "amoxicillin", "ampicillin", "piperacillin",
        "oxacillin", "dicloxacillin", "nafcillin", "cloxacillin", "methicillin",
        "ticarcillin",
        "cephalosporin", "cefazolin", "ceftriaxone", "cefepime",
        "cephalexin", "cefuroxime", "cefdinir",
      ],
      snomed: "764146007",
      display: "Penicillin",
    },
    {
      roots: ["sulfamethoxazole", "trimethoprim", "bactrim", "sulfonamide", "sulfa"],
      snomed: "416897008",
      display: "Sulfonamide",
    },
    {
      roots: ["ibuprofen", "naproxen", "ketorolac", "celecoxib", "diclofenac", "nsaid"],
      snomed: "372687004",
      display: "NSAID",
    },
    {
      roots: ["morphine", "codeine", "oxycodone", "hydrocodone", "fentanyl", "opioid"],
      snomed: "373492002",
      display: "Opioid",
    },
    { roots: ["aspirin"], snomed: "387458008", display: "Aspirin" },
    // Environmental / food fallbacks — for slightly varied free text
    // (e.g. "peanut butter", "shellfish extract").
    { roots: ["latex"], snomed: "111088007", display: "Latex" },
    { roots: ["contrast dye", "iodine"], snomed: "372639009", display: "Iodine" },
    { roots: ["peanut"], snomed: "762952008", display: "Peanut" },
    { roots: ["tree nut"], snomed: "762952008", display: "Tree nut" },
    { roots: ["shellfish"], snomed: "735029006", display: "Shellfish" },
    { roots: ["egg"], snomed: "102263004", display: "Egg" },
    { roots: ["dairy", "milk"], snomed: "372454002", display: "Dairy product" },
    { roots: ["pollen"], snomed: "256259004", display: "Pollen" },
    { roots: ["bee"], snomed: "288328004", display: "Bee sting" },
  ];

  for (const fam of FAMILY_ROOTS) {
    for (const root of fam.roots) {
      if (key.includes(root)) {
        return { snomed: fam.snomed, display: fam.display };
      }
    }
  }
  return null;
}