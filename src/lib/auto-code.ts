/**
 * Auto-code helpers — bolt UMLS coding onto every clinical write.
 *
 * Each function returns immediately (insert resolves first) and then runs
 * the resolver in the background. Failures never block the user write or
 * surface as toasts; everything is logged to `terminology_audit`.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  resolveConcept,
  type Vocabulary,
} from "@/lib/terminology-resolver";

interface AutoCodeContext {
  resourceId: string;
  mrn?: string | null;
  resolver?: string;
}

async function patch(
  table: "lab_orders" | "medication_orders" | "conditions" | "allergies",
  id: string,
  patchData: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from(table).update(patchData).eq("id", id);
  if (error) console.warn(`[auto-code] ${table} update failed`, error.message);
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
export function autoCodeMedication(text: string, ctx: AutoCodeContext): void {
  void (async () => {
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
