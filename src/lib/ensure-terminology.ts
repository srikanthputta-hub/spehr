import { supabase } from "@/integrations/supabase/client";
import { DEFAULT_CATEGORY, defaultUsage } from "@/lib/terminology-lookup";

/**
 * Idempotently ensure a clinical concept exists in the medical_terminology
 * dictionary. Called from admission cascades, manual orders, and any other
 * place where a new clinical concept enters the system so the dictionary
 * (System Admin → Medical Dictionary) auto-grows and stays the single
 * source of truth for interoperability exports.
 *
 * Concepts without a known external code are stored with a stable
 * `LOCAL:<slug>` code under the appropriate code system so they appear
 * in the correct designated location (ICD-10 / RxNorm / LOINC / SNOMED CT).
 */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function ensureTerminology(
  system: "ICD-10" | "SNOMED CT" | "LOINC" | "RxNorm" | "VSAC",
  opts: { code?: string; display: string; category?: string; description?: string },
): Promise<void> {
  const display = opts.display?.trim();
  if (!display) return;
  const code = (opts.code && opts.code.trim()) || `LOCAL:${slug(display)}`;
  const category = opts.category?.trim() || DEFAULT_CATEGORY[system] || null;
  const description = opts.description?.trim() || defaultUsage(system, display);
  const { error } = await supabase
    .from("medical_terminology")
    .upsert(
      { code_system: system, code, display, category, description, status: "Active" },
      { onConflict: "code_system,code", ignoreDuplicates: true },
    );
  if (error) {
    console.error("[ensureTerminology] upsert failed for", system, code, error);
  }
}