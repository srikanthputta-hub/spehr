/**
 * Value-set dependency registry lookup.
 *
 * Single source of truth for "which published `custom_value_sets` rows does
 * consumer X depend on?". Consumers register themselves in
 * `public.value_set_dependencies` (by `consumer` label and/or
 * `consumer_file` path), each row pointing at a `custom_value_sets.id`.
 *
 * This helper resolves that registry to the underlying published value-set
 * rows so a rename/delete becomes visible in one table instead of silently
 * breaking individual callers.
 */

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The columns every caller actually selects — none of them override the
 * `columns` default below, so this matches the real shape of `row` exactly
 * (a subset of `custom_value_sets`), instead of widening it to `any`.
 */
export type PublishedValueSetRow = Pick<
  Database["public"]["Tables"]["custom_value_sets"]["Row"],
  "id" | "name" | "oid" | "vocabulary" | "type" | "codes" | "intensional_rule" | "status"
>;

export type PublishedValueSetHit = {
  value_set_name: string;
  row: PublishedValueSetRow;
};

export async function loadPublishedValueSetsForConsumer(
  key: { consumer?: string; consumer_file?: string },
  columns = "id, name, oid, vocabulary, type, codes, intensional_rule, status",
): Promise<PublishedValueSetHit[]> {
  let q = supabase
    .from("value_set_dependencies")
    .select(`value_set_name, custom_value_sets:value_set_id ( ${columns} )`);
  if (key.consumer) q = q.eq("consumer", key.consumer);
  if (key.consumer_file) q = q.eq("consumer_file", key.consumer_file);

  const { data, error } = await q;
  if (error || !data) return [];

  // `columns` is built from a runtime string, so Supabase's type-level query
  // parser can't resolve the joined row shape (it types `data` as a
  // ParserError placeholder) — cast to what the query actually returns at
  // runtime instead of widening to `any`.
  type JoinedRow = {
    value_set_name: string;
    custom_value_sets: PublishedValueSetRow | PublishedValueSetRow[] | null;
  };
  const rows = data as unknown as JoinedRow[];

  const out: PublishedValueSetHit[] = [];
  for (const dep of rows) {
    // The join can return either one row or an array depending on the FK
    // relationship Supabase infers; normalize to a single row either way.
    const joined = dep?.custom_value_sets;
    const row = Array.isArray(joined) ? joined[0] : joined;
    if (!row) continue;
    if (row.status && row.status !== "published") continue;
    const name = String(dep?.value_set_name ?? row?.name ?? "");
    if (!name) continue;
    out.push({ value_set_name: name, row });
  }
  return out;
}

/**
 * Intensional-vs-extensional (vs-grouping) recommendation
 * ---------------------------------------------------------
 * Single shared helper for every call site that files a `terminology_requests`
 * row (this module's `requestTerminologyUpdate`, plus the direct inserts in
 * auto-doc.server.ts, auto-api.functions.ts, admit-patient.ts, auto-code.ts
 * and useAutoTerminologist.ts's background cycle). It decides — from a REAL
 * UMLS hierarchy lookup via the `umls-proxy` edge function, never a
 * hardcoded guess — whether the human terminologist should recommend
 * authoring the eventual VSAC value set as "intensional" (a rule: "all
 * descendants of X", self-updating), "extensional" (an explicit,
 * hand-maintained code list), or "grouping" (a union of value sets that are
 * already published), and records why.
 *
 * Beyond that core decision, this helper also does the lower-level
 * terminologist legwork a human would otherwise have to redo by hand:
 *   1. Checks whether published coverage might already solve the gap
 *      (`possibleExistingMatch`) — informational only, never blocks filing.
 *   2. For RxNorm, normalizes a branded/dose-form candidate to its
 *      ingredient (TTY=IN) before using it as the basis for the
 *      hierarchy/grouping decision, while keeping the original triggering
 *      code in `seedCodes` for traceability.
 *   3. Produces `clinicalFocus` / `dataElementScope` / `inclusionCriteria` /
 *      `exclusionCriteria` — prose matching the exact 4-field "Purpose"
 *      taxonomy VSAC's own Metadata tab uses, ready to paste into VSAC with
 *      minimal editing — and a `recommendedBindingStrength` (FHIR ValueSet
 *      binding strength, derived from the requesting consumer / clinical
 *      application).
 *   4. Conservatively recommends "grouping" when a multi-candidate shared
 *      parent's immediate children strongly match names of value sets that
 *      are already published, so spehr can suggest composing those instead
 *      of drafting a new list from scratch.
 *
 * This is advisory only. Nothing here creates or touches `custom_value_sets`
 * — the recommendation is stored on the `terminology_requests` row as a
 * suggestion brief for a human, who authors the real value set in NLM VSAC
 * and pulls it back in by OID via the Value Set Library's existing
 * "Import from VSAC" flow.
 */

/** A candidate concept for a terminology request: either already coded
 * (`code` present) or free text that needs resolving first. */
export type RecommendedConceptCandidate = {
  code?: string;
  display?: string;
  vocabulary?: string;
};

/** Signal that a published `custom_value_sets` row might already solve this
 * request's gap (see capability 1 in the module doc above). Informational
 * only — surfaced to the human reviewer, never used to skip filing. */
export type PossibleExistingMatch = {
  value_set_id: string;
  name: string;
  oid: string | null;
  match_reason: string;
} | null;

/**
 * FHIR ValueSet binding-strength semantics
 * (http://hl7.org/fhir/R4/valueset-binding-strength.html):
 *   - required:   the bound element's value MUST come from this value set.
 *   - extensible: the value SHOULD come from this value set, but a code
 *                 outside it is allowed when none of the set's concepts fit
 *                 (with a documented reason).
 *   - preferred:  this value set is recommended; any code is acceptable.
 *   - example:    illustrative only — no conformance expectation at all.
 */
export type RecommendedBindingStrength = "required" | "extensible" | "preferred" | "example";

/** A currently-published value set referenced as a component of a
 * recommended "grouping" value set (capability 4). */
export type ComponentValueSetRef = { value_set_id: string; name: string; oid: string | null };

