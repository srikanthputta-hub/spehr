/**
 * Common lab-name → LOINC pre-map used as fast-path by Stream F.
 * Anything not matched here falls back to a live umls-proxy `loinc` search.
 */
export const LAB_LOINC: Array<{ pattern: RegExp; code: string; display: string }> = [
  { pattern: /troponin\s*i/i,       code: "10839-9", display: "Troponin I cardiac" },
  { pattern: /troponin\s*t/i,       code: "6598-7",  display: "Troponin T cardiac" },
  { pattern: /creatine\s*kinase\b/i,code: "2157-6",  display: "Creatine kinase" },
  { pattern: /ck[- ]?mb/i,          code: "13969-1", display: "CK-MB" },
  { pattern: /\bbnp\b/i,            code: "42637-9", display: "BNP" },
  { pattern: /hemoglobin|hgb\b/i,   code: "718-7",   display: "Hemoglobin" },
  { pattern: /\bwbc\b|white blood/i,code: "6690-2",  display: "WBC count" },
  { pattern: /creatinine/i,         code: "2160-0",  display: "Creatinine" },
  { pattern: /glucose/i,            code: "2345-7",  display: "Glucose" },
  { pattern: /sodium|\bna\b/i,      code: "2951-2",  display: "Sodium" },
  { pattern: /potassium|\bk\b/i,    code: "2823-3",  display: "Potassium" },
  { pattern: /\binr\b/i,            code: "34714-6", display: "INR" },
  { pattern: /d[-\s]?dimer/i,       code: "48066-5", display: "D-dimer" },
  { pattern: /lactate|lactic\s*acid/i, code: "2519-9",  display: "Lactate" },
  { pattern: /lipase/i,             code: "3040-3",  display: "Lipase" },
];

export function lookupLabLoinc(name: string): { code: string; display: string } | null {
  const s = (name ?? "").trim();
  if (!s) return null;
  for (const m of LAB_LOINC) if (m.pattern.test(s)) return { code: m.code, display: m.display };
  return null;
}