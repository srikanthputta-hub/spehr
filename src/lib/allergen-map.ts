/**
 * Static allergen → SNOMED lookup for environmental/food allergens.
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
};

export function lookupAllergenSnomed(name: string): { snomed: string; display: string } | null {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return null;
  return ALLERGEN_SNOMED[key] ?? null;
}