/**
 * An actively-published VSAC ValueSet from a recognized national steward
 * (NCQA, CMS, Optum, NLM, etc.) that `findKnownVsacCandidates` (capability 5
 * below) found in VSAC's own catalog — distinct from `PossibleExistingMatch`,
 * which checks spehr's own locally-published `custom_value_sets` rows. This
 * is the external-catalog counterpart: a signal that a human terminologist
 * may be able to import an already-governed value set instead of authoring
 * a new one from scratch.
 */
export type KnownVsacCandidate = {
  oid: string;
  name: string;
  title: string | null;
  publisher: string;
};

/**
 * Fields every recommendation variant carries, regardless of
 * recommendedType — added on top of the original intensional/extensional
 * shape so existing call sites keep compiling unchanged.
 *
 * `clinicalFocus`/`dataElementScope`/`inclusionCriteria`/`exclusionCriteria`
 * mirror the exact 4-field "Purpose" taxonomy NLM VSAC itself uses on a
 * value set's Metadata tab (in that order, prose, not bullets) — a human
 * should be able to paste each straight into the matching VSAC field with
 * minimal editing. For `grouping` recommendations, `inclusionCriteria` and
 * `exclusionCriteria` are left as empty strings: a real VSAC grouping value
 * set inherits its criteria from its component value sets and doesn't
 * restate them, so fabricating text here would misrepresent VSAC's own
 * behavior.
 */
type SharedRecommendationFields = {
  possibleExistingMatch: PossibleExistingMatch;
  clinicalFocus: string;
  dataElementScope: string;
  inclusionCriteria: string;
  exclusionCriteria: string;
  recommendedBindingStrength: RecommendedBindingStrength;
  // Gap 1 (external VSAC-catalog check) — see findKnownVsacCandidates below.
  // Optional so existing callers/tests that don't exercise this path keep
  // compiling unchanged; `recommendDefinitionType` always sets it (to `[]`
  // when nothing was found).
  knownVsacCandidates?: KnownVsacCandidate[];
};

export type DefinitionTypeRecommendation =
  | ({
      recommendedType: "intensional";
      reasoning: string;
      suggestedRootConcept: { code: string; display: string };
      seedCodes: Array<{ code: string; display: string; vocabulary: string }>;
    } & SharedRecommendationFields)
  | ({
      recommendedType: "extensional";
      reasoning: string;
      suggestedRootConcept?: undefined;
      seedCodes: Array<{ code: string; display: string; vocabulary: string }>;
    } & SharedRecommendationFields)
  | ({
      recommendedType: "grouping";
      reasoning: string;
      // The shared hierarchy parent behind the grouping suggestion, when one
      // was found — kept for context even though the real value set's
      // content is the union of `componentValueSets`, not this root.
      suggestedRootConcept?: { code: string; display: string };
      seedCodes: Array<{ code: string; display: string; vocabulary: string }>;
      componentValueSets: ComponentValueSetRef[];
    } & SharedRecommendationFields);

/**
 * jsonb value for `terminology_requests.suggested_root_concept`. For a
 * `grouping` recommendation this also carries `componentValueSets` (the
 * published value sets to compose) alongside the shared-parent `code`/
 * `display` when one was found — a documented reuse of this column's
 * existing jsonb shape rather than adding a one-off column just for that
 * one recommendedType. Every other variant stores exactly what it always
 * has: the root concept, or null.
 */
