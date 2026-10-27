/**
 * Centralized UMLS-backed terminology resolver.
 *
 * Single gateway for every coding decision in the app. All calls go through
 * the `umls-proxy` edge function (which handles 7-day persistent caching and
 * rate limits). The resolver layers anti-hallucination gates on top:
 *
 *  1. Input sanity — non-empty, length-bounded text only.
 *  2. Exact vs fuzzy match scoring; weak matches are rejected.
 *  3. UMLS sourceUi / RxCUI must round-trip from a real upstream response.
 *  4. Confidence threshold (default 0.55) — below threshold returns null
 *     and is logged with `action=rejected`.
 *  5. Every attempt — hit, miss, reject — is written to `terminology_audit`
 *     so governance can review NLP behavior.
 */

import { supabase } from "@/integrations/supabase/client";

export type Vocabulary =
  "SNOMEDCT_US" | "ICD10CM" | "ICD10PCS" | "LNC" | "RXNORM" | "CPT" | "MDR" | "CHV";

export interface ResolvedConcept {
  code: string;
  display: string;
  vocabulary: Vocabulary;
  umlsCui: string | null;
  confidence: number;
  source: "umls" | "rxnav";
  cacheHit: boolean;
  elapsedMs: number;
}

export interface ResolveOptions {
  resourceType: string;
  resourceId?: string;
  mrn?: string;
  minConfidence?: number;
  bypassMemo?: boolean;
  resolver?: string;
}

const memo = new Map<string, ResolvedConcept | null>();
const memoKey = (text: string, vocab: Vocabulary) => `${vocab}::${text.trim().toLowerCase()}`;

const DEFAULT_MIN_CONFIDENCE = 0.55;
const MAX_INPUT_LEN = 120;

function isPlausibleInput(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 2 || t.length > MAX_INPUT_LEN) return false;
  if (!/[a-zA-Z]/.test(t)) return false;
  return true;
}

