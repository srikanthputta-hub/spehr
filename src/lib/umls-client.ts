/**
 * Client-side wrapper around the `umls-proxy` edge function.
 *
 * Every clinical concept (Conditions, Medications, Allergies, Lab units)
 * resolved into FHIR coding[] flows through this module. The edge function
 * already maintains the durable `umls_cache` table (7-day TTL), so repeated
 * calls for the same term return instantly. We add a tiny per-process
 * in-memory memo so a single bundle build never re-invokes the proxy for
 * the same term twice.
 *
 * Hardcoded vocabulary lookups are explicitly forbidden — every code that
 * lands on a FHIR resource MUST come from a live UMLS / RxNav call (which
 * the proxy then caches on first miss).
 */

import { supabase } from "@/integrations/supabase/client";

export type ResolvedCode = { code: string; display: string };

type Action =
  | "icd10"
  | "snomed"
  | "loinc"
  | "rxnorm"
  | "meddra"
  | "crosswalk";

const memo = new Map<string, Promise<ResolvedCode | null>>();

function memoKey(action: Action, params: Record<string, unknown>): string {
  return `${action}:${JSON.stringify(params)}`;
}

async function invokeProxy(
  action: Action,
  params: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke("umls-proxy", {
    body: { action, params },
  });
  if (error) throw error;
  return data;
}

function topUmlsHit(payload: any): ResolvedCode | null {
  const results = payload?.result?.results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const top = results[0];
  if (!top?.ui || top.ui === "NONE") return null;
  return { code: String(top.ui), display: String(top.name ?? top.ui) };
}

function topRxnormHit(payload: any): ResolvedCode | null {
  const ids = payload?.idGroup?.rxnormId;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const rxcui = String(ids[0] ?? "").trim();
  if (!rxcui) return null;
  const name = String(payload?.idGroup?.name ?? "").trim();
  return { code: rxcui, display: name || rxcui };
}

function topMeddraHit(payload: any): ResolvedCode | null {
  // MedDRA search returns the same UTS structure as `search`.
  return topUmlsHit(payload);
}

/** Resolve plain clinical text → ICD-10-CM code (cache-first). */
export function resolveIcd10(text: string): Promise<ResolvedCode | null> {
  const term = (text ?? "").trim();
  if (!term) return Promise.resolve(null);
  const key = memoKey("icd10", { string: term });
  let p = memo.get(key);
  if (!p) {
    p = invokeProxy("icd10", { string: term })
      .then(topUmlsHit)
      .catch((e) => {
        console.warn("[umls] icd10 resolve failed:", term, e);
        return null;
      });
    memo.set(key, p);
  }
  return p;
}

/** Resolve plain clinical text → SNOMED CT code (cache-first). */
export function resolveSnomed(text: string): Promise<ResolvedCode | null> {
  const term = (text ?? "").trim();
  if (!term) return Promise.resolve(null);
  const key = memoKey("snomed", { string: term });
  let p = memo.get(key);
  if (!p) {
    p = invokeProxy("snomed", { string: term })
      .then(topUmlsHit)
      .catch((e) => {
        console.warn("[umls] snomed resolve failed:", term, e);
        return null;
      });
    memo.set(key, p);
  }
  return p;
}

/** Resolve drug name → RxNorm RXCUI via RxNav (cache-first). */
export function resolveRxNorm(drugName: string): Promise<ResolvedCode | null> {
  const name = (drugName ?? "").trim();
  if (!name) return Promise.resolve(null);
  const key = memoKey("rxnorm", { drugName: name });
  let p = memo.get(key);
  if (!p) {
    p = invokeProxy("rxnorm", { drugName: name })
      .then(topRxnormHit)
      .catch((e) => {
        console.warn("[umls] rxnorm resolve failed:", name, e);
        return null;
      });
    memo.set(key, p);
  }
  return p;
}

/** Resolve reaction manifestation → MedDRA Preferred Term (cache-first). */
export function resolveMeddra(text: string): Promise<ResolvedCode | null> {
  const term = (text ?? "").trim();
  if (!term) return Promise.resolve(null);
  const key = memoKey("meddra", { string: term });
  let p = memo.get(key);
  if (!p) {
    p = invokeProxy("meddra", { string: term })
      .then(topMeddraHit)
      .catch((e) => {
        console.warn("[umls] meddra resolve failed:", term, e);
        return null;
      });
    memo.set(key, p);
  }
  return p;
}

/** Resolve test name → LOINC code (cache-first). */
export function resolveLoinc(text: string): Promise<ResolvedCode | null> {
  const term = (text ?? "").trim();
  if (!term) return Promise.resolve(null);
  const key = memoKey("loinc", { string: term });
  let p = memo.get(key);
  if (!p) {
    p = invokeProxy("loinc", { string: term })
      .then(topUmlsHit)
      .catch((e) => {
        console.warn("[umls] loinc resolve failed:", term, e);
        return null;
      });
    memo.set(key, p);
  }
  return p;
}