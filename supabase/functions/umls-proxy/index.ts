// UMLS proxy edge function — v2
// Single gateway for all terminology calls.
// Reads UMLS_API_KEY from env; caches responses in public.umls_cache for 7 days.
//
// Changes from v1:
//   P1-A: Added "resolveAndValidate" action — resolves raw clinical text to a
//         SNOMED code via UMLS search, then validates it. Fixes Auto Terminologist
//         confidence collapse (was 0.40–0.48 because "chest pain" was passed as
//         a sourceUi code to an exact-match search that always returned null).
//   P1-B: Added "subsumes" action — checks SNOMED subsumption between two codes
//         by traversing UMLS source ancestors. Enables $subsumes in the workbench.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const UMLS_API_KEY = Deno.env.get("UMLS_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UTS = "https://uts-ws.nlm.nih.gov/rest";
const RXNAV = "https://rxnav.nlm.nih.gov/REST";

// ─── Existing helper: crosswalk CUI fallback ─────────────────────────────────

async function crosswalkCuiFallback(
  p: Record<string, unknown>,
): Promise<{ matches: Array<{ code: string; name: string; rootSource: string }> }> {
  try {
    const fromSab = String(p.fromSab ?? p.sourceSab ?? "");
    const fromCode = String(p.fromCode ?? p.code ?? "");
    const toSab = String(p.toSab ?? p.targetSab ?? "");
    if (!fromSab || !fromCode || !toSab) return { matches: [] };
    const srcUrl = `${UTS}/content/current/source/${encodeURIComponent(fromSab)}/${encodeURIComponent(fromCode)}?apiKey=${UMLS_API_KEY}`;
    const srcRes = await fetch(srcUrl, { headers: { Accept: "application/json" } });
    if (!srcRes.ok) return { matches: [] };
    const srcJson = await srcRes.json();
    const conceptUrl: string | undefined = srcJson?.result?.concept;
    if (!conceptUrl) return { matches: [] };
    const cuiMatch = conceptUrl.match(/CUI\/([A-Z0-9]+)/i);
    const cui = cuiMatch?.[1];
    if (!cui) return { matches: [] };
    const atomsUrl = `${UTS}/content/current/CUI/${encodeURIComponent(cui)}/atoms?sabs=${encodeURIComponent(toSab)}&apiKey=${UMLS_API_KEY}`;
    const atomsRes = await fetch(atomsUrl, { headers: { Accept: "application/json" } });
    if (!atomsRes.ok) return { matches: [] };
    const atomsJson = await atomsRes.json();
    const arr = Array.isArray(atomsJson?.result) ? atomsJson.result : [];
    const seen = new Set<string>();
    const matches: Array<{ code: string; name: string; rootSource: string }> = [];
    for (const a of arr) {
      const code: string | undefined = a?.code ? String(a.code).split("/").pop() : undefined;
      if (!code || code === "NONE" || seen.has(code)) continue;
      seen.add(code);
      matches.push({ code, name: String(a.name ?? ""), rootSource: String(a.rootSource ?? toSab) });
      if (matches.length >= 10) break;
    }
    return { matches };
  } catch (e) {
    console.log("[umls-proxy] crosswalk fallback error:", (e as Error).message);
    return { matches: [] };
  }
}

// ─── P1-A: Resolve text → SNOMED code, validate, return confidence ───────────

