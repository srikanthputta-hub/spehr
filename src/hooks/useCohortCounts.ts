import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Cohort counts driven by the published value sets in `custom_value_sets`.
 *
 * Refreshes value-set code lists at most every 5 minutes; refreshes cohort
 * counts every 60 seconds. Fails-open: an errored cohort surfaces as `null`
 * in `counts` and the strip renders "—" for that tile.
 */

export const COHORTS = [
  { key: "diabetic",     label: "Diabetic",     vsName: "Diabetes Mellitus",            fallbackRoot: "73211009" },
  { key: "respiratory",  label: "Respiratory",  vsName: "Respiratory Conditions",       fallbackRoot: "50043002" },
  { key: "cardiac",      label: "Cardiac",      vsName: "Cardiac Conditions",           fallbackRoot: "56265001" },
  { key: "sepsis",       label: "Sepsis",       vsName: "Sepsis Indicators",            fallbackRoot: null },
  { key: "highAcuity",   label: "High-Acuity",  vsName: "High-Acuity ED Presentations", fallbackRoot: null },
] as const;

export type CohortKey = (typeof COHORTS)[number]["key"];

type VsRow = {
  name: string;
  type: string;
  codes: Array<{ code?: string }> | null;
  intensional_rule: { root_concept?: string; ecl?: string } | null;
};

const VS_TTL_MS = 5 * 60_000;
let vsCache: Map<CohortKey, string[]> | null = null;
let vsLoadedAt = 0;
let vsLoadPromise: Promise<Map<CohortKey, string[]>> | null = null;

async function loadValueSets(): Promise<Map<CohortKey, string[]>> {
  if (vsCache && Date.now() - vsLoadedAt < VS_TTL_MS) return vsCache;
  if (vsLoadPromise) return vsLoadPromise;
  vsLoadPromise = (async () => {
    const names = COHORTS.map((c) => c.vsName);
    const { data } = await supabase
      .from("custom_value_sets")
      .select("name, type, codes, intensional_rule")
      .in("name", names)
      .eq("status", "published");
    const byName = new Map<string, VsRow>();
    for (const row of (data ?? []) as VsRow[]) byName.set(row.name, row);
    const next = new Map<CohortKey, string[]>();
    for (const c of COHORTS) {
      const row = byName.get(c.vsName);
      const codes = new Set<string>();
      if (row?.codes && Array.isArray(row.codes)) {
        for (const entry of row.codes) {
          if (entry?.code) codes.add(String(entry.code).trim());
        }
      }
      const root = row?.intensional_rule?.root_concept ?? c.fallbackRoot ?? null;
      if (root) codes.add(String(root).trim());
      next.set(c.key, Array.from(codes).filter(Boolean));
    }
    vsCache = next;
    vsLoadedAt = Date.now();
    return next;
  })().finally(() => {
    vsLoadPromise = null;
  });
  return vsLoadPromise;
}

async function countCohort(codes: string[]): Promise<number | null> {
  if (codes.length === 0) return 0;
  const mrns = new Set<string>();
  try {
    const { data, error } = await supabase
      .from("conditions")
      .select("mrn")
      .in("snomed_code", codes)
      .eq("clinical_status", "active");
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ mrn: string | null }>) {
      if (r.mrn) mrns.add(r.mrn);
    }
  } catch {
    // Fall through — try NLP-approved layer even if conditions failed.
  }
  try {
    // nlp_audit_logs.standardized_output is jsonb of the shape
    // { "SNOMED CT": ["code", ...], ... }. Fetch approved rows in one shot
    // and filter client-side; row volume is bounded.
    const { data, error } = await supabase
      .from("nlp_audit_logs")
      .select("patient_mrn, standardized_output")
      .eq("status", "approved")
      .not("patient_mrn", "is", null)
      .limit(2000);
    if (error) throw error;
    const codeSet = new Set(codes);
    for (const r of (data ?? []) as Array<{ patient_mrn: string | null; standardized_output: any }>) {
      if (!r.patient_mrn) continue;
      const so = r.standardized_output ?? {};
      const arr = (Array.isArray(so["SNOMED CT"]) ? so["SNOMED CT"] : Array.isArray(so.snomed) ? so.snomed : []) as unknown[];
      for (const c of arr) {
        if (typeof c === "string" && codeSet.has(c)) {
          mrns.add(r.patient_mrn);
          break;
        }
      }
    }
  } catch {
    /* ignore secondary source */
  }
  return mrns.size;
}

export type CohortCounts = Record<CohortKey, number | null>;

const EMPTY: CohortCounts = COHORTS.reduce((acc, c) => {
  acc[c.key] = null;
  return acc;
}, {} as CohortCounts);

export function useCohortCounts(refreshMs = 60_000) {
  const [counts, setCounts] = useState<CohortCounts>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const tick = async () => {
      try {
        const vs = await loadValueSets();
        const results = await Promise.all(
          COHORTS.map(async (c) => {
            const codes = vs.get(c.key) ?? [];
            try {
              return [c.key, await countCohort(codes)] as const;
            } catch {
              return [c.key, null] as const;
            }
          }),
        );
        if (!mounted.current) return;
        const next = { ...EMPTY } as CohortCounts;
        for (const [k, v] of results) next[k] = v;
        setCounts(next);
        setLastRefreshed(new Date());
      } catch {
        /* keep previous counts */
      } finally {
        if (mounted.current) setLoading(false);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), refreshMs);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [refreshMs]);

  return { counts, loading, lastRefreshed };
}