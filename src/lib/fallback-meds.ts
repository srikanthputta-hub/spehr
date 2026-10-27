import { MEDICATION_CATALOG, type MedicationCatalogEntry } from "@/constants/clinical-catalog";
import { seededHash, pickN } from "@/lib/fallback-labs";

export interface FallbackMedRow {
  drug_name: string;
  dose: string;
  route: string;
  status: "Administered";
}

/**
 * Deterministic per-MRN medication panel. Returns the same 3 meds in the
 * same order every time, mirroring the admission randomizer's 3-med seed.
 */
export function fallbackMedsFor(mrn: string, count = 3): FallbackMedRow[] {
  const seed = seededHash("med:" + mrn);
  return pickN(MEDICATION_CATALOG, count, seed).map((m: MedicationCatalogEntry) => ({
    drug_name: m.name,
    dose: m.dose,
    route: m.route,
    status: "Administered" as const,
  }));
}
