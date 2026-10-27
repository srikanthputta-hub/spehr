/**
 * Thin wrapper around the `umls-proxy` edge function `search` action.
 * Used by the admission-form type-ahead comboboxes. Never calls
 * fhir-terminology — every terminology lookup goes through umls-proxy.
 */

import { supabase } from "@/integrations/supabase/client";

export type TerminologySab = "SNOMEDCT_US" | "RXNORM" | "LNC" | "ICD10CM";

export interface TerminologyHit {
  code: string;
  display: string;
  system: string;
}

const SYSTEM_BY_SAB: Record<TerminologySab, string> = {
  SNOMEDCT_US: "SNOMED CT",
  RXNORM: "RxNorm",
  LNC: "LOINC",
  ICD10CM: "ICD-10-CM",
};

export interface SearchTerminologyOpts {
  query: string;
  sabs: TerminologySab;
  pageSize?: number;
}

export async function searchTerminology(opts: SearchTerminologyOpts): Promise<TerminologyHit[]> {
  const term = opts.query.trim();
  if (term.length < 2) return [];
  const { data, error } = await supabase.functions.invoke<{
    result?: { results?: Array<{ ui?: string; name?: string }> };
  }>("umls-proxy", {
    body: {
      action: "search",
      params: {
        string: term,
        sabs: opts.sabs,
        returnIdType: "code",
        pageSize: opts.pageSize ?? 10,
      },
    },
  });
  if (error) throw error;
  const results = data?.result?.results;
  if (!Array.isArray(results)) return [];
  const system = SYSTEM_BY_SAB[opts.sabs];
  const out: TerminologyHit[] = [];
  for (const r of results) {
    const code = String(r?.ui ?? "").trim();
    const display = String(r?.name ?? "").trim();
    if (!code || code === "NONE" || !display) continue;
    out.push({ code, display, system });
  }
  return out;
}
