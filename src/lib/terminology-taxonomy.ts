/**
 * Build a hierarchical taxonomy of the active medical terminology over the
 * last 48 h. Used by the System Admin → Medical Dictionary → Catalog tab to
 * render a SNOMED-browser-style tree.
 *
 * Tree shape:
 *   Root (code system) → Category folder → Leaf (code · display)
 */

import type { DictRow } from "@/lib/nlp-engine";

export type TaxonomyLeaf = {
  id: string;
  code: string;
  display: string;
  description: string | null;
  status: string;
  category: string | null;
  recentlyUsed: boolean;
  usageCount: number;
};

export type TaxonomyCategory = {
  name: string;
  leaves: TaxonomyLeaf[];
  recentCount: number;
};

export type TaxonomyRoot = {
  system: string;
  categories: TaxonomyCategory[];
  totalCodes: number;
  recentCount: number;
};

/**
 * @param rows  All `medical_terminology` rows (with status).
 * @param usedCodesBySystem Map of code_system → Set of codes referenced in
 *                          the last 48 h.
 */
export function buildTaxonomy(
  rows: Array<DictRow & { status?: string }>,
  usedCodesBySystem: Record<string, Set<string>>,
  usageCounts: Record<string, number> = {},
  systems: string[] = ["ICD-10", "SNOMED CT", "LOINC", "RxNorm", "VSAC"],
  recentOnly = true,
): TaxonomyRoot[] {
  return systems.map((system) => {
    const used = usedCodesBySystem[system] ?? new Set<string>();
    const pool = rows
      .filter((r) => r.code_system === system)
      .filter((r) => (recentOnly ? used.has(r.code) : true));

    const buckets = new Map<string, TaxonomyLeaf[]>();
    for (const r of pool) {
      const cat = (r.category ?? "Uncategorized").trim() || "Uncategorized";
      const leaf: TaxonomyLeaf = {
        id: r.id,
        code: r.code,
        display: r.display,
        description: r.description ?? null,
        status: r.status ?? "Active",
        category: r.category ?? null,
        recentlyUsed: used.has(r.code),
        usageCount: usageCounts[`${system}|${r.code}`] ?? 0,
      };
      const list = buckets.get(cat) ?? [];
      list.push(leaf);
      buckets.set(cat, list);
    }

    const categories: TaxonomyCategory[] = Array.from(buckets.entries())
      .map(([name, leaves]) => ({
        name,
        leaves: leaves.sort((a, b) => a.code.localeCompare(b.code)),
        recentCount: leaves.filter((l) => l.recentlyUsed).length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const recentCount = categories.reduce((n, c) => n + c.recentCount, 0);
    const totalCodes = pool.length;
    return { system, categories, totalCodes, recentCount };
  });
}
