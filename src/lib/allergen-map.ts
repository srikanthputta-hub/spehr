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
  return ALLERGEN_SNOMED[key] ?? null;
}