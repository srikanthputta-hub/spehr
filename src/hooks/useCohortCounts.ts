import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * High-Acuity cohort — count of CURRENTLY ADMITTED patients whose active
 * conditions include at least one SNOMED code from the published
 * `High-Acuity ED Presentations` value set.
 *
 * Sibling cohorts (Diabetic / Respiratory / Cardiac / Sepsis) were removed
 * because their value sets are either not published or their codes are
 * never emitted by the current auto-coding pipeline, making them
 * structurally guaranteed to be zero rather than informative.
 *
 * Value-set codes refresh at most every 5 min; the admitted-patient count
 * refreshes every 60s.
 */

export const HIGH_ACUITY_VS_NAME = "High-Acuity ED Presentations";

const VS_TTL_MS = 5 * 60_000;
let codesCache: string[] | null = null;
let codesLoadedAt = 0;
let codesPromise: Promise<string[]> | null = null;

async function loadHighAcuityCodes(): Promise<string[]> {
  if (codesCache && Date.now() - codesLoadedAt < VS_TTL_MS) return codesCache;
  if (codesPromise) return codesPromise;
  codesPromise = (async () => {
    const { data } = await supabase
      .from("custom_value_sets")
      .select("codes")
      .eq("name", HIGH_ACUITY_VS_NAME)
      .eq("status", "published")
      .maybeSingle();
    const raw = (data?.codes ?? []) as Array<{ code?: string }>;
    const codes = new Set<string>();
    for (const entry of raw) {
      if (entry?.code) codes.add(String(entry.code).trim());
    }
    const out = Array.from(codes).filter(Boolean);
    codesCache = out;
    codesLoadedAt = Date.now();
    return out;
  })().finally(() => {
    codesPromise = null;
  });
  return codesPromise;
}

async function countAdmittedHighAcuity(): Promise<number | null> {
  const codes = await loadHighAcuityCodes();
  if (codes.length === 0) return 0;

  // 1) Currently-admitted MRNs (small set — ~100s).
  const { data: admitted, error: aerr } = await supabase
    .from("patients")
    .select("mrn")
    .eq("status", "Admitted");
  if (aerr) return null;
  const admittedMrns = new Set<string>();
  for (const r of (admitted ?? []) as Array<{ mrn: string | null }>) {
    if (r.mrn) admittedMrns.add(r.mrn);
  }
  if (admittedMrns.size === 0) return 0;

  // 2) Distinct admitted MRNs with an active high-acuity condition.
  const { data: conds, error: cerr } = await supabase
    .from("conditions")
    .select("mrn")
    .in("snomed_code", codes)
    .eq("clinical_status", "active")
    .in("mrn", Array.from(admittedMrns));
  if (cerr) return null;
  const matched = new Set<string>();
  for (const r of (conds ?? []) as Array<{ mrn: string | null }>) {
    if (r.mrn && admittedMrns.has(r.mrn)) matched.add(r.mrn);
  }
  return matched.size;
}

export function useHighAcuityCount(refreshMs = 60_000) {
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const tick = async () => {
      try {
        const v = await countAdmittedHighAcuity();
        if (!mounted.current) return;
        setCount(v);
        setLastRefreshed(new Date());
      } catch {
        /* keep previous */
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

  return { count, loading, lastRefreshed };
}