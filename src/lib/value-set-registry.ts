/**
 * Value-set dependency registry — thin re-export + frontend-default-client
 * wrapper.
 *
 * The actual implementation lives in
 * `supabase/functions/_shared/value-set-registry.ts` so that BOTH the
 * client-side React code (Safety Alerts Engine, Auto Doc, the Auto
 * Terminologist hook/cycle, ...) and the server-side
 * `auto-terminologist-cycle` edge function share the exact same
 * `recommendDefinitionType` / `requestTerminologyUpdate` /
 * `loadPublishedValueSetsForConsumer` logic (same pattern as
 * `discharge-narrative.ts` → `supabase/functions/_shared/discharge-narrative.ts`).
 * Do NOT duplicate or fork that logic here — every rule change must land in
 * the shared file.
 *
 * The shared implementation takes its Supabase client as an explicit
 * parameter (no hardcoded import, so it's Deno-importable). The wrappers
 * below exist only so every existing frontend call site — none of which
 * pass a client — keeps compiling unchanged, by defaulting to this app's
 * browser `supabase` singleton.
 *
 * `linkPendingDependencies` and its describe/format helpers below are
 * frontend-only (used by ValueSetLibrary.tsx's manual "Import from VSAC"
 * dialog and AutoTerminologistActivity.tsx's one-click import flows) — the
 * server-side cycle never calls them, so they stay here rather than moving
 * to the shared module.
 */
import { supabase } from "@/integrations/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadPublishedValueSetsForConsumer as sharedLoadPublishedValueSetsForConsumer,
  recommendDefinitionType as sharedRecommendDefinitionType,
  requestTerminologyUpdate as sharedRequestTerminologyUpdate,
  type MinimalUmlsClient,
  type PublishedValueSetHit,
  type PublishedValueSetRow,
  type RecommendedConceptCandidate,
  type PossibleExistingMatch,
  type RecommendedBindingStrength,
  type ComponentValueSetRef,
  type KnownVsacCandidate,
  type DefinitionTypeRecommendation,
  type VsacExpansionResult,
  type VsacImportInsert,
} from "../../supabase/functions/_shared/value-set-registry";

export {
  suggestedRootConceptForStorage,
  buildVsacImportInsert,
} from "../../supabase/functions/_shared/value-set-registry";
export type {
  MinimalUmlsClient,
  PublishedValueSetHit,
  PublishedValueSetRow,
  RecommendedConceptCandidate,
  PossibleExistingMatch,
  RecommendedBindingStrength,
  ComponentValueSetRef,
  KnownVsacCandidate,
  DefinitionTypeRecommendation,
  VsacExpansionResult,
  VsacImportInsert,
};

export async function loadPublishedValueSetsForConsumer(
  key: { consumer?: string; consumer_file?: string },
  columns?: string,
  client: MinimalUmlsClient = supabase,
): Promise<PublishedValueSetHit[]> {
  return sharedLoadPublishedValueSetsForConsumer(
    key,
    client,
    columns ?? "id, name, oid, vocabulary, type, codes, intensional_rule, status",
  );
}

export async function recommendDefinitionType(
  params: {
    vocabulary: string;
    candidates: RecommendedConceptCandidate[];
    requestedName?: string;
    justification?: string;
    context?: { clinicalApplication?: string; requestingConsumer?: string };
  },
  client: MinimalUmlsClient = supabase,
): Promise<DefinitionTypeRecommendation> {
  return sharedRecommendDefinitionType(params, client);
}

/**
 * File (or extend) a governed change request against the Auto Terminologist
 * demand queue (`terminology_requests`). Thin wrapper over the shared
 * implementation (which also owns the `occurrence_count` bump-on-repeat-hit
 * logic) — see `supabase/functions/_shared/value-set-registry.ts` for the
 * full doc comment.
 */
export async function requestTerminologyUpdate(
  req: {
    requesting_consumer: string;
    requested_name: string;
    justification: string;
    priority?: "low" | "normal" | "high" | "urgent";
    vocabulary?: string;
    seed_codes: Array<{ code: string; display?: string }>;
    clinical_application?: string;
    related_mrn?: string | null;
  },
  client: MinimalUmlsClient = supabase,
): Promise<void> {
  return sharedRequestTerminologyUpdate(req, client);
}

/* ------------------------------------------------------------------ */
/*  Gap 3 — close the loop: link a fresh import to the dependency rows  */
/*  that were waiting on it                                            */
/* ------------------------------------------------------------------ */
//
// `value_set_dependencies` rows get filed with `value_set_name` set and
// `value_set_id` NULL the moment a consumer (Safety Alerts Engine, Auto
// Doc, …) declares it needs a value set that doesn't exist yet. Once a
// human actually authors that value set in VSAC and pulls it back in
// through any "Import from VSAC" flow, nothing wired the two together —
// the dependency row stayed NULL forever and the human had no visible
// signal that the consumer rule it names was now ready to go live. This is
// the shared post-import step that closes that loop for every import path
// (ValueSetLibrary.tsx's manual dialog, and both of Auto Terminologist's
// one-click flows, which already share one insert tail —
// `importExpansionAndResolve` in AutoTerminologistActivity.tsx).