async function resolveAndValidate(p: Record<string, unknown>): Promise<{
  resolvedCode: string | null;
  resolvedName: string | null;
  confidence: number;
  valid: boolean;
  statusRouting: "review" | "draft" | "held";
  elapsed_ms: number;
}> {
  const started = Date.now();
  const input = String(p.string ?? p.code ?? "").trim();
  const sab = String(p.sab ?? "SNOMEDCT_US");

  if (!input) {
    return { resolvedCode: null, resolvedName: null, confidence: 0, valid: false, statusRouting: "held", elapsed_ms: 0 };
  }

  const isCodeLike = /^\d{6,18}$/.test(input);

  if (isCodeLike) {
    const url = `${UTS}/search/current?string=${encodeURIComponent(input)}&sabs=${encodeURIComponent(sab)}&inputType=sourceUi&searchType=exact&returnIdType=sourceUi&pageSize=1&apiKey=${UMLS_API_KEY}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const elapsed_ms = Date.now() - started;
    if (!res.ok) {
      return { resolvedCode: input, resolvedName: null, confidence: 0.35, valid: false, statusRouting: "held", elapsed_ms };
    }
    const json = await res.json();
    const results = Array.isArray(json?.result?.results) ? json.result.results : [];
    const top = results.find((r: any) => r?.ui && r.ui !== "NONE");
    if (top) {
      return { resolvedCode: top.ui, resolvedName: top.name, confidence: 0.95, valid: true, statusRouting: "review", elapsed_ms };
    }
    return { resolvedCode: input, resolvedName: null, confidence: 0.30, valid: false, statusRouting: "held", elapsed_ms };
  }

  const searchUrl = `${UTS}/search/current?string=${encodeURIComponent(input)}&returnIdType=concept&searchType=words&pageSize=5&apiKey=${UMLS_API_KEY}`;
  const res = await fetch(searchUrl, { headers: { Accept: "application/json" } });
  const elapsed_ms = Date.now() - started;

  if (!res.ok) {
    return { resolvedCode: null, resolvedName: null, confidence: 0.20, valid: false, statusRouting: "held", elapsed_ms };
  }

  const json = await res.json();
  const results = Array.isArray(json?.result?.results) ? json.result.results : [];
  const top = results.find((r: any) => r?.ui && r.ui !== "NONE");

  if (!top) {
    return { resolvedCode: null, resolvedName: null, confidence: 0.25, valid: false, statusRouting: "held", elapsed_ms };
  }

  const cui = String(top.ui);
  const cuiDisplayName = String(top.name ?? "");

  let resolvedSourceCode: string | null = null;
  let resolvedSourceName: string = cuiDisplayName;
  try {
    const atomsUrl = `${UTS}/content/current/CUI/${encodeURIComponent(cui)}/atoms?sabs=${encodeURIComponent(sab)}&apiKey=${UMLS_API_KEY}`;
    const atomsRes = await fetch(atomsUrl, { headers: { Accept: "application/json" } });
    if (atomsRes.ok) {
      const atomsJson = await atomsRes.json();
      const atoms = Array.isArray(atomsJson?.result) ? atomsJson.result : [];
      for (const a of atoms) {
        const rawCode: string = String(a?.code ?? "");
        const code = rawCode.includes("/") ? rawCode.split("/").pop()! : rawCode;
        if (!code || code === "NONE") continue;
        resolvedSourceCode = code;
        resolvedSourceName = String(a.name ?? cuiDisplayName);
        break;
      }
    }
  } catch (e) {
    console.log("[umls-proxy] atoms lookup error for CUI", cui, (e as Error).message);
  }

  if (!resolvedSourceCode) {
    return { resolvedCode: null, resolvedName: cuiDisplayName, confidence: 0.30, valid: false, statusRouting: "held", elapsed_ms };
  }

  const resolvedName = resolvedSourceName.toLowerCase().trim();
  const inputLower = input.toLowerCase().trim();

  let confidence: number;
  if (resolvedName === inputLower) {
    confidence = 0.93;
  } else if (resolvedName.includes(inputLower) || inputLower.includes(resolvedName)) {
    confidence = 0.85;
  } else {
    const inputWords = new Set(inputLower.split(/\s+/).filter(Boolean));
    const nameWords = new Set(resolvedName.split(/\s+/).filter(Boolean));
    const overlap = [...inputWords].filter(w => nameWords.has(w)).length;
    const maxWords = Math.max(inputWords.size, nameWords.size, 1);
    const ratio = overlap / maxWords;
    confidence = 0.50 + Math.min(ratio, 1) * 0.28;
  }

  const statusRouting: "review" | "draft" | "held" =
    confidence >= 0.80 ? "review" : confidence >= 0.50 ? "draft" : "held";

  return { resolvedCode: resolvedSourceCode, resolvedName: resolvedSourceName, confidence, valid: true, statusRouting, elapsed_ms };
}

// ─── P1-B: Subsumption check via UMLS source ancestors ───────────────────────

async function checkSubsumes(p: Record<string, unknown>): Promise<{
  outcome: "equivalent" | "subsumes" | "subsumed-by" | "not-subsumed";
  codeA: string;
  codeB: string;
  elapsed_ms: number;
}> {
  const started = Date.now();
  const sab = String(p.sab ?? "SNOMEDCT_US");
  const codeA = String(p.codeA ?? "");
  const codeB = String(p.codeB ?? "");

  if (!codeA || !codeB) {
    return { outcome: "not-subsumed", codeA, codeB, elapsed_ms: 0 };
  }
  if (codeA === codeB) {
    return { outcome: "equivalent", codeA, codeB, elapsed_ms: Date.now() - started };
  }

  const getAncestorCodes = async (code: string): Promise<Set<string>> => {
    const codes = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const url = `${UTS}/content/current/source/${encodeURIComponent(sab)}/${encodeURIComponent(code)}/ancestors?pageNumber=${page}&pageSize=50&apiKey=${UMLS_API_KEY}`;
      let res: Response;
      try {
        res = await fetch(url, { headers: { Accept: "application/json" } });
      } catch {
        break;
      }
      if (!res.ok) break;
      const json = await res.json();
      const ancestors = Array.isArray(json?.result) ? json.result : [];
      if (ancestors.length === 0) break;
      for (const a of ancestors) {
        const codeUrl = String(a?.code ?? "");
        const extracted = codeUrl.split("/").pop() ?? "";
        if (extracted && extracted !== "NONE") codes.add(extracted);
      }
      if (ancestors.length < 50) break;
    }
    return codes;
  };

  const ancestorsOfA = await getAncestorCodes(codeA);
  if (ancestorsOfA.has(codeB)) {
    return { outcome: "subsumed-by", codeA, codeB, elapsed_ms: Date.now() - started };
  }

  const ancestorsOfB = await getAncestorCodes(codeB);
  if (ancestorsOfB.has(codeA)) {
    return { outcome: "subsumes", codeA, codeB, elapsed_ms: Date.now() - started };
  }

  return { outcome: "not-subsumed", codeA, codeB, elapsed_ms: Date.now() - started };
}

// ─── Action type ─────────────────────────────────────────────────────────────

type Action =
  | "search"
  | "crosswalk"
  | "concept"
  | "chv"
  | "rxnorm"
  | "rxnormDetail"
  | "rxnormRelated"
  | "validate"
  | "meddra"
  | "icd10"
  | "snomed"
  | "loinc"
  | "resolveAndValidate"
  | "subsumes";

interface Body {
  action: Action;
  params: Record<string, unknown>;
}

const supabase = SUPABASE_URL && SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

async function hashKey(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function cacheGet(key: string): Promise<unknown | null> {
  if (!supabase) return null;
  const { data } = await supabase
    .from("umls_cache")
    .select("response, expires_at")
    .eq("cache_key", key)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at as string) < new Date()) return null;
  return data.response;
}

async function cacheSet(
  key: string,
  vocabulary: string,
  response: unknown,
): Promise<void> {
  if (!supabase) return;
  await supabase.from("umls_cache").upsert(
    {
      cache_key: key,
      vocabulary,
      response,
      cached_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: "cache_key" },
  );
}

function buildUrl(action: Action, p: Record<string, unknown>): {
  url: string;
  vocab: string;
} {
  switch (action) {
    case "search": {
      const qs = new URLSearchParams({
        string: String(p.string ?? ""),
        sabs: String(p.sabs ?? ""),
        returnIdType: String(p.returnIdType ?? "sourceUi"),
        searchType: String(p.searchType ?? "words"),
        pageSize: String(p.pageSize ?? 10),
        apiKey: UMLS_API_KEY,
      });
      return { url: `${UTS}/search/current?${qs}`, vocab: String(p.sabs ?? "") };
    }
    case "icd10": {
      const qs = new URLSearchParams({
        string: String(p.string ?? ""),
        sabs: "ICD10CM",
        returnIdType: "sourceUi",
        searchType: String(p.searchType ?? "words"),
        pageSize: String(p.pageSize ?? 5),
        apiKey: UMLS_API_KEY,
      });
      return { url: `${UTS}/search/current?${qs}`, vocab: "ICD10CM" };
    }
    case "snomed": {
      const qs = new URLSearchParams({
        string: String(p.string ?? ""),
        sabs: "SNOMEDCT_US",
        returnIdType: "sourceUi",
        searchType: String(p.searchType ?? "words"),
        pageSize: String(p.pageSize ?? 5),
        apiKey: UMLS_API_KEY,
      });
      return { url: `${UTS}/search/current?${qs}`, vocab: "SNOMEDCT_US" };
    }
    case "loinc": {
      const qs = new URLSearchParams({
        string: String(p.string ?? ""),
        sabs: "LNC",
        returnIdType: "sourceUi",
        searchType: String(p.searchType ?? "words"),
        pageSize: String(p.pageSize ?? 5),
        apiKey: UMLS_API_KEY,
      });
      return { url: `${UTS}/search/current?${qs}`, vocab: "LNC" };
    }
    case "crosswalk": {
      const fromSab = String(p.fromSab ?? p.sourceSab ?? "");
      const fromCode = String(p.fromCode ?? p.code ?? "");
      const toSab = String(p.toSab ?? p.targetSab ?? "");
      const qs = new URLSearchParams({
        targetSource: toSab,
        apiKey: UMLS_API_KEY,
      });
      return {
        url: `${UTS}/crosswalk/current/source/${encodeURIComponent(fromSab)}/${encodeURIComponent(fromCode)}?${qs}`,
        vocab: toSab,
      };
    }
    case "concept": {
      const qs = new URLSearchParams({ apiKey: UMLS_API_KEY });
      return {
        url: `${UTS}/content/current/CUI/${encodeURIComponent(String(p.cui ?? ""))}?${qs}`,
        vocab: "CUI",
      };
    }
    case "chv": {
      const qs = new URLSearchParams({
        string: String(p.string ?? ""),
        sabs: "CHV",
        returnIdType: "sourceUi",
        searchType: "words",
        pageSize: "3",
        apiKey: UMLS_API_KEY,
      });
      return { url: `${UTS}/search/current?${qs}`, vocab: "CHV" };
    }
    case "meddra": {
      const qs = new URLSearchParams({
        string: String(p.string ?? ""),
        sabs: "MDR",
        returnIdType: "sourceUi",
        apiKey: UMLS_API_KEY,
      });
      return { url: `${UTS}/search/current?${qs}`, vocab: "MDR" };
    }
    case "validate": {
      const qs = new URLSearchParams({
        string: String(p.code ?? ""),
        sabs: String(p.sab ?? ""),
        inputType: "sourceUi",
        searchType: "exact",
        returnIdType: "sourceUi",
        apiKey: UMLS_API_KEY,
      });
      return { url: `${UTS}/search/current?${qs}`, vocab: String(p.sab ?? "") };
    }
    case "rxnorm": {
      const qs = new URLSearchParams({
        name: String(p.drugName ?? ""),
        search: "1",
      });
      return { url: `${RXNAV}/rxcui.json?${qs}`, vocab: "RXNORM" };
    }
    case "rxnormDetail": {
      return {
        url: `${RXNAV}/rxcui/${encodeURIComponent(String(p.rxcui ?? ""))}/properties.json`,
        vocab: "RXNORM",
      };
    }
    case "rxnormRelated": {
      const tty = String(p.tty ?? "IN");
      return {
        url: `${RXNAV}/rxcui/${encodeURIComponent(String(p.rxcui ?? ""))}/related.json?tty=${encodeURIComponent(tty)}`,
        vocab: "RXNORM",
      };
    }
    case "resolveAndValidate":
    case "subsumes":
      throw new Error(`Action "${action}" must be handled before buildUrl`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as Body;
    const { action, params } = body;
    if (!action) {
      return new Response(JSON.stringify({ error: "Missing action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "resolveAndValidate") {
      if (!UMLS_API_KEY) {
        return new Response(
          JSON.stringify({ error: "UMLS_API_KEY not configured" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const cacheKey = await hashKey(`resolveAndValidate:${JSON.stringify(params ?? {})}`);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return new Response(
          JSON.stringify({ cached: true, vocabulary: "SNOMEDCT_US", ...(cached as object) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const result = await resolveAndValidate(params ?? {});
      cacheSet(cacheKey, "SNOMEDCT_US", result).catch(() => {});
      return new Response(
        JSON.stringify({ cached: false, vocabulary: "SNOMEDCT_US", ...result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "subsumes") {
      if (!UMLS_API_KEY) {
        return new Response(
          JSON.stringify({ error: "UMLS_API_KEY not configured" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const cacheKey = await hashKey(`subsumes:${JSON.stringify(params ?? {})}`);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return new Response(
          JSON.stringify({ cached: true, vocabulary: "SNOMEDCT_US", ...(cached as object) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const result = await checkSubsumes(params ?? {});
      cacheSet(cacheKey, "SNOMEDCT_US", result).catch(() => {});
      return new Response(
        JSON.stringify({ cached: false, vocabulary: "SNOMEDCT_US", ...result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const needsUmls = action !== "rxnorm" && action !== "rxnormDetail" &&
      action !== "rxnormRelated";
    if (needsUmls && !UMLS_API_KEY) {
      return new Response(
        JSON.stringify({ error: "UMLS_API_KEY not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { url, vocab } = buildUrl(action, params ?? {});
    const cacheKey = await hashKey(`${action}:${JSON.stringify(params ?? {})}`);

    const cached = await cacheGet(cacheKey);
    if (cached) {
      return new Response(
        JSON.stringify({ cached: true, vocabulary: vocab, ...(cached as object) }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const started = Date.now();
    if (action === "crosswalk") {
      console.log("[umls-proxy] crosswalk upstream URL:", url);
    }
    const upstream = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const elapsed_ms = Date.now() - started;

    if (!upstream.ok) {
      if (action === "crosswalk" && upstream.status === 404) {
        const fb = await crosswalkCuiFallback(params ?? {});
        const out = { result: fb.matches[0] ?? null, matches: fb.matches, elapsed_ms, fallback: "cui-atoms" };
        cacheSet(cacheKey, vocab, out).catch(() => {});
        return new Response(
          JSON.stringify({ cached: false, vocabulary: vocab, ...out }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const text = await upstream.text();
      return new Response(
        JSON.stringify({
          error: `Upstream ${upstream.status}`,
          detail: text.slice(0, 500),
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const json = await upstream.json();
    let shaped: Record<string, unknown> = { elapsed_ms, ...json };

    if (action === "crosswalk") {
      const raw = Array.isArray((json as any).result) ? (json as any).result : [];
      const filtered = raw.filter((r: any) => r && r.ui && r.ui !== "NONE");
      let matches = filtered.map((r: any) => ({
        code: r.ui,
        name: r.name,
        rootSource: r.rootSource,
      }));
      if (matches.length === 0) {
        const fb = await crosswalkCuiFallback(params ?? {});
        matches = fb.matches;
      }
      shaped = {
        elapsed_ms,
        result: matches[0] ?? null,
        matches,
      };
    }

    if (action === "validate") {
      const results = Array.isArray((json as any)?.result?.results)
        ? (json as any).result.results
        : [];
      const top = results.find((r: any) => r && r.ui && r.ui !== "NONE") ?? null;
      shaped = {
        elapsed_ms,
        result: top
          ? {
              cui: top.ui,
              name: top.name,
              rootSource: top.rootSource,
              status: "active",
            }
          : null,
      };
    }

    const payload = { cached: false, vocabulary: vocab, ...shaped };
    cacheSet(cacheKey, vocab, shaped).catch(() => {});

    return new Response(JSON.stringify(payload), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message ?? "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
