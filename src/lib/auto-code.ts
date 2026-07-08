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
import { runMedicationOrderRules } from "@/lib/safety-alerts-engine";

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
    for (const row of (sets ?? []) as any[]) {
      const codes = Array.isArray(row?.codes) ? row.codes : [];
      if (codes.some((c: any) => String(c?.code ?? "").trim() === code)) return;
    }
    const { data: existing } = await supabase
      .from("terminology_requests" as any)
      .select("id")
      .eq("requested_name", name)
      .in("status", ["pending", "drafted"])
      .limit(1);
    if (existing && (existing as any[]).length > 0) return;
    await supabase.from("terminology_requests" as any).insert({
      requesting_consumer: "Auto Doc",
      requested_name: name,
      justification: `Coding-compliance check found no governed value set covering ${vocabulary} code ${code} (${name}) assigned during note finalization for MRN ${mrn ?? "unknown"}`,
      vocabulary,
      seed_codes: [{ code, display: name, vocabulary }],
      clinical_application: "CDS",
      related_mrn: mrn ?? null,
      priority: "normal",
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
