/**
 * Shared value-set membership / allergy-class matching helpers.
 *
 * These back Safety Alerts Engine's Rule 1 (Drug-Allergy Conflict,
 * `src/lib/safety-alerts-engine.ts`) — event-driven, fires on each new
 * medication order — and Auto Terminologist's proactive sweep
 * (`auto-terminologist-cycle.ts`), which runs the exact same matching
 * logic over admitted patients' STANDING conditions / medication_orders /
 * allergies instead of waiting for a new-order event. Both call sites
 * import from here rather than keeping their own copy, so a change to the
 * matching rule (e.g. a new stopword) can't silently diverge between the
 * reactive and proactive paths.
 *
 * Pure, dependency-free (no Supabase client, no framework import) so it's
 * safe to import from both the Vite frontend and a Deno edge function.
 */

/** The subset of a published `custom_value_sets` row these helpers need. */
export type MatchableValueSet = {
  name: string;
  codes: Array<{ code: string; display?: string }> | null;
};

/**
 * Extract meaningful allergy-class tokens from a value set name. Stopwords
 * describe the container (allergy, allergen, drugs, class, vocabulary
 * suffixes) rather than the clinical class itself.
 */
const VS_NAME_STOPWORDS = new Set([
  "allergy",
  "allergies",
  "allergen",
  "allergens",
  "hypersensitivity",
  "class",
  "drug",
  "drugs",
  "medication",
  "medications",
  "agents",
  "agent",
  "rxnorm",
  "snomed",
  "loinc",
  "optum",
  "spehr",
  "auto",
  "and",
  "or",
  "the",
  "of",
  "for",
  "with",
  "to",
]);

export function classTokens(name: string): string[] {
  const cleaned = name
    .replace(/\([^)]*\)/g, " ") // drop parenthetical vocabulary tags
    .replace(/[^A-Za-z]+/g, " ")
    .toLowerCase();
  const out: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (raw.length < 4) continue;
    if (VS_NAME_STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

export function substanceMatchesClass(substance: string, tokens: string[]): boolean {
  const s = substance.toLowerCase();
  if (!s) return false;
  for (const t of tokens) {
    if (s.includes(t)) return true;
  }
  return false;
}

export function extensionalContains(vs: MatchableValueSet | undefined, code: string): boolean {
  if (!vs || !Array.isArray(vs.codes)) return false;
  const c = String(code).trim();
  if (!c) return false;
  return vs.codes.some((r) => String(r?.code ?? "").trim() === c);
}

/**
 * A documented chart allergy, carrying both its free-text substance string
 * AND whatever structured codes it was actually coded with (RxNorm and/or
 * SNOMED CT — see `allergies.substance_rxcui` / `allergies.substance_snomed`).
 * Either, both, or neither code may be present; `substance` is required
 * since the free-text path always needs it.
 */
export type CodedAllergy = {
  substance: string;
  rxcui?: string | null;
  snomed?: string | null;
};

/**
 * Union match for "does this documented allergy conflict with this value
 * set?" — ADDITIVE to (never a replacement for) the existing free-text
 * `substanceMatchesClass` check:
 *
 *   1. Free-text class-token match (the existing, deliberately forgiving
 *      safety net): the allergy's substance string contains one of the
 *      value set name's class tokens. This is what catches spehr's own
 *      most common real allergy — penicillin, coded as SNOMED 764146007 —
 *      against VSAC's own "Penicillin Allergy" value sets, neither of which
 *      extensionally enumerates that exact code (the RxNorm one lacks the
 *      penicillin G ingredient itself; the SNOMED one is built from allergy
 *      FINDING codes, not the substance code). Losing this path would
 *      silently break the single most common case in this app's data.
 *   2. NEW — true membership match: the allergy's own coded substance
 *      (`rxcui` and/or `snomed`) is a real extensional member of the value
 *      set (`extensionalContains`, already used for the drug side of this
 *      same check). This catches the opposite failure mode: an allergy
 *      documented with an unusual/non-obvious substance string that the
 *      free-text path would miss, but whose code is genuinely in the set
 *      (e.g. a VSAC-sourced ingredient or substance value set).
 *
 * Either signal alone is sufficient — this is a logical OR / union of the
 * two checks, never a replacement of one by the other.
 */
export function allergyMatchesValueSet(
  allergy: CodedAllergy,
  vs: MatchableValueSet,
  tokens: string[],
): boolean {
  if (substanceMatchesClass(allergy.substance, tokens)) return true;
  if (allergy.rxcui && extensionalContains(vs, allergy.rxcui)) return true;
  if (allergy.snomed && extensionalContains(vs, allergy.snomed)) return true;
  return false;
}
