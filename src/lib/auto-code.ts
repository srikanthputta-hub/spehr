/**
 * Auto-code helpers — bolt UMLS coding onto every clinical write.
 *
 * Each function returns immediately (insert resolves first) and then runs
 * the resolver in the background. Failures never block the user write or
 * surface as toasts; everything is logged to `terminology_audit`.
 */

import { supabase } from "@/integrations/supabase/client";
import { resolveConcept, type Vocabulary } from "@/lib/terminology-resolver";
import { runMedicationOrderRules } from "@/lib/safety-alerts-engine";
import { recommendDefinitionType, suggestedRootConceptForStorage } from "@/lib/value-set-registry";
import type { Database } from "@/integrations/supabase/types";

interface AutoCodeContext {
  resourceId: string;
  mrn?: string | null;
  resolver?: string;
}

type PatchableTable = "lab_orders" | "medication_orders" | "conditions" | "allergies";

// Overloads give every call site a fully-typed `patchData` for its literal
// table. The implementation below stays generic across all four tables,
// which the Supabase-generated query builder's overloads can't express
// without a cast — see the disable comment there.
async function patch(
  table: "lab_orders",
  id: string,
  patchData: Database["public"]["Tables"]["lab_orders"]["Update"],
): Promise<void>;
async function patch(
  table: "medication_orders",
  id: string,
  patchData: Database["public"]["Tables"]["medication_orders"]["Update"],
): Promise<void>;
async function patch(
  table: "conditions",
  id: string,
  patchData: Database["public"]["Tables"]["conditions"]["Update"],
): Promise<void>;
async function patch(
  table: "allergies",
  id: string,
  patchData: Database["public"]["Tables"]["allergies"]["Update"],
): Promise<void>;
async function patch(
  table: PatchableTable,
  id: string,
  patchData: Record<string, unknown>,
): Promise<void> {
  // The overloads above are what every caller sees; this implementation
  // needs one escape hatch because `table` is widened back to the union
  // and Supabase's generated builder can't resolve .update()'s parameter
  // type from a non-literal table name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from(table) as any).update(patchData).eq("id", id);
  if (error) console.warn(`[auto-code] ${table} update failed`, error.message);
}

/**
 * Coding-compliance requester (Auto Doc → Auto Terminologist).
 *
 * After a diagnosis code is assigned to a note, check whether any published
 * value set already covers it. If not, submit a `terminology_requests` row
 * so the Auto Terminologist can draft coverage on its next cycle. Deduped
 * by requested_name so we don't flood the queue.
 */
