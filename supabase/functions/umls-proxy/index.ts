// UMLS proxy edge function — single gateway for all terminology calls.
// Reads UMLS_API_KEY from env; caches responses in public.umls_cache for 7 days.

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
  | "loinc";

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
      const qs = new URLSearchParams({
        sabs: String(p.targetSab ?? ""),
        ttys: "PT",
        apiKey: UMLS_API_KEY,
      });
      return {
        url: `${UTS}/content/current/CUI/${encodeURIComponent(String(p.cui ?? ""))}/atoms?${qs}`,
        vocab: String(p.targetSab ?? ""),
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

    const needsUmls = action !== "rxnorm" && action !== "rxnormDetail" &&
      action !== "rxnormRelated";
    if (needsUmls && !UMLS_API_KEY) {
      return new Response(
        JSON.stringify({ error: "UMLS_API_KEY not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
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
    const upstream = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const elapsed_ms = Date.now() - started;

    if (!upstream.ok) {
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
    const payload = { cached: false, vocabulary: vocab, elapsed_ms, ...json };
    // fire-and-forget cache write
    cacheSet(cacheKey, vocab, { elapsed_ms, ...json }).catch(() => {});

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