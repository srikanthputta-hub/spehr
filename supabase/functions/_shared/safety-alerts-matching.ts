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