async function requestCoverageIfMissing(args: {
  vocabulary: "SNOMED CT" | "ICD-10";
  code: string;
  display: string;
  mrn?: string | null;
}): Promise<void> {
  const { vocabulary, code, display, mrn } = args;
  const name = (display ?? "").trim();
  if (!code || !name || !vocabulary) return;
  try {
    const { data: sets } = await supabase
      .from("custom_value_sets")
      .select("codes")
      .eq("status", "published");
    for (const row of sets ?? []) {
      const codes = Array.isArray(row?.codes) ? row.codes : [];
      const hasCode = codes.some(
        (c) =>
          c && typeof c === "object" && !Array.isArray(c) && String(c.code ?? "").trim() === code,
      );
      if (hasCode) return;
    }
    const { data: existing } = await supabase
      .from("terminology_requests")
      .select("id")
      .eq("requested_name", name)
      .in("status", ["pending", "drafted"])
      .limit(1);
    if (existing && existing.length > 0) return;
    const justification = `Coding-compliance check found no governed value set covering ${vocabulary} code ${code} (${name}) assigned during note finalization for MRN ${mrn ?? "unknown"}`;
    const recommendation = await recommendDefinitionType({
      vocabulary,
      candidates: [{ code, display: name, vocabulary }],
      requestedName: name,
      justification,
      context: { clinicalApplication: "CDS", requestingConsumer: "Auto Doc" },
    });
    await supabase.from("terminology_requests").insert({
      requesting_consumer: "Auto Doc",
      requested_name: name,
      justification,
      vocabulary,
      seed_codes: [{ code, display: name, vocabulary }],
      clinical_application: "CDS",
      related_mrn: mrn ?? null,
      priority: "normal",
      request_type: "create",
      requested_at: new Date().toISOString(),
      status: "pending",
      recommended_type: recommendation.recommendedType,
      reasoning: recommendation.reasoning,
      suggested_root_concept: suggestedRootConceptForStorage(recommendation),
      recommended_binding_strength: recommendation.recommendedBindingStrength,
      possible_existing_match: recommendation.possibleExistingMatch,
      clinical_focus: recommendation.clinicalFocus,
      data_element_scope: recommendation.dataElementScope,
      inclusion_criteria: recommendation.inclusionCriteria,
      exclusion_criteria: recommendation.exclusionCriteria,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  } catch (e) {
    console.warn("[auto-code] coverage-request failed", e);
  }
}

/** Resolve a lab test name → LOINC code, write back to lab_orders.id. */
export function autoCodeLab(text: string, ctx: AutoCodeContext): void {
  void (async () => {
    const c = await resolveConcept(text, "LNC", {
      resourceType: "lab_orders",
      resourceId: ctx.resourceId,
      mrn: ctx.mrn ?? undefined,
      resolver: ctx.resolver ?? "lab-order-coder",
    });
    if (!c) return;
    await patch("lab_orders", ctx.resourceId, {
      loinc_code: c.code,
      loinc_display: c.display,
      umls_cui: c.umlsCui,
      coding_source: c.source,
      coded_at: new Date().toISOString(),
    });
  })();
}

/** Resolve a drug name → RxNorm RxCUI, write back to medication_orders.id. */
export function autoCodeMedication(text: string, ctx: AutoCodeContext): Promise<void> {
  return (async () => {
    const c = await resolveConcept(text, "RXNORM", {
      resourceType: "medication_orders",
      resourceId: ctx.resourceId,
      mrn: ctx.mrn ?? undefined,
      resolver: ctx.resolver ?? "med-order-coder",
    });
    if (!c) return;
    await patch("medication_orders", ctx.resourceId, {
      rxnorm_code: c.code,
      rxnorm_display: c.display,
      ingredient_rxcui: c.code,
      umls_cui: c.umlsCui,
      coding_source: c.source,
      coded_at: new Date().toISOString(),
    });
    // Safety-critical: re-run the drug-allergy/interaction check now that this
    // order has a resolved RxNorm code. The realtime INSERT watcher fires at
    // row-creation time, before this code exists, so without this call the
    // check never re-fires once the code is actually available.
    try {
      await runMedicationOrderRules({
        mrn: ctx.mrn ?? "",
        rxnorm_code: c.code,
        rxnorm_display: c.display,
        medication_name: text,
        medication_order_id: ctx.resourceId,
      });
    } catch (e) {
      console.warn("[auto-code] post-coding safety check failed", e);
    }
  })();
}

/** Resolve a diagnosis → SNOMED + ICD-10, write back to conditions.id. */
export function autoCodeCondition(text: string, ctx: AutoCodeContext): void {
  void (async () => {
    const [snomed, icd10] = await Promise.all([
      resolveConcept(text, "SNOMEDCT_US", {
        resourceType: "conditions",
        resourceId: ctx.resourceId,
        mrn: ctx.mrn ?? undefined,
        resolver: ctx.resolver ?? "condition-coder",
      }),
      resolveConcept(text, "ICD10CM", {
        resourceType: "conditions",
        resourceId: ctx.resourceId,
        mrn: ctx.mrn ?? undefined,
        resolver: ctx.resolver ?? "condition-coder",
      }),
    ]);
    const patchData: Record<string, unknown> = {
      coded_at: new Date().toISOString(),
      coding_source: snomed?.source ?? icd10?.source ?? "umls",
    };
    if (snomed) {
      patchData.snomed_code = snomed.code;
      patchData.snomed_display = snomed.display;
      patchData.umls_cui = snomed.umlsCui;
    }
    if (icd10) {
      patchData.icd10_code = icd10.code;
      patchData.icd10_display = icd10.display;
    }
    if (snomed || icd10) await patch("conditions", ctx.resourceId, patchData);
    if (snomed?.code) {
      await requestCoverageIfMissing({
        vocabulary: "SNOMED CT",
        code: snomed.code,
        display: snomed.display ?? text,
        mrn: ctx.mrn ?? null,
      });
    }
    if (icd10?.code) {
      await requestCoverageIfMissing({
        vocabulary: "ICD-10",
        code: icd10.code,
        display: icd10.display ?? text,
        mrn: ctx.mrn ?? null,
      });
    }
  })();
}

/** Resolve an allergy substance → RxNorm (drug) or SNOMED (env), write back. */
export function autoCodeAllergy(
  substance: string,
  ctx: AutoCodeContext,
  hint: "drug" | "environment" | "unknown" = "unknown",
): void {
  void (async () => {
    const vocab: Vocabulary = hint === "drug" ? "RXNORM" : "SNOMEDCT_US";
    const c = await resolveConcept(substance, vocab, {
      resourceType: "allergies",
      resourceId: ctx.resourceId,
      mrn: ctx.mrn ?? undefined,
      resolver: ctx.resolver ?? "allergy-coder",
    });
    if (!c) return;
    const patchData: Record<string, unknown> = {
      coded_at: new Date().toISOString(),
      coding_source: c.source,
      substance_umls_cui: c.umlsCui,
    };
    if (vocab === "RXNORM") patchData.substance_rxcui = c.code;
    else patchData.substance_snomed = c.code;
    await patch("allergies", ctx.resourceId, patchData);
  })();
}
