/**
 * Live UMLS-driven coding builders. Every coding[] array on every FHIR
 * resource pushed to the external server is produced by these helpers,
 * which call the umls-proxy edge function (cache-first) — never a
 * hardcoded lookup table.
 */

import {
  resolveIcd10,
  resolveSnomed,
  resolveRxNorm,
  resolveMeddra,
  resolveLoinc,
  type ResolvedCode,
} from "@/lib/umls-client";
import { FHIR_SYSTEM_URI, type CodeableConcept } from "@/lib/fhir-bundle";

const MEDDRA_SYSTEM = "http://terminology.hl7.org/CodeSystem/meddra";
const UCUM_SYSTEM = "http://unitsofmeasure.org";

/** Build a Condition coding[] (ICD-10 + SNOMED) for any clinical text. */
export async function buildConditionCoding(
  clinicalText: string,
): Promise<CodeableConcept> {
  const text = (clinicalText ?? "").trim();
  if (!text) return { coding: [], text: "" };
  const [icd10, snomed] = await Promise.all([
    resolveIcd10(text),
    resolveSnomed(text),
  ]);
  const coding: CodeableConcept["coding"] = [];
  if (icd10) {
    coding.push({
      system: FHIR_SYSTEM_URI["ICD-10"],
      code: icd10.code,
      display: icd10.display,
    });
  }
  if (snomed) {
    coding.push({
      system: FHIR_SYSTEM_URI["SNOMED CT"],
      code: snomed.code,
      display: snomed.display,
    });
  }
  // text ALWAYS mirrors the exact clinical string passed to the search,
  // never the canonical display of the resolved code. Prevents the
  // mismatch where Condition.code.text said "Blunt Trauma" but the
  // coding[] resolved to "Low back pain".
  return { coding, text };
}

const DOSE_UNIT_RX =
  /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|ml|l|units?|u|meq|iu|%|tabs?|caps?)\b/gi;
const ROUTE_RX =
  /\b(?:po|iv|im|sc|sq|bid|tid|qid|qhs|q\d+h|prn|stat|oral|tab|cap|inj|infusion|pill|sublingual|sl|topical|nebulised|nebulized)\b/gi;

/** Strip dose / route / frequency to isolate the drug name for RxNav. */
export function stripDoseRoute(raw: string): string {
  return (raw ?? "")
    .replace(DOSE_UNIT_RX, " ")
    .replace(ROUTE_RX, " ")
    .replace(/[,;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a medication coding[] (RxNorm) for a free-text drug string. */
export async function buildMedicationCoding(
  drugName: string,
): Promise<CodeableConcept> {
  const text = (drugName ?? "").trim();
  if (!text) return { coding: [], text: "" };
  const lookup = stripDoseRoute(text) || text;
  const rx = await resolveRxNorm(lookup);
  const coding: CodeableConcept["coding"] = rx
    ? [
        {
          system: FHIR_SYSTEM_URI.RxNorm,
          code: rx.code,
          display: rx.display || lookup,
        },
      ]
    : [];
  return { coding, text };
}

/** Allergy substance coding[]: RxNorm for meds, SNOMED for substances. */
export async function buildAllergySubstanceCoding(
  substance: string,
  category: "medication" | "environment" | "food" | "biologic" | "unknown",
): Promise<CodeableConcept> {
  const text = (substance ?? "").trim();
  if (!text) return { coding: [], text: "" };
  let resolved: ResolvedCode | null;
  let system: string;
  if (category === "medication") {
    resolved = await resolveRxNorm(stripDoseRoute(text) || text);
    system = FHIR_SYSTEM_URI.RxNorm;
  } else {
    resolved = await resolveSnomed(text);
    system = FHIR_SYSTEM_URI["SNOMED CT"];
  }
  const coding: CodeableConcept["coding"] = resolved
    ? [{ system, code: resolved.code, display: resolved.display }]
    : [];
  return { coding, text };
}

/** Reaction manifestation coding[]: MedDRA Preferred Term. */
export async function buildReactionCoding(
  reactionText: string,
): Promise<CodeableConcept> {
  const text = (reactionText ?? "").trim();
  if (!text) return { coding: [], text: "" };
  const md = await resolveMeddra(text);
  const coding: CodeableConcept["coding"] = md
    ? [{ system: MEDDRA_SYSTEM, code: md.code, display: md.display }]
    : [];
  return { coding, text };
}

/**
 * Resolve a UCUM unit string for a lab test. Try LOINC first (UMLS), then
 * fall back to a unit string parsed from the existing result_value text
 * (e.g. "10.2 g/dL"). Returns null when no plausible unit can be found —
 * the caller then omits valueQuantity.system / .code, but never invents one.
 */
const UNIT_FROM_RESULT_RX =
  /(-?\d+(?:\.\d+)?)\s*([A-Za-zµ%][A-Za-z0-9µ%./^*\-]{0,15})/;

export function extractUnitFromResultValue(
  resultValue: string | null | undefined,
): string | null {
  if (!resultValue) return null;
  const m = String(resultValue).match(UNIT_FROM_RESULT_RX);
  if (!m) return null;
  const unit = (m[2] ?? "").trim();
  if (!unit || /^[A-Za-z]+$/.test(unit) === false ? false : false) return unit;
  // Filter obvious noise (single-letter "g" alone often comes from "10 g") —
  // we still allow it because UCUM accepts "g".
  return unit || null;
}

export async function resolveLabUcumUnit(
  testName: string,
  fallbackResultValue: string | null | undefined,
): Promise<string | null> {
  // First attempt: ask LOINC. We don't yet parse the LOINC property file,
  // but the resolved display sometimes embeds the unit (e.g. "Hemoglobin
  // [Mass/volume] in Blood"). Cheap heuristic that prefers explicit units.
  const loinc = await resolveLoinc(testName);
  if (loinc?.display) {
    const m = loinc.display.match(/\b([a-zA-Z]+\/[a-zA-Z]+)\b/);
    if (m) return m[1];
  }
  return extractUnitFromResultValue(fallbackResultValue);
}

export { UCUM_SYSTEM, MEDDRA_SYSTEM };