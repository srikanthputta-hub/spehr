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
 * Intensional-vs-extensional recommendation
 * ------------------------------------------
 * Single shared helper for every call site that files a `terminology_requests`
 * row (this module's `requestTerminologyUpdate`, plus the direct inserts in
 * auto-doc.server.ts, auto-api.functions.ts, admit-patient.ts and
 * auto-code.ts). It decides — from a REAL UMLS hierarchy lookup via the
 * `umls-proxy` edge function, never a hardcoded guess — whether the human
 * terminologist should recommend authoring the eventual VSAC value set as
 * "intensional" (a rule: "all descendants of X", self-updating) or
 * "extensional" (an explicit, hand-maintained code list), and records why.
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

export type DefinitionTypeRecommendation =
  | {
      recommendedType: "intensional";
      reasoning: string;
      suggestedRootConcept: { code: string; display: string };
      seedCodes: Array<{ code: string; display: string; vocabulary: string }>;
    }
  | {
      recommendedType: "extensional";
      reasoning: string;
      suggestedRootConcept?: undefined;
      seedCodes: Array<{ code: string; display: string; vocabulary: string }>;
    };

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
  operator: "descendantOrSelfOf" | "parentOf",
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

/**
 * Decide intensional vs. extensional for one terminology request's
 * candidate concept(s), with a real UMLS hierarchy sanity-check. Never
 * throws — any UMLS failure degrades to an extensional recommendation
 * built from whatever codes were already supplied/resolved, so a filing
 * call site is never blocked by this.
 */
export async function recommendDefinitionType(
  params: { vocabulary: string; candidates: RecommendedConceptCandidate[] },
  client: MinimalUmlsClient = supabase,
): Promise<DefinitionTypeRecommendation> {
  const { vocabulary } = params;

  const resolved: Array<{ code: string; display: string }> = [];
  for (const c of params.candidates) {
    const r = await resolveCandidate(client, vocabulary, c);
    if (r) resolved.push(r);
  }
  const seedCodes = resolved.map((r) => ({ code: r.code, display: r.display, vocabulary }));

  if (seedCodes.length === 0) {
    return {
      recommendedType: "extensional",
      reasoning:
        "No candidate code could be resolved for this request — defaulting to an explicit code list for a human to author by hand.",
      seedCodes: [],
    };
  }

  const sab = HIERARCHY_CAPABLE_SAB[vocabulary];
  if (!sab) {
    return {
      recommendedType: "extensional",
      reasoning: `${vocabulary} codes don't carry a governance-grade ancestor/descendant hierarchy in UMLS suitable for a self-updating rule — recommend extensional (explicit code list).`,
      seedCodes,
    };
  }

  if (seedCodes.length === 1) {
    const only = seedCodes[0];
    const expansion = await expandHierarchy(client, sab, only.code, "descendantOrSelfOf");
    if (!expansion) {
      return {
        recommendedType: "extensional",
        reasoning: `Could not reach UMLS to check ${only.code}'s descendant hierarchy — recommend extensional for now; re-check once connectivity is confirmed.`,
        seedCodes,
      };
    }
    if (expansion.count <= 1) {
      return {
        recommendedType: "extensional",
        reasoning: `${only.code} (${only.display}) is a leaf concept with no descendants in ${vocabulary} — an intensional rule would be equivalent to just this one code, so recommend extensional.`,
        seedCodes,
      };
    }
    if (expansion.count > MAX_REASONABLE_DESCENDANTS) {
      return {
        recommendedType: "extensional",
        reasoning: `${only.code} (${only.display}) has ${expansion.count}${expansion.truncated ? "+" : ""} descendants in ${vocabulary} — too broad to bind safely as a self-updating rule; recommend extensional with the originally scoped code(s).`,
        seedCodes,
      };
    }
    return {
      recommendedType: "intensional",
      reasoning: `Maps to a single ${vocabulary} hierarchy node (${only.code}, ${only.display}) with a clean descendant set (${expansion.count} concept${expansion.count === 1 ? "" : "s"}) — recommend intensional so it self-updates as new descendant codes are added.`,
      suggestedRootConcept: { code: only.code, display: only.display },
      seedCodes,
    };
  }

  // Multiple candidates — only worth an intensional rule if they share one
  // immediate hierarchy parent; otherwise forcing a rule root is artificial.
  const shared = await findSharedParent(
    client,
    sab,
    seedCodes.map((s) => s.code),
  );
  if (!shared) {
    return {
      recommendedType: "extensional",
      reasoning: `${seedCodes.length} ${vocabulary} codes span no common hierarchy parent in UMLS — recommend extensional (explicit code list) rather than forcing an artificial rule root.`,
      seedCodes,
    };
  }
  const expansion = await expandHierarchy(client, sab, shared.code, "descendantOrSelfOf");
  if (
    !expansion ||
    expansion.count <= seedCodes.length ||
    expansion.count > MAX_REASONABLE_DESCENDANTS
  ) {
    return {
      recommendedType: "extensional",
      reasoning: expansion
        ? `Shared parent ${shared.code} (${shared.display}) expands to ${expansion.count} descendant(s) — ${expansion.count > MAX_REASONABLE_DESCENDANTS ? "too broad" : "no broader than the candidate list itself"} for a clean rule; recommend extensional.`
        : `Could not confirm ${shared.code}'s descendant hierarchy via UMLS — recommend extensional for now.`,
      seedCodes,
    };
  }
  return {
    recommendedType: "intensional",
    reasoning: `${seedCodes.length} ${vocabulary} codes share a common hierarchy parent (${shared.code}, ${shared.display}) with ${expansion.count} descendants — recommend intensional anchored at that node so related codes added later are picked up automatically.`,
    suggestedRootConcept: shared,
    seedCodes,
  };
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
      suggested_root_concept: recommendation.suggestedRootConcept ?? null,
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
