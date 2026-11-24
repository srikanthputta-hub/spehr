/**
 * Static admitting-diagnosis free text → published diagnosis Value Set
 * Library row lookup.
 *
 * The admission form (`admit-patient.ts`) captures the admitting diagnosis
 * as plain free text (`patients.chief_complaint`) with no coding at entry
 * time — the only coding path for it was previously the fire-and-forget
 * six-stream pipeline's Stream A (coding-pipeline.ts), which resolves
 * SNOMED/ICD-10 via a generic UMLS search, asynchronously, independent of
 * the Value Set Library.
 *
 * This module closes that specific gap for the five diagnosis value sets a
 * 2026-11 VSAC audit confirmed are a "strong fit" — each one's code list was
 * verified to contain the exact ICD-10-CM code spehr's own patient data
 * already uses for that diagnosis. When the clinician's typed diagnosis
 * text matches one of these by a known clinical synonym, the matching
 * code+display is read directly out of that value set's own (real,
 * VSAC-sourced) `codes` array at call time — never hardcoded here — so
 * nothing is fabricated: if a value set were re-synced from VSAC and
 * dropped the code, the match honestly returns null instead of inventing
 * one (same "honest gap" pattern as `fhir-bundle.ts`/`discharge-narrative.ts`).
 *
 * Only the keyword → (value set name, target code) association is a static
 * table here, mirroring `allergen-map.ts`'s static substance → SNOMED map
 * for the same reason: a small, closed, hand-verified set of clinical
 * synonyms that's cheaper and more reliable than a live UMLS round trip for
 * exactly five known diagnoses, at the one point (admission) where a
 * synchronous, zero-network answer is needed.
 *
 * Consumer registration: this lookup only resolves a value set once a
 * `value_set_dependencies` row links the exact name below to a published
 * `custom_value_sets.id` — see the `wire_diagnosis_value_sets_at_admission`
 * migration, which inserts the five rows for
 * consumer = ADMISSION_DIAGNOSIS_CONSUMER. Until a row is linked (or its
 * value set is unpublished), matches for that diagnosis honestly return
 * null rather than guessing.
 */
import { loadPublishedValueSetsForConsumer } from "@/lib/value-set-registry";

/** `value_set_dependencies.consumer` for every row this module relies on. */
export const ADMISSION_DIAGNOSIS_CONSUMER = "Admission Diagnosis Coding";

export type DiagnosisValueSetMatch = {
  valueSetId: string;
  valueSetName: string;
  oid: string | null;
  code: string;
  display: string;
  vocabulary: string;
};

type DiagnosisRule = {
  /** Exact `custom_value_sets.name` / `value_set_dependencies.value_set_name`. */
  valueSetName: string;
  /**
   * Clinical synonyms for the admitting diagnosis text. Matched as whole
   * words/phrases (case-insensitive) against the free text, longest first,
   * so e.g. "af" never matches inside an unrelated word.
   */
  keywords: string[];
  /**
   * The specific code, within that value set's own `codes` array, already
   * confirmed (by the VSAC audit) to be the one spehr's own patient data
   * uses for this diagnosis. Looked up live — see module doc above.
   */
  targetCode: string;
};

const DIAGNOSIS_RULES: DiagnosisRule[] = [
  {
    valueSetName: "CAP Pneumonia Diagnostic",
    keywords: ["community-acquired pneumonia", "community acquired pneumonia", "pneumonia", "cap"],
    targetCode: "J18.9",
  },
  {
    valueSetName: "Ischemic Stroke",
    keywords: ["ischemic stroke", "ischaemic stroke", "cerebrovascular accident", "stroke", "cva"],
    targetCode: "I63.9",
  },
  {
    valueSetName: "Hypertension",
    keywords: ["hypertension", "htn"],
    targetCode: "I10",
  },
  {
    valueSetName: "AHA GWTG Hyperlipidemia",
    keywords: ["hyperlipidemia", "hyperlipidaemia", "dyslipidemia", "high cholesterol"],
    targetCode: "E78.5",
  },
  {
    valueSetName: "AHA GWTG Atrial Fibrillation",
    keywords: ["atrial fibrillation", "a-fib", "afib"],
    targetCode: "I48.91",
  },
];

/** Escapes a string for safe use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMatchesKeyword(text: string, keyword: string): boolean {
  // Word-boundary match for short/alphanumeric keywords (htn, cva, afib, cap)
  // so they don't fire inside unrelated words; phrase keywords with spaces
  // or a hyphen (e.g. "a-fib") just need `\b` at the edges, which still
  // works since `\b` is defined between a word char and a non-word char.
  const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");
  return pattern.test(text);
}

function findRuleForText(diagnosisText: string): DiagnosisRule | null {
  const text = diagnosisText.trim();
  if (!text) return null;
  for (const rule of DIAGNOSIS_RULES) {
    for (const keyword of rule.keywords) {
      if (textMatchesKeyword(text, keyword)) return rule;
    }
  }
  return null;
}

type MinimalClient = Parameters<typeof loadPublishedValueSetsForConsumer>[2];

/**
 * Matches free-text admitting-diagnosis input against the five published
 * diagnosis value sets wired for `ADMISSION_DIAGNOSIS_CONSUMER`, and
 * returns the real code+display read live from the matched value set's own
 * `codes` array — or null when there's no keyword match, the dependency
 * isn't linked to a published value set yet, or the target code is no
 * longer present (re-synced away). Never fabricates a code.
 */
export async function matchAdmissionDiagnosisToPublishedValueSet(
  diagnosisText: string,
  client?: MinimalClient,
): Promise<DiagnosisValueSetMatch | null> {
  const rule = findRuleForText(diagnosisText ?? "");
  if (!rule) return null;

  const hits = await (client
    ? loadPublishedValueSetsForConsumer(
        { consumer: ADMISSION_DIAGNOSIS_CONSUMER },
        undefined,
        client,
      )
    : loadPublishedValueSetsForConsumer({ consumer: ADMISSION_DIAGNOSIS_CONSUMER }));
  const hit = hits.find((h) => h.value_set_name === rule.valueSetName);
  if (!hit) return null;

  const codes = Array.isArray(hit.row.codes) ? hit.row.codes : [];
  const codeEntry = codes.find(
    (c) =>
      c &&
      typeof c === "object" &&
      !Array.isArray(c) &&
      String((c as { code?: unknown }).code ?? "")
        .trim()
        .toUpperCase() === rule.targetCode.toUpperCase(),
  ) as { code?: string; display?: string; system?: string } | undefined;
  if (!codeEntry) return null;

  return {
    valueSetId: hit.row.id,
    valueSetName: hit.value_set_name,
    oid: hit.row.oid,
    code: rule.targetCode,
    display: String(codeEntry.display ?? rule.targetCode),
    vocabulary: String(codeEntry.system ?? hit.row.vocabulary ?? "ICD-10-CM"),
  };
}
