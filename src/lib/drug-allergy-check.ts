/**
 * Drug ↔ Allergy name-match guard.
 *
 * The RxNorm-only check used previously silently skipped pairs that lacked
 * RxCUIs (text-only allergies, raw drug strings from the CPOE) and was
 * case-sensitive on display strings — letting "ceFAZolin (Injectable)"
 * pass against a documented "cefazolin" allergy. This module collapses
 * both sides to a strict alphanumeric form so the comparison is invariant
 * to case, whitespace, dosage form parentheticals and combo-drug hyphens.
 */

export function normaliseDrugName(name: string | null | undefined): string {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    // strip parenthetical qualifiers like "(Injectable)" before stripping
    // non-alphanumerics so we don't fuse the dose form into the ingredient.
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * True when the two drug strings refer to the same ingredient family.
 * Catches exact-name matches and combo-drug matches (e.g. "amoxicillin"
 * vs "amoxicillin-clavulanate"). Two-letter normalised tokens are
 * rejected to avoid false positives on extremely short fragments.
 */
export function checkNameMatch(
  orderedDrug: string | null | undefined,
  allergySubstance: string | null | undefined,
): boolean {
  const a = normaliseDrugName(orderedDrug);
  const b = normaliseDrugName(allergySubstance);
  if (a.length < 3 || b.length < 3) return false;
  return a === b || a.includes(b) || b.includes(a);
}

export type DrugAllergyConflict = {
  drug: string;
  allergy: string;
  reaction?: string | null;
  severity?: string | null;
  mrn: string;
};

export class DrugAllergyConflictError extends Error {
  conflict: DrugAllergyConflict;
  constructor(conflict: DrugAllergyConflict) {
    super(
      `Drug-allergy conflict: ${conflict.drug} blocked — patient ${conflict.mrn} is allergic to ${conflict.allergy}`,
    );
    this.name = "DrugAllergyConflictError";
    this.conflict = conflict;
  }
}