export function suggestedRootConceptForStorage(
  recommendation: DefinitionTypeRecommendation,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> | null {
  if (recommendation.recommendedType === "grouping") {
    return {
      ...(recommendation.suggestedRootConcept ?? {}),
      componentValueSets: recommendation.componentValueSets,
    };
  }
  return recommendation.suggestedRootConcept ?? null;
}

/** Vocabularies whose UMLS source hierarchy (ancestors/descendants) is a
 * meaningful, governance-grade basis for a self-updating VSAC rule. LOINC
 * and RxNorm atoms don't carry that kind of clinical hierarchy in UMLS, so
 * those always fall back to extensional. */
const HIERARCHY_CAPABLE_SAB: Record<string, string> = {
  "SNOMED CT": "SNOMEDCT_US",
  "ICD-10": "ICD10CM",
};

const RESOLVE_SAB: Record<string, string> = {
  "SNOMED CT": "SNOMEDCT_US",
  "ICD-10": "ICD10CM",
  LOINC: "LNC",
  RxNorm: "RXNORM",
};

type MinimalUmlsClient = {
  functions: { invoke: SupabaseClient["functions"]["invoke"] };
  // Only needed for the published-value-set lookups (capability 1's
  // possible-existing-match check, capability 4's grouping-children match)
  // — every real call site passes the full supabase/admin client already,
  // so this is never missing in production; a test double just needs to
  // provide both members.
  from: SupabaseClient["from"];
};

async function callUmlsProxy<T>(
  client: MinimalUmlsClient,
  action: string,
  params: Record<string, unknown>,
): Promise<T | null> {
  try {
    const { data, error } = await client.functions.invoke("umls-proxy", {
      body: { action, params },
    });
    if (error || !data || (data as { error?: string }).error) return null;
    return data as T;
  } catch {
    return null;
  }
}

type HierarchyExpandResult = {
  codes: Array<{ code: string; name: string }>;
  count: number;
  truncated: boolean;
};

async function expandHierarchy(
  client: MinimalUmlsClient,
  sab: string,
  code: string,
  operator: "descendantOrSelfOf" | "parentOf" | "childOf",
): Promise<HierarchyExpandResult | null> {
  return callUmlsProxy<HierarchyExpandResult>(client, "hierarchyExpand", { sab, code, operator });
}

/** Resolves a free-text candidate to a real code via UMLS. A no-op (returns
 * the candidate as-is) when it already carries a code. */
async function resolveCandidate(
  client: MinimalUmlsClient,
  vocabulary: string,
  candidate: RecommendedConceptCandidate,
): Promise<{ code: string; display: string } | null> {
  const code = candidate.code?.trim();
  if (code) return { code, display: candidate.display || code };
  const display = candidate.display?.trim();
  if (!display) return null;
  const sab = RESOLVE_SAB[candidate.vocabulary ?? vocabulary] ?? "SNOMEDCT_US";
  const result = await callUmlsProxy<{ resolvedCode: string | null; resolvedName: string | null }>(
    client,
    "resolveAndValidate",
    { string: display, sab },
  );
  if (!result?.resolvedCode) return null;
  return { code: result.resolvedCode, display: result.resolvedName || display };
}

/** Looks for a single immediate parent shared by every one of ≥2 candidate
 * codes (capped at 8 to bound UMLS round-trips). Returns null if any
 * candidate's parent lookup fails or no parent is common to all of them. */
async function findSharedParent(
  client: MinimalUmlsClient,
  sab: string,
  codes: string[],
): Promise<{ code: string; display: string } | null> {
  if (codes.length < 2) return null;
  let common: Set<string> | null = null;
  const nameByCode = new Map<string, string>();
  for (const code of codes.slice(0, 8)) {
    const parents = await expandHierarchy(client, sab, code, "parentOf");
    if (!parents || parents.codes.length === 0) return null;
    for (const p of parents.codes) nameByCode.set(p.code, p.name);
    const set = new Set(parents.codes.map((p) => p.code));
    if (common === null) {
      common = set;
    } else {
      const prev: Set<string> = common;
      common = new Set([...prev].filter((c) => set.has(c)));
    }
    if (common.size === 0) return null;
  }
  if (!common || common.size === 0) return null;
  const code = [...common][0];
  return { code, display: nameByCode.get(code) || code };
}

// Above this many descendants, a rule root is too broad to bind safely as a
// self-updating value set (it would silently absorb a lot of clinically
// unrelated codes as the hierarchy grows) — recommend extensional instead.
const MAX_REASONABLE_DESCENDANTS = 300;

/* ------------------------------------------------------------------ */
/*  Capability 2: RxNorm product/dose-form → ingredient normalization  */
/* ------------------------------------------------------------------ */

type RxNormDetailPayload = { properties?: { tty?: string; name?: string } };
type RxNormRelatedPayload = {
  relatedGroup?: {
    conceptGroup?: Array<{
      tty?: string;
      conceptProperties?: Array<{ rxcui?: string; name?: string }>;
    }>;
  };
};

/**
 * A pharmacist-terminologist wouldn't anchor a drug-class value set on one
 * branded/dose-form product — they'd resolve it to the ingredient first.
 * Checks the candidate's TTY via `rxnormDetail`; if it isn't already `IN`,
 * resolves the ingredient via `rxnormRelated` (`tty: "IN"`) and returns that
 * as the effective candidate, with a human-readable note of what changed.
 * Never throws and never blocks: any RxNav failure (or no ingredient found)
 * just falls back to the original candidate with `note: null`.
 */
async function normalizeRxNormToIngredient(
  client: MinimalUmlsClient,
  candidate: { code: string; display: string },
): Promise<{ code: string; display: string; note: string | null }> {
  try {
    const detail = await callUmlsProxy<RxNormDetailPayload>(client, "rxnormDetail", {
      rxcui: candidate.code,
    });
    const tty = detail?.properties?.tty;
    if (!tty || tty === "IN") {
      return { code: candidate.code, display: candidate.display, note: null };
    }

    const related = await callUmlsProxy<RxNormRelatedPayload>(client, "rxnormRelated", {
      rxcui: candidate.code,
      tty: "IN",
    });
    const groups = related?.relatedGroup?.conceptGroup ?? [];
    const ingredientGroup = groups.find((g) => g?.tty === "IN") ?? groups[0];
    const ingredient = ingredientGroup?.conceptProperties?.[0];
    const ingredientRxcui = ingredient?.rxcui?.trim();
    if (!ingredientRxcui) {
      return { code: candidate.code, display: candidate.display, note: null };
    }
    const ingredientName = ingredient?.name?.trim() || ingredientRxcui;
    return {
      code: ingredientRxcui,
      display: ingredientName,
      note: `Normalized from product-level RxNorm ${candidate.code} (${candidate.display}) to ingredient-level RxNorm ${ingredientRxcui} (${ingredientName}) for a cleaner value set basis.`,
    };
  } catch {
    return { code: candidate.code, display: candidate.display, note: null };
  }
}

/* ------------------------------------------------------------------ */
/*  Capability 1: possible-existing-coverage check                     */
/* ------------------------------------------------------------------ */

type PublishedSetForMatch = { id: string; name: string; oid: string | null; codes: unknown };

/** Lowercases, strips quotes/punctuation and collapses whitespace so name
 * comparisons aren't thrown off by case, quoting style or stray spacing. */
function normalizeNameForMatch(name: string): string {
  return name
    .toLowerCase()
    .replace(/['"“”‘’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Below this many characters a normalized name is too generic to treat a
// substring hit as meaningful (e.g. "a" would "match" almost anything).
const EXISTING_MATCH_MIN_NAME_LEN = 4;
// A published value set counts as "probably already covers this" once it
// contains at least this fraction of the request's seed codes.
const EXISTING_MATCH_CODE_OVERLAP_THRESHOLD = 0.8;

/** Loads the published value sets this check needs, once per
 * `recommendDefinitionType` call. A local-DB query only — no UMLS traffic —
 * and never throws (an error here just means the check finds nothing). */
async function loadPublishedSetsForMatch(
  client: MinimalUmlsClient,
): Promise<PublishedSetForMatch[]> {
  try {
    const { data, error } = await client
      .from("custom_value_sets")
      .select("id, name, oid, codes")
      .eq("status", "published");
    if (error || !data) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data as any[]).map((r) => ({
      id: String(r?.id ?? ""),
      name: String(r?.name ?? ""),
      oid: (r?.oid ?? null) as string | null,
      codes: r?.codes,
    }));
  } catch {
    return [];
  }
}

function codeSetOf(row: PublishedSetForMatch): Set<string> {
  const arr = Array.isArray(row.codes) ? row.codes : [];
  const out = new Set<string>();
  for (const c of arr) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const code = String((c as any).code ?? "").trim();
      if (code) out.add(code);
    }
  }
  return out;
}

/**
 * Before recommending "draft something new," check whether a published
 * value set probably already covers it: either it already contains a
 * strong majority of this request's seed codes, or its name is a strong
 * fuzzy/substring match for the requested name. Plain local-DB signals only
 * (no semantic similarity) — informational for the human reviewer, never a
 * reason to skip filing the request.
 */
function findPossibleExistingMatch(
  publishedSets: PublishedSetForMatch[],
  requestedName: string,
  seedCodes: Array<{ code: string }>,
): PossibleExistingMatch {
  if (publishedSets.length === 0) return null;
  const seedCodeSet = new Set(seedCodes.map((c) => c.code).filter(Boolean));
  const normalizedRequested = normalizeNameForMatch(requestedName);

  let codeMatch: { row: PublishedSetForMatch; reason: string } | null = null;
  let nameMatch: { row: PublishedSetForMatch; reason: string } | null = null;

  for (const row of publishedSets) {
    if (!codeMatch && seedCodeSet.size > 0) {
      const rowCodes = codeSetOf(row);
      if (rowCodes.size > 0) {
        let hit = 0;
        for (const c of seedCodeSet) if (rowCodes.has(c)) hit++;
        const overlap = hit / seedCodeSet.size;
        if (overlap >= EXISTING_MATCH_CODE_OVERLAP_THRESHOLD) {
          codeMatch = {
            row,
            reason: `Published value set "${row.name}" already contains ${hit}/${seedCodeSet.size} (${Math.round(overlap * 100)}%) of this request's seed codes.`,
          };
        }
      }
    }
    if (!nameMatch && normalizedRequested.length >= EXISTING_MATCH_MIN_NAME_LEN) {
      const normalizedRow = normalizeNameForMatch(row.name);
      if (
        normalizedRow.length >= EXISTING_MATCH_MIN_NAME_LEN &&
        (normalizedRow === normalizedRequested ||
          normalizedRow.includes(normalizedRequested) ||
          normalizedRequested.includes(normalizedRow))
      ) {
        nameMatch = {
          row,
          reason: `Published value set name "${row.name}" is a strong match for the requested name "${requestedName}".`,
        };
      }
    }
    if (codeMatch && nameMatch) break;
  }

  // Code overlap is the stronger signal — prefer it when both fired on
  // different rows.
  const best = codeMatch ?? nameMatch;
  if (!best) return null;
  return {
    value_set_id: best.row.id,
    name: best.row.name,
    oid: best.row.oid,
    match_reason: best.reason,
  };
}

/* ------------------------------------------------------------------ */
/*  Capability 4: conservative "grouping" recommendation                */
/* ------------------------------------------------------------------ */

function tokensOf(name: string): string[] {
  return normalizeNameForMatch(name).split(" ").filter(Boolean);
}

// A grouping candidate's children need ≥90% token overlap (or a strong
// substring match) with a published value set's name to count as a hit —
// a wrong grouping suggestion is worse than no suggestion, so this stays
// conservative on purpose.
const GROUPING_TOKEN_OVERLAP_THRESHOLD = 0.9;

function namesStronglyMatch(a: string, b: string): boolean {
  const na = normalizeNameForMatch(a);
  const nb = normalizeNameForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (
    na.length >= EXISTING_MATCH_MIN_NAME_LEN &&
    nb.length >= EXISTING_MATCH_MIN_NAME_LEN &&
    (na.includes(nb) || nb.includes(na))
  ) {
    return true;
  }
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let common = 0;
  for (const t of setA) if (setB.has(t)) common++;
  const smaller = Math.min(setA.size, setB.size);
  return smaller > 0 && common / smaller >= GROUPING_TOKEN_OVERLAP_THRESHOLD;
}

/**
 * Conservative check, run only once a multi-candidate shared parent has
 * already been found: does that parent's immediate-children set (via
 * `hierarchyExpand`/`childOf`) strongly name-match ≥2 already-published
 * value sets? If so, spehr should suggest composing those existing value
 * sets (a FHIR `compose.include[].valueSet` union) rather than drafting a
 * new list — otherwise this returns null and the caller falls through to
 * the existing intensional/extensional logic unchanged.
 */
async function maybeRecommendGrouping(
  client: MinimalUmlsClient,
  sab: string,
  shared: { code: string; display: string },
  publishedSets: PublishedSetForMatch[],
): Promise<{ reasoning: string; componentValueSets: ComponentValueSetRef[] } | null> {
  if (publishedSets.length < 2) return null;
  const children = await expandHierarchy(client, sab, shared.code, "childOf");
  if (!children || children.codes.length === 0) return null;

  const matches: ComponentValueSetRef[] = [];
  for (const child of children.codes) {
    if (!child.name) continue;
    const row = publishedSets.find(
      (r) =>
        !matches.some((m) => m.value_set_id === r.id) && namesStronglyMatch(child.name, r.name),
    );
    if (row) matches.push({ value_set_id: row.id, name: row.name, oid: row.oid });
  }
  if (matches.length < 2) return null;

  return {
    reasoning: `Shared parent ${shared.code} (${shared.display})'s immediate children strongly match ${matches.length} already-published value set(s) (${matches.map((m) => m.name).join(", ")}) — recommend a "grouping" value set that composes these existing value sets (FHIR compose.include[].valueSet) rather than drafting a new code list from scratch.`,
    componentValueSets: matches,
  };
}

/* ------------------------------------------------------------------ */
/*  Capability 5 (Gap 1): external VSAC-catalog existing-value-set check */
/* ------------------------------------------------------------------ */

// Boilerplate phrasing a requesting consumer's auto-generated request name
// often carries (e.g. "Drug-Allergy coverage for Penicillins") — stripped
// down to the clinical class name itself before searching VSAC's own
// catalog, since that's a cleaner keyword than the full generated sentence.
// Best-effort only; falls back to the original name when nothing matches.
const REQUEST_NAME_BOILERPLATE: RegExp[] = [
  /^drug-allergy coverage for\s+/i,
  /^coverage gap:?\s*/i,
  /^terminology gap:?\s*/i,
  /^missing coverage for\s+/i,
  /^value set needed for\s+/i,
];

function cleanedSearchKeyword(requestedName: string): string {
  let s = requestedName.trim();
  for (const re of REQUEST_NAME_BOILERPLATE) s = s.replace(re, "");
  s = s.trim();
  return s || requestedName.trim();
}

type VsacSearchResult = {
  candidates: Array<{
    oid: string;
    name: string | null;
    title: string | null;
    publisher: string | null;
    status: string | null;
  }>;
};

/**
 * Before recommending that a human author a value set from scratch, check
 * whether VSAC's own catalog already has one from a recognized national
 * steward (NCQA, CMS, Optum, NLM, etc.) that might cover this request — the
 * same thing a real VSAC terminologist does via VSAC's "Search Value Sets"
 * tab before authoring anything new. Uses the `vsacSearch` umls-proxy
 * action (keyword search against VSAC's FHIR ValueSet catalog). Any
 * *active* VSAC ValueSet with a non-empty `publisher` counts as a signal of
 * a real governed value set — deliberately no hardcoded allowlist of
 * specific steward names, since VSAC hosts value sets from many
 * organizations and a hardcoded list would quietly miss new ones.
 *
 * Informational only — this is the external-catalog counterpart to
 * capability 1's local `possibleExistingMatch` check, and never blocks
 * filing. Any `vsacSearch` failure (network, auth, bad response) just
 * yields no candidates, same never-throws philosophy as the rest of this
 * module.
 */
async function findKnownVsacCandidates(
  client: MinimalUmlsClient,
  requestedName: string,
): Promise<KnownVsacCandidate[]> {
  const keyword = cleanedSearchKeyword(requestedName ?? "");
  if (!keyword) return [];
  const result = await callUmlsProxy<VsacSearchResult>(client, "vsacSearch", {
    query: keyword,
    count: 10,
  });
  const candidates = result?.candidates ?? [];
  const out: KnownVsacCandidate[] = [];
  for (const c of candidates) {
    const oid = String(c?.oid ?? "").trim();
    const publisher = String(c?.publisher ?? "").trim();
    const status = String(c?.status ?? "").trim();
    if (!oid || !publisher || status !== "active") continue;
    out.push({
      oid,
      name: c.name || c.title || oid,
      title: c.title ?? null,
      publisher,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Capability 3: inclusion/exclusion notes + binding-strength table    */
/* ------------------------------------------------------------------ */

/**
 * Simple, defensible rule table mapping the request's requesting consumer /
 * clinical application to a starting FHIR binding-strength recommendation
 * (see the `RecommendedBindingStrength` doc comment above for what each
 * value means). The requesting consumer is checked first because it's the
 * more specific, reliable signal — e.g. Auto Doc's own `clinical_application`
 * happens to be "CDS" too, same as Safety Alerts Engine's, so checking
 * consumer first keeps "Auto Doc" mapped to documentation-grade `preferred`
 * instead of being swept into safety-grade `required`. A human steward can
 * always override this when authoring the real value set in VSAC.
 */
function recommendBindingStrength(context?: {
  clinicalApplication?: string;
  requestingConsumer?: string;
}): RecommendedBindingStrength {
  const consumer = (context?.requestingConsumer ?? "").toLowerCase();
  if (consumer.includes("safety") || consumer.includes("alert")) return "required";
  if (consumer.includes("doc")) return "preferred";
  if (consumer.includes("admin")) return "extensible";

  const app = (context?.clinicalApplication ?? "").toLowerCase();
  if (app.includes("cds") || app.includes("safety") || app.includes("alert")) return "required";
  if (app.includes("document")) return "preferred";
  if (app.includes("billing") || app.includes("population")) return "extensible";

  return "example";
}

/** The "core" shape `computeCoreRecommendation` produces, before the shared
 * fields (possibleExistingMatch / clinicalFocus / dataElementScope /
 * inclusionCriteria / exclusionCriteria / recommendedBindingStrength) are
 * merged on by `recommendDefinitionType`. */
type CoreRecommendation =
  | { recommendedType: "extensional"; reasoning: string }
  | {
      recommendedType: "intensional";
      reasoning: string;
      suggestedRootConcept: { code: string; display: string };
    }
  | {
      recommendedType: "grouping";
      reasoning: string;
      suggestedRootConcept: { code: string; display: string };
      componentValueSets: ComponentValueSetRef[];
    };

/**
 * QDM/FHIR "Data Element Scope" category — the second field of VSAC's own
 * Purpose section, always one of a small fixed vocabulary of category
 * phrases (never invented). Vocabulary is the most specific signal
 * (RxNorm → medication, LOINC → lab), then the request's own name/
 * justification text (allergy/procedure/symptom-shaped names), then
 * requesting_consumer/clinical_application as a fallback hint; defaults to
 * "Diagnosis, Active" when nothing fits more specifically. A human steward
 * can always correct this when authoring the real value set in VSAC.
 */
function recommendDataElementScope(args: {
  vocabulary: string;
  requestedName: string;
  justification?: string;
  context?: { clinicalApplication?: string; requestingConsumer?: string };
}): string {
  const text = `${args.requestedName} ${args.justification ?? ""}`.toLowerCase();
  const app = (args.context?.clinicalApplication ?? "").toLowerCase();
  const consumer = (args.context?.requestingConsumer ?? "").toLowerCase();

  if (args.vocabulary === "RxNorm") return "Medication, Administered or Medication, Order";
  if (args.vocabulary === "LOINC") return "Laboratory Test, Order or Laboratory Test, Result";
  if (text.includes("allerg") || text.includes("intoleran")) {
    return "Allergy, Intolerance, or Problem List";
  }
  if (text.includes("procedure") || text.includes("surgery") || text.includes("surgical")) {
    return "Procedure, Performed or Procedure, Order";
  }
  if (text.includes("symptom") || text.includes("finding")) return "Symptom, Finding";
  if (consumer.includes("safety") || consumer.includes("alert")) {
    return "Allergy, Intolerance, or Problem List";
  }
  if (app.includes("billing") || app.includes("population")) return "Encounter Diagnosis";
  return "Diagnosis, Active";
}

/**
 * VSAC's "Clinical Focus" field: one or two sentences on what clinical
 * concept this value set identifies and why. This is a best-effort,
 * intentionally generic starting draft — the system doesn't know the
 * specific clinical protocol behind a request, so it names the concept and
 * who's asking rather than fabricating clinical specifics it doesn't have;
 * a human steward fills in the rest before publishing.
 */
function buildClinicalFocus(args: {
  requestedName: string;
  vocabulary: string;
  context?: { clinicalApplication?: string; requestingConsumer?: string };
  core: CoreRecommendation;
}): string {
  const appPhrase = args.context?.clinicalApplication
    ? ` for ${args.context.clinicalApplication} use`
    : "";
  if (args.core.recommendedType === "grouping") {
    return `The purpose of this grouping value set is to provide a comprehensive view of "${args.requestedName}" by composing the existing value sets listed below${appPhrase}.`;
  }
  const consumerPhrase = args.context?.requestingConsumer
    ? ` flagged by ${args.context.requestingConsumer}`
    : "";
  return `The purpose of this value set is to represent ${args.vocabulary} concepts for "${args.requestedName}"${appPhrase}${consumerPhrase}. A human steward should refine this description with the specific clinical protocol or use case before publishing in VSAC.`;
}

/** VSAC's "Inclusion Criteria" field: prose (not bullets). Empty for
 * `grouping` — see the `SharedRecommendationFields` doc comment above. */
function buildInclusionCriteria(args: {
  core: CoreRecommendation;
  effective: Array<{ code: string; display: string }>;
  vocabulary: string;
  rxnormNormalizationHappened: boolean;
}): string {
  if (args.core.recommendedType === "grouping") return "";

  let base: string;
  if (args.core.recommendedType === "intensional") {
    const root = args.core.suggestedRootConcept;
    base = `Includes ${args.vocabulary} concept ${root.code} (${root.display}) and all of its hierarchical descendant concepts.`;
  } else {
    const names = args.effective
      .slice(0, 5)
      .map((c) => c.display)
      .filter(Boolean);
    const examples = names.length > 0 ? ` (e.g., ${names.join(", ")})` : "";
    base = `Includes the explicitly reviewed ${args.vocabulary} concept(s) for this request${examples}.`;
  }
  return args.rxnormNormalizationHappened
    ? `${base} Matches at the ingredient (TTY=IN) level rather than the specific branded/dose-form product(s) that triggered this request.`
    : base;
}

/** VSAC's "Exclusion Criteria" field: prose (not bullets). Empty for
 * `grouping` — see the `SharedRecommendationFields` doc comment above. */
function buildExclusionCriteria(args: {
  core: CoreRecommendation;
  rxnormNormalizationHappened: boolean;
}): string {
  if (args.core.recommendedType === "grouping") return "";
  const parts: string[] = ["Excludes inactive/retired concepts."];
  if (args.rxnormNormalizationHappened) {
    parts.push(
      "Excludes product-/dose-form-level RxNorm codes from the definition itself; they are kept only as traceability context for how this request was triggered.",
    );
  }
  return parts.join(" ");
}

/**
 * Decides the authoring approach — intensional / extensional / grouping —
 * for one terminology request's (already-resolved, RxNorm-normalized)
 * candidate concept(s), with a real UMLS hierarchy sanity-check. This is
 * the part of `recommendDefinitionType` that was here before capabilities
 * 1–4 were layered on; it operates on `effective` candidates (see capability
 * 2) and, for the multi-candidate path, also tries the capability-4
 * grouping check before falling back to the original intensional check.
 * Never throws — any UMLS failure degrades to extensional.
 */
async function computeCoreRecommendation(
  vocabulary: string,
  effective: Array<{ code: string; display: string }>,
  client: MinimalUmlsClient,
  publishedSets: PublishedSetForMatch[],
): Promise<CoreRecommendation> {
  if (effective.length === 0) {
    return {
      recommendedType: "extensional",
      reasoning:
        "No candidate code could be resolved for this request — defaulting to an explicit code list for a human to author by hand.",
    };
  }

  const sab = HIERARCHY_CAPABLE_SAB[vocabulary];
  if (!sab) {
    return {
      recommendedType: "extensional",
      reasoning: `${vocabulary} codes don't carry a governance-grade ancestor/descendant hierarchy in UMLS suitable for a self-updating rule — recommend extensional (explicit code list).`,
    };
  }

  if (effective.length === 1) {
    const only = effective[0];
    const expansion = await expandHierarchy(client, sab, only.code, "descendantOrSelfOf");
    if (!expansion) {
      return {
        recommendedType: "extensional",
        reasoning: `Could not reach UMLS to check ${only.code}'s descendant hierarchy — recommend extensional for now; re-check once connectivity is confirmed.`,
      };
    }
    if (expansion.count <= 1) {
      return {
        recommendedType: "extensional",
        reasoning: `${only.code} (${only.display}) is a leaf concept with no descendants in ${vocabulary} — an intensional rule would be equivalent to just this one code, so recommend extensional.`,
      };
    }
    if (expansion.count > MAX_REASONABLE_DESCENDANTS) {
      return {
        recommendedType: "extensional",
        reasoning: `${only.code} (${only.display}) has ${expansion.count}${expansion.truncated ? "+" : ""} descendants in ${vocabulary} — too broad to bind safely as a self-updating rule; recommend extensional with the originally scoped code(s).`,
      };
    }
    return {
      recommendedType: "intensional",
      reasoning: `Maps to a single ${vocabulary} hierarchy node (${only.code}, ${only.display}) with a clean descendant set (${expansion.count} concept${expansion.count === 1 ? "" : "s"}) — recommend intensional so it self-updates as new descendant codes are added.`,
      suggestedRootConcept: { code: only.code, display: only.display },
    };
  }

  // Multiple candidates — only worth an intensional rule if they share one
  // immediate hierarchy parent; otherwise forcing a rule root is artificial.
  const shared = await findSharedParent(
    client,
    sab,
    effective.map((s) => s.code),
  );
  if (!shared) {
    return {
      recommendedType: "extensional",
      reasoning: `${effective.length} ${vocabulary} codes span no common hierarchy parent in UMLS — recommend extensional (explicit code list) rather than forcing an artificial rule root.`,
    };
  }

  // Capability 4 — conservative grouping check, tried before the (costlier)
  // full descendant expansion below. Falls through untouched if it doesn't
  // clearly fire.
  const grouping = await maybeRecommendGrouping(client, sab, shared, publishedSets);
  if (grouping) {
    return {
      recommendedType: "grouping",
      reasoning: grouping.reasoning,
      suggestedRootConcept: shared,
      componentValueSets: grouping.componentValueSets,
    };
  }

  const expansion = await expandHierarchy(client, sab, shared.code, "descendantOrSelfOf");
  if (
    !expansion ||
    expansion.count <= effective.length ||
    expansion.count > MAX_REASONABLE_DESCENDANTS
  ) {
    return {
      recommendedType: "extensional",
      reasoning: expansion
        ? `Shared parent ${shared.code} (${shared.display}) expands to ${expansion.count} descendant(s) — ${expansion.count > MAX_REASONABLE_DESCENDANTS ? "too broad" : "no broader than the candidate list itself"} for a clean rule; recommend extensional.`
        : `Could not confirm ${shared.code}'s descendant hierarchy via UMLS — recommend extensional for now.`,
    };
  }
  return {
    recommendedType: "intensional",
    reasoning: `${effective.length} ${vocabulary} codes share a common hierarchy parent (${shared.code}, ${shared.display}) with ${expansion.count} descendants — recommend intensional anchored at that node so related codes added later are picked up automatically.`,
    suggestedRootConcept: shared,
  };
}

/**
 * Decide intensional vs. extensional vs. grouping for one terminology
 * request's candidate concept(s), with a real UMLS hierarchy sanity-check
 * plus the terminologist-grade legwork described in the module doc above
 * (possible-existing-coverage check, RxNorm ingredient normalization,
 * inclusion/exclusion notes, binding-strength recommendation, conservative
 * grouping detection). Never throws — any failure anywhere in here degrades
 * to an extensional recommendation built from whatever codes were already
 * supplied/resolved, so a filing call site is never blocked by this.
 */
export async function recommendDefinitionType(
  params: {
    vocabulary: string;
    candidates: RecommendedConceptCandidate[];
    // Name of the request being filed — used for capability 1's fuzzy
    // name-match check and as the subject of the generated Clinical Focus/
    // Data Element Scope text. Optional so existing call sites keep
    // compiling; omitting it just weakens those (code-overlap matching and
    // the vocabulary-based scope rules still work without it).
    requestedName?: string;
    // The filed request's own justification text — an optional extra
    // signal for the Data Element Scope rule table (capability 3b) when
    // the requested name alone doesn't hint at allergy/procedure/symptom.
    justification?: string;
    // Only used for capability 3's binding-strength + Data Element Scope
    // rule tables.
    context?: { clinicalApplication?: string; requestingConsumer?: string };
  },
  client: MinimalUmlsClient = supabase,
): Promise<DefinitionTypeRecommendation> {
  const { vocabulary, requestedName, justification, context } = params;
  const recommendedBindingStrength = recommendBindingStrength(context);
  const dataElementScope = recommendDataElementScope({
    vocabulary,
    requestedName: requestedName ?? "",
    justification,
    context,
  });

  // Resolve each candidate, then (RxNorm only) normalize it to ingredient
  // level for the hierarchy/grouping decision — keeping the ORIGINAL
  // triggering code+display in `seedCodes` for traceability either way.
  const seedCodes: Array<{ code: string; display: string; vocabulary: string }> = [];
  const effective: Array<{ code: string; display: string }> = [];
  const rxnormNormalizationNotes: string[] = [];
  for (const c of params.candidates) {
    const r = await resolveCandidate(client, vocabulary, c);
    if (!r) continue;
    seedCodes.push({ code: r.code, display: r.display, vocabulary });
    if (vocabulary === "RxNorm") {
      const normalized = await normalizeRxNormToIngredient(client, r);
      effective.push({ code: normalized.code, display: normalized.display });
      if (normalized.note) rxnormNormalizationNotes.push(normalized.note);
    } else {
      effective.push({ code: r.code, display: r.display });
    }
  }

  // Capability 1's published-value-set lookup, fetched once and reused by
  // capability 4's grouping-children match below.
  const publishedSets = await loadPublishedSetsForMatch(client);
  const possibleExistingMatch = findPossibleExistingMatch(
    publishedSets,
    requestedName ?? "",
    seedCodes,
  );
  // Capability 5 (Gap 1) — the external-catalog counterpart to the
  // possible-existing-match check above: does VSAC's own catalog already
  // have an actively-published, steward-governed value set for this?
  const knownVsacCandidates = await findKnownVsacCandidates(client, requestedName ?? "");

  const core = await computeCoreRecommendation(vocabulary, effective, client, publishedSets);
  const rxnormNormalizationHappened = rxnormNormalizationNotes.length > 0;
  const reasoningParts = [core.reasoning];
  if (rxnormNormalizationHappened) reasoningParts.push(rxnormNormalizationNotes.join(" "));
  if (knownVsacCandidates.length > 0) {
    reasoningParts.push(
      `Found ${knownVsacCandidates.length} actively-published VSAC value set(s) from recognized steward(s) (${knownVsacCandidates
        .map((c) => `"${c.name}" — ${c.publisher}`)
        .join("; ")}) — consider importing one of these instead of authoring a new one.`,
    );
  }
  const reasoning = reasoningParts.join(" ");
  const clinicalFocus = buildClinicalFocus({
    requestedName: requestedName ?? "this request",
    vocabulary,
    context,
    core,
  });
  const inclusionCriteria = buildInclusionCriteria({
    core,
    effective,
    vocabulary,
    rxnormNormalizationHappened,
  });
  const exclusionCriteria = buildExclusionCriteria({ core, rxnormNormalizationHappened });

  const shared = {
    reasoning,
    seedCodes,
    possibleExistingMatch,
    clinicalFocus,
    dataElementScope,
    inclusionCriteria,
    exclusionCriteria,
    recommendedBindingStrength,
    knownVsacCandidates,
  };

  if (core.recommendedType === "grouping") {
    return {
      recommendedType: "grouping",
      ...shared,
      suggestedRootConcept: core.suggestedRootConcept,
      componentValueSets: core.componentValueSets,
    };
  }
  if (core.recommendedType === "intensional") {
    return {
      recommendedType: "intensional",
      ...shared,
      suggestedRootConcept: core.suggestedRootConcept,
    };
  }
  return { recommendedType: "extensional", ...shared };
}

/**
 * File (or extend) a governed change request against the Auto Terminologist
 * demand queue (`terminology_requests`). If a PENDING request already exists
 * for the same (requesting_consumer, requested_name), new seed codes are
 * merged into it (dedup by code) instead of creating a duplicate row — this
 * mirrors the real-world "change request" pattern where a terminologist
 * consolidates repeat asks rather than processing the same ask twice.
 *
 * Files a suggestion brief only: `recommendDefinitionType` decides and
 * records recommended_type/reasoning/suggested_root_concept on the row, but
 * nothing here ever creates a `custom_value_sets` row — that only happens
 * once a human authors the value set in real VSAC and imports it by OID.
 */
export async function requestTerminologyUpdate(req: {
  requesting_consumer: string;
  requested_name: string;
  justification: string;
  priority?: "low" | "normal" | "high" | "urgent";
  vocabulary?: string;
  seed_codes: Array<{ code: string; display?: string }>;
  clinical_application?: string;
  related_mrn?: string | null;
}): Promise<void> {
  try {
    const recommendation = await recommendDefinitionType({
      vocabulary: req.vocabulary ?? "SNOMED CT",
      candidates: req.seed_codes,
      requestedName: req.requested_name,
      justification: req.justification,
      context: {
        clinicalApplication: req.clinical_application,
        requestingConsumer: req.requesting_consumer,
      },
    });
    const { error: insertErr } = await supabase.from("terminology_requests").insert({
      requesting_consumer: req.requesting_consumer,
      requested_name: req.requested_name,
      justification: req.justification,
      priority: req.priority ?? "normal",
      vocabulary: req.vocabulary ?? null,
      seed_codes: req.seed_codes,
      clinical_application: req.clinical_application ?? null,
      related_mrn: req.related_mrn ?? null,
      status: "pending",
      request_type: "create",
      requested_at: new Date().toISOString(),
      recommended_type: recommendation.recommendedType,
      reasoning: recommendation.reasoning,
      suggested_root_concept: suggestedRootConceptForStorage(recommendation),
      recommended_binding_strength: recommendation.recommendedBindingStrength,
      possible_existing_match: recommendation.possibleExistingMatch,
      clinical_focus: recommendation.clinicalFocus,
      data_element_scope: recommendation.dataElementScope,
      inclusion_criteria: recommendation.inclusionCriteria,
      exclusion_criteria: recommendation.exclusionCriteria,
      known_vsac_candidates:
        recommendation.knownVsacCandidates && recommendation.knownVsacCandidates.length > 0
          ? recommendation.knownVsacCandidates
          : null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    if (!insertErr) return; // fresh pending request created
    if (insertErr.code !== "23505") {
      console.warn(
        "[value-set-registry] requestTerminologyUpdate insert failed",
        insertErr.message,
      );
      return;
    }

    // Unique-violation: a pending request for this (consumer, name) already
    // exists — merge our seed codes into it instead of creating a duplicate.
    const { data: existing } = await supabase
      .from("terminology_requests")
      .select("id, seed_codes")
      .eq("requesting_consumer", req.requesting_consumer)
      .eq("requested_name", req.requested_name)
      .eq("status", "pending")
      .maybeSingle();
    if (!existing) return; // resolved/processed between our insert attempt and this read

    const prevCodes: Array<{ code: string; display?: string }> = Array.isArray(existing.seed_codes)
      ? (existing.seed_codes as Array<{ code: string; display?: string }>)
      : [];
    const seen = new Set(prevCodes.map((c) => String(c?.code ?? "")));
    const merged = [...prevCodes];
    for (const c of req.seed_codes) {
      const code = String(c?.code ?? "").trim();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      merged.push(c);
    }
    if (merged.length === prevCodes.length) return; // nothing new to add
    await supabase
      .from("terminology_requests")
      .update({ seed_codes: merged, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
  } catch (e) {
    console.warn("[value-set-registry] requestTerminologyUpdate failed", (e as Error)?.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Gap 2 — shared VSAC $expand → custom_value_sets import insert       */
/* ------------------------------------------------------------------ */
//
// Extracted from ValueSetLibrary.tsx's "Import from VSAC" dialog
// (`handleVsacImport`) so that dialog and Auto Terminologist's one-click
// "Import Now" action (AutoTerminologistActivity.tsx — a `ready_to_import`
// row's background-detected publication, or a `knownVsacCandidates` hit)
// build the exact same `custom_value_sets` insert payload instead of
// duplicating this shape in two places. Neither call site is forced to use
// this one way — each still performs its own `.insert()` and handles its
// own toasts/activity-logging/request-row bookkeeping in its own idiom;
// this only owns the shared "what does the row look like" logic.

/** The normalized shape every `vsacExpand` umls-proxy call returns — same
 * shape ValueSetLibrary.tsx's `handleVsacFetch` already builds from it. */
export type VsacExpansionResult = {
  oid: string;
  name: string | null;
  title: string | null;
  total: number;
  type: "grouping" | "intensional" | "extensional";
  codes: Array<{ code: string; display: string; vocabulary: string }>;
};

function slugifyValueSetName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** What `buildVsacImportInsert` returns — a plain object shaped like a
 * `custom_value_sets` insert row (but not imported from the generated
 * Database types, since `system`/`vocabulary` here can be `null` ahead of
 * dominant-vocabulary detection in a way that type doesn't model). */
export type VsacImportInsert = {
  name: string;
  oid: string;
  vocabulary: string | null;
  system: string | null;
  type: "grouping" | "intensional" | "extensional";
  codes: Array<{ code: string; display: string; system: string }>;
  status: "draft";
  description: string;
  fhir_url: string;
  change_history: Array<{ at: string; actor: string; change: string }>;
};

/**
 * Builds the `custom_value_sets` insert payload for importing a VSAC
 * $expand result as a new draft — identical to what ValueSetLibrary.tsx's
 * `handleVsacImport` has always inserted (dominant-vocabulary detection,
 * auto FHIR URL, `status: "draft"`, the "Imported from VSAC" change-history
 * entry). Pure/no I/O: callers perform the actual `.insert()` themselves so
 * each can keep its own error handling and post-insert bookkeeping (activity
 * log, toast, linking back to a `terminology_requests` row, etc.).
 */
export function buildVsacImportInsert(
  expansion: VsacExpansionResult,
  name: string,
): VsacImportInsert {
  const trimmedName = name.trim() || `VSAC ${expansion.oid}`;
  const counts: Record<string, number> = {};
  for (const c of expansion.codes) counts[c.vocabulary] = (counts[c.vocabulary] ?? 0) + 1;
  const dominantVocab = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const codes = expansion.codes.map((c) => ({
    code: c.code,
    display: c.display,
    system: c.vocabulary,
  }));
  const now = new Date().toISOString();
  return {
    name: trimmedName,
    oid: expansion.oid,
    vocabulary: dominantVocab,
    system: dominantVocab ? dominantVocab.replace(" ", "-") : null,
    type: expansion.type,
    codes,
    status: "draft",
    description: "Imported from VSAC",
    fhir_url: `http://spehr.live/fhir/ValueSet/${slugifyValueSetName(trimmedName)}`,
    change_history: [
      { at: now, actor: "S.P.E.H.R. Terminology Services", change: "Imported from VSAC" },
    ],
  };
}