/** One `value_set_dependencies` row this import satisfied. */
export type LinkedDependency = {
  id: string;
  consumer: string;
  purpose: string;
  lookup_mode: string | null;
};

type DependencyLinkClient = {
  from: SupabaseClient["from"];
};

/**
 * Finds every `value_set_dependencies` row whose `value_set_name` exactly
 * matches `valueSetName` and whose `value_set_id` is still NULL, and points
 * each at `valueSetId`. Exact, case-sensitive string match on purpose —
 * the same `.eq("value_set_name"/"name", …)` convention this table's other
 * writers already use (`runPairAutoLinkPass` /
 * `useAutoTerminologist.ts`, and the Drug-Allergy seeding pass in
 * `auto-doc.server.ts`), rather than the fuzzy `normalizeNameForMatch`
 * this module uses for the advisory "possible existing match" check — a
 * dependency row names one specific value set a human is expected to
 * author under that exact name, so a loose match here risks silently
 * wiring a rule to the wrong value set.
 *
 * Links regardless of the imported row's `status` ("draft" immediately
 * after any VSAC import, until a human promotes it) — the dependency is
 * real and should stop dangling the moment the value set exists, even
 * though the consumer itself only reads *published* value sets (every
 * consumer resolves its dependencies through `loadPublishedValueSetsForConsumer`
 * above, which already filters out non-published rows). Callers use
 * `formatDependencyLinkedMessages`/`summarizeLinkedDependenciesForToast`
 * below to phrase the human-facing confirmation accordingly.
 *
 * Never throws — a failure here (RLS, network, …) never blocks the import
 * itself; it just means the dependency stays dangling for the next pass to
 * pick up (e.g. `runPairAutoLinkPass`'s existing published-only sweep for
 * Drug-Allergy pairs).
 */
export async function linkPendingDependencies(
  valueSetName: string,
  valueSetId: string,
  client: DependencyLinkClient = supabase,
): Promise<LinkedDependency[]> {
  const name = valueSetName.trim();
  if (!name || !valueSetId) return [];
  try {
    const { data, error } = await client
      .from("value_set_dependencies")
      .select("id, consumer, purpose, lookup_mode")
      .eq("value_set_name", name)
      .is("value_set_id", null);
    if (error || !data || data.length === 0) return [];

    const linked: LinkedDependency[] = [];
    for (const dep of data as unknown as Array<{
      id: string;
      consumer: string;
      purpose: string;
      lookup_mode: string | null;
    }>) {
      const depId = String(dep?.id ?? "");
      if (!depId) continue;
      // Re-assert `value_set_id IS NULL` on the write itself so two imports
      // racing on the same name can't both "win" the same dependency row.
      const { error: updErr } = await client
        .from("value_set_dependencies")
        .update({ value_set_id: valueSetId, updated_at: new Date().toISOString() } as never)
        .eq("id", depId)
        .is("value_set_id", null);
      if (updErr) continue;
      linked.push({
        id: depId,
        consumer: String(dep?.consumer ?? ""),
        purpose: String(dep?.purpose ?? ""),
        lookup_mode: dep?.lookup_mode ?? null,
      });
    }
    return linked;
  } catch (e) {
    console.warn("[value-set-registry] linkPendingDependencies failed", (e as Error)?.message);
    return [];
  }
}

/** Human-readable "<consumer> / <purpose>" label for one linked dependency
 * — e.g. `Safety Alerts Engine / rule3-high-acuity`, or, for a
 * Drug-Allergy pair's two-sided rows, `Safety Alerts Engine · Drug-Allergy
 * / penicillin (allergen)`. */
export function describeLinkedDependency(dep: LinkedDependency): string {
  return dep.lookup_mode
    ? `${dep.consumer} / ${dep.purpose} (${dep.lookup_mode})`
    : `${dep.consumer} / ${dep.purpose}`;
}

/**
 * One human-readable confirmation line per dependency `linkPendingDependencies`
 * just satisfied, for the caller to write to its activity log(s) — one line
 * per row, since a single imported value set can satisfy more than one
 * declared dependency. `isPublished` should reflect the *actual* status of
 * the just-inserted `custom_value_sets` row: every real "Import from VSAC"
 * path inserts it as `"draft"`, so this only ever claims "is now active"
 * once a human has promoted it to published — otherwise it says so plainly
 * instead of overstating what just happened.
 */
export function formatDependencyLinkedMessages(
  valueSetName: string,
  linked: LinkedDependency[],
  isPublished: boolean,
): string[] {
  const activation = isPublished
    ? "is now active"
    : "is now linked — will activate once this value set is published";
  return linked.map(
    (dep) =>
      `"${valueSetName}" imported and linked — ${describeLinkedDependency(dep)} ${activation}.`,
  );
}

/** The short clause an import's success toast appends when it satisfied
 * one or more pending dependencies — empty string when it satisfied none,
 * so callers can just concatenate it onto their existing toast text. */
export function summarizeLinkedDependenciesForToast(
  linked: LinkedDependency[],
  isPublished: boolean,
): string {
  if (linked.length === 0) return "";
  const verb = isPublished ? "now active" : "now linked — activates once published";
  return ` — ${verb}: ${linked.map(describeLinkedDependency).join(", ")}`;
}