function scoreMatch(input: string, candidate: string): number {
  const a = input.trim().toLowerCase();
  const b = candidate.trim().toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) return 0.85;
  if (b.includes(a) || a.includes(b)) return 0.7;
  const ta = new Set(a.split(/\s+/));
  const tb = new Set(b.split(/\s+/));
  const inter = [...ta].filter((x) => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

interface ProxyEnvelope {
  cached?: boolean;
  elapsed_ms?: number;
  vocabulary?: string;
  result?: { results?: Array<{ ui?: string; name?: string; rootSource?: string }> };
  error?: string;
  [k: string]: unknown;
}

async function callProxy(action: string, params: Record<string, unknown>): Promise<ProxyEnvelope> {
  const { data, error } = await supabase.functions.invoke("umls-proxy", {
    body: { action, params },
  });
  if (error) throw new Error(error.message ?? "umls-proxy invocation failed");
  return (data ?? {}) as ProxyEnvelope;
}

type AuditAction = "accepted" | "rejected" | "miss" | "error";

interface AuditRow {
  resource_type: string;
  resource_id?: string;
  mrn?: string;
  input_text: string;
  vocabulary: Vocabulary;
  resolved_code: string | null;
  resolved_display: string | null;
  umls_cui: string | null;
  confidence: number;
  action: AuditAction;
  cache_hit: boolean;
  elapsed_ms: number;
  resolver: string;
}

function audit(row: AuditRow): void {
  // Fire-and-forget by design (never blocks the coding flow), but a failed
  // write to the governance audit trail must not be totally silent.
  void supabase
    .from("terminology_audit")
    .insert({
      resource_type: row.resource_type,
      resource_id: row.resource_id ?? null,
      mrn: row.mrn ?? null,
      input_text: row.input_text,
      vocabulary: row.vocabulary,
      resolved_code: row.resolved_code,
      resolved_display: row.resolved_display,
      umls_cui: row.umls_cui,
      confidence: row.confidence,
      action: row.action,
      cache_hit: row.cache_hit,
      elapsed_ms: row.elapsed_ms,
      resolver: row.resolver,
    })
    .then(({ error }) => {
      if (error) {
        console.error("[terminology-resolver] audit write failed", error, row);
      }
    });
}

export async function resolveConcept(
  text: string,
  vocabulary: Vocabulary,
  opts: ResolveOptions,
): Promise<ResolvedConcept | null> {
  const resolver = opts.resolver ?? "client";
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  if (!isPlausibleInput(text)) {
    audit({
      resource_type: opts.resourceType,
      resource_id: opts.resourceId,
      mrn: opts.mrn,
      input_text: text ?? "",
      vocabulary,
      resolved_code: null,
      resolved_display: null,
      umls_cui: null,
      confidence: 0,
      action: "rejected",
      cache_hit: false,
      elapsed_ms: 0,
      resolver,
    });
    return null;
  }

  const key = memoKey(text, vocabulary);
  if (!opts.bypassMemo && memo.has(key)) {
    return memo.get(key) ?? null;
  }

  try {
    if (vocabulary === "RXNORM") {
      const env = await callProxy("rxnorm", { drugName: text.trim() });
      const rxcui: string | undefined = (env as { idGroup?: { rxnormId?: string[] } })?.idGroup
        ?.rxnormId?.[0];
      const elapsed = env.elapsed_ms ?? 0;
      const cacheHit = !!env.cached;

      if (!rxcui) {
        audit({
          resource_type: opts.resourceType,
          resource_id: opts.resourceId,
          mrn: opts.mrn,
          input_text: text,
          vocabulary,
          resolved_code: null,
          resolved_display: null,
          umls_cui: null,
          confidence: 0,
          action: "miss",
          cache_hit: cacheHit,
          elapsed_ms: elapsed,
          resolver,
        });
        memo.set(key, null);
        return null;
      }

      const detail = await callProxy("rxnormDetail", { rxcui });
      const props = (detail as { properties?: { name?: string; tty?: string } }).properties ?? {};
      const display: string = props.name ?? text;
      const confidence = scoreMatch(text, display);

      if (confidence < minConfidence) {
        audit({
          resource_type: opts.resourceType,
          resource_id: opts.resourceId,
          mrn: opts.mrn,
          input_text: text,
          vocabulary,
          resolved_code: rxcui,
          resolved_display: display,
          umls_cui: null,
          confidence,
          action: "rejected",
          cache_hit: cacheHit,
          elapsed_ms: elapsed,
          resolver,
        });
        memo.set(key, null);
        return null;
      }

      const concept: ResolvedConcept = {
        code: rxcui,
        display,
        vocabulary,
        umlsCui: null,
        confidence,
        source: "rxnav",
        cacheHit,
        elapsedMs: elapsed,
      };
      audit({
        resource_type: opts.resourceType,
        resource_id: opts.resourceId,
        mrn: opts.mrn,
        input_text: text,
        vocabulary,
        resolved_code: rxcui,
        resolved_display: display,
        umls_cui: null,
        confidence,
        action: "accepted",
        cache_hit: cacheHit,
        elapsed_ms: elapsed,
        resolver,
      });
      memo.set(key, concept);
      return concept;
    }

    if (vocabulary === "ICD10CM") {
      const env = await callProxy("icd10Resolve", { string: text.trim() });
      const elapsed = env.elapsed_ms ?? 0;
      const cacheHit = !!env.cached;
      const candidates = env.result?.results ?? [];
      const valid = candidates.filter(
        (r) => r.ui && r.ui !== "NONE" && r.name && r.name !== "NO RESULTS",
      );

      if (valid.length === 0) {
        audit({
          resource_type: opts.resourceType,
          resource_id: opts.resourceId,
          mrn: opts.mrn,
          input_text: text,
          vocabulary,
          resolved_code: null,
          resolved_display: null,
          umls_cui: null,
          confidence: 0,
          action: "miss",
          cache_hit: cacheHit,
          elapsed_ms: elapsed,
          resolver,
        });
        memo.set(key, null);
        return null;
      }

      const scored = valid
        .map((r) => ({ r, s: scoreMatch(text, r.name ?? "") }))
        .sort((a, b) => b.s - a.s);
      const best = scored[0];
      const confidence = best.s;

      if (confidence < minConfidence) {
        audit({
          resource_type: opts.resourceType,
          resource_id: opts.resourceId,
          mrn: opts.mrn,
          input_text: text,
          vocabulary,
          resolved_code: best.r.ui ?? null,
          resolved_display: best.r.name ?? null,
          umls_cui: null,
          confidence,
          action: "rejected",
          cache_hit: cacheHit,
          elapsed_ms: elapsed,
          resolver,
        });
        memo.set(key, null);
        return null;
      }

      const concept: ResolvedConcept = {
        code: best.r.ui as string,
        display: best.r.name as string,
        vocabulary,
        umlsCui: null,
        confidence,
        source: "umls",
        cacheHit,
        elapsedMs: elapsed,
      };
      audit({
        resource_type: opts.resourceType,
        resource_id: opts.resourceId,
        mrn: opts.mrn,
        input_text: text,
        vocabulary,
        resolved_code: concept.code,
        resolved_display: concept.display,
        umls_cui: null,
        confidence,
        action: "accepted",
        cache_hit: cacheHit,
        elapsed_ms: elapsed,
        resolver,
      });
      memo.set(key, concept);
      return concept;
    }

    const env = await callProxy("search", {
      string: text.trim(),
      sabs: vocabulary,
      returnIdType: vocabulary === "LNC" ? "code" : "sourceUi",
      searchType: "words",
      pageSize: 5,
    });
    const elapsed = env.elapsed_ms ?? 0;
    const cacheHit = !!env.cached;
    const candidates = env.result?.results ?? [];
    const valid = candidates.filter(
      (r) => r.ui && r.ui !== "NONE" && r.name && r.name !== "NO RESULTS",
    );

    if (valid.length === 0) {
      audit({
        resource_type: opts.resourceType,
        resource_id: opts.resourceId,
        mrn: opts.mrn,
        input_text: text,
        vocabulary,
        resolved_code: null,
        resolved_display: null,
        umls_cui: null,
        confidence: 0,
        action: "miss",
        cache_hit: cacheHit,
        elapsed_ms: elapsed,
        resolver,
      });
      memo.set(key, null);
      return null;
    }

    const scored = valid
      .map((r) => ({ r, s: scoreMatch(text, r.name ?? "") }))
      .sort((a, b) => b.s - a.s);
    const best = scored[0];
    const confidence = best.s;

    if (confidence < minConfidence) {
      audit({
        resource_type: opts.resourceType,
        resource_id: opts.resourceId,
        mrn: opts.mrn,
        input_text: text,
        vocabulary,
        resolved_code: best.r.ui ?? null,
        resolved_display: best.r.name ?? null,
        umls_cui: null,
        confidence,
        action: "rejected",
        cache_hit: cacheHit,
        elapsed_ms: elapsed,
        resolver,
      });
      memo.set(key, null);
      return null;
    }

    const concept: ResolvedConcept = {
      code: best.r.ui as string,
      display: best.r.name as string,
      vocabulary,
      umlsCui: null,
      confidence,
      source: "umls",
      cacheHit,
      elapsedMs: elapsed,
    };
    audit({
      resource_type: opts.resourceType,
      resource_id: opts.resourceId,
      mrn: opts.mrn,
      input_text: text,
      vocabulary,
      resolved_code: concept.code,
      resolved_display: concept.display,
      umls_cui: null,
      confidence,
      action: "accepted",
      cache_hit: cacheHit,
      elapsed_ms: elapsed,
      resolver,
    });
    memo.set(key, concept);
    return concept;
  } catch (err) {
    audit({
      resource_type: opts.resourceType,
      resource_id: opts.resourceId,
      mrn: opts.mrn,
      input_text: text,
      vocabulary,
      resolved_code: null,
      resolved_display: null,
      umls_cui: null,
      confidence: 0,
      action: "error",
      cache_hit: false,
      elapsed_ms: 0,
      resolver,
    });
    console.warn("[terminology-resolver] failed", err);
    return null;
  }
}

export async function resolveBatch(
  inputs: Array<{ text: string; vocabulary: Vocabulary }>,
  opts: ResolveOptions,
  concurrency = 3,
): Promise<Array<ResolvedConcept | null>> {
  const out: Array<ResolvedConcept | null> = new Array(inputs.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < inputs.length) {
      const i = idx++;
      const item = inputs[i];
      out[i] = await resolveConcept(item.text, item.vocabulary, opts);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}

export async function enrichWithCui(concept: ResolvedConcept): Promise<ResolvedConcept> {
  if (concept.umlsCui || concept.source !== "umls") return concept;
  try {
    const env = await callProxy("search", {
      string: concept.display,
      sabs: concept.vocabulary,
      returnIdType: "concept",
      searchType: "exact",
      pageSize: 1,
    });
    const cui = env.result?.results?.[0]?.ui ?? null;
    return cui ? { ...concept, umlsCui: cui } : concept;
  } catch {
    return concept;
  }
}

export function clearResolverMemo(): void {
  memo.clear();
}
