import { LAB_CATALOG, type LabCatalogEntry } from "@/constants/clinical-catalog";

export interface FallbackLabRow {
  test_type: string;
  status: "Resulted";
  result_value: string;
  unit: string;
  reference_range: string;
}

export function seededHash(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function pickN<T>(arr: readonly T[], n: number, seed: number): T[] {
  const idx = new Set<number>();
  let s = seed || 1;
  while (idx.size < Math.min(n, arr.length)) {
    s = (s * 1664525 + 1013904223) >>> 0;
    idx.add(s % arr.length);
  }
  return [...idx].map((i) => arr[i]);
}

export function mockLabValue(lab: LabCatalogEntry, seed: number): string {
  const rng = lab.referenceRange.trim();
  const r = (seed % 1000) / 1000;
  if (/negative/i.test(rng)) return "Negative";
  const lt = rng.match(/^<\s*([\d.]+)/);
  if (lt) return (r * parseFloat(lt[1])).toFixed(2);
  const range = rng.match(/([\d.]+)\s*[–-]\s*([\d.]+)/);
  if (range) {
    const lo = parseFloat(range[1]);
    const hi = parseFloat(range[2]);
    const decimals = (range[1].split(".")[1]?.length ?? 0) || 1;
    return (lo + r * (hi - lo)).toFixed(decimals);
  }
  return (r * 10).toFixed(1);
}

/**
 * Deterministic per-MRN lab panel. Returns the same 2 tests in the same
 * order every time, matching the patient chart's Recent Labs widget.
 */
export function fallbackLabsFor(mrn: string, count = 2): FallbackLabRow[] {
  const seed = seededHash("lab:" + mrn);
  return pickN(LAB_CATALOG, count, seed).map((l, i) => ({
    test_type: l.name,
    status: "Resulted" as const,
    result_value: `${mockLabValue(l, seed + i * 97)} ${l.unit} (ref ${l.referenceRange})`,
    unit: l.unit,
    reference_range: l.referenceRange,
  }));
}