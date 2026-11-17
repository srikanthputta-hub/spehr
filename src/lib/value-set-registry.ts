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
 */
import { supabase } from "@/integrations/supabase/client";
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
