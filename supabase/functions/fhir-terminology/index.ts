// FHIR R4 Terminology Server — exposes $lookup, $expand, $translate as
// Parameters resources backed by the umls-proxy + custom_value_sets table.

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

const SYSTEM_TO_SAB: Record<string, string> = {
  "http://snomed.info/sct": "SNOMEDCT_US",
  "SNOMED CT": "SNOMEDCT_US",
  "SNOMED-CT": "SNOMEDCT_US",
  "SNOMEDCT_US": "SNOMEDCT_US",
  "http://hl7.org/fhir/sid/icd-10-cm": "ICD10CM",
  "ICD-10-CM": "ICD10CM",
  "ICD-10": "ICD10CM",
  "ICD10CM": "ICD10CM",
  "http://loinc.org": "LNC",
  "LOINC": "LNC",
  "LNC": "LNC",
  "http://www.nlm.nih.gov/research/umls/rxnorm": "RXNORM",
  "RxNorm": "RXNORM",
  "RXNORM": "RXNORM",
  "http://www.cpt.org": "CPT",
  "CPT": "CPT",
  "MedDRA": "MDR",
  "MDR": "MDR",
};

function toSab(system: string): string {
  return SYSTEM_TO_SAB[system] ?? system;
}

const supabase = SUPABASE_URL && SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

async function utsFetch(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ...params, apiKey: UMLS_API_KEY });
  const res = await fetch(`${UTS}${path}?${qs}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`UMLS ${res.status}: ${await res.text()}`);
  return res.json();
}

async function rxnavFetch(path: string) {
  const res = await fetch(`${RXNAV}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`RxNav ${res.status}`);
  return res.json();
}

function param(name: string, value: any) {
  if (typeof value === "string") return { name, valueString: value };
  if (typeof value === "boolean") return { name, valueBoolean: value };
  if (typeof value === "number") return { name, valueDecimal: value };
  if (value && typeof value === "object" && "system" in value) {
    return { name, valueCoding: value };
  }
  return { name, valueString: String(value) };
}

// ---- $lookup ----------------------------------------------------------------
async function opLookup(p: { system: string; code: string }) {
  const sab = toSab(p.system);
  let display = p.code;
  let parent: string | undefined;
  let active = true;
  let cui = "";

  if (sab === "RXNORM") {
    const detail = await rxnavFetch(`/rxcui/${encodeURIComponent(p.code)}/properties.json`);
    display = detail?.properties?.name ?? p.code;
  } else {
    // Validate code → look up the CUI via /search (exact match by sourceUi)
    try {
      const validate = await utsFetch(`/search/current`, {
        string: p.code,
        sabs: sab,
        inputType: "sourceUi",
        searchType: "exact",
        returnIdType: "concept",
        pageSize: "1",
      });
      const first = validate?.result?.results?.[0];
      if (first?.ui && first.ui !== "NONE") {
        cui = first.ui;
        if (first.name) display = first.name;
      }
    } catch (_) { /* best-effort */ }

    // Resolve display + parent via the CUI concept endpoint
    if (cui) {
      try {
        const concept = await utsFetch(`/content/current/CUI/${cui}`, {});
        const name = concept?.result?.name;
        if (name) display = name;
        if (concept?.result?.status && String(concept.result.status).toLowerCase() !== "r") {
          // R = reviewed/active in UMLS; anything else flagged as inactive
          active = false;
        }
      } catch (_) { /* best-effort */ }
    }

    if (cui && sab === "SNOMEDCT_US") {
      try {
          const rels = await utsFetch(
            `/content/current/CUI/${cui}/relations`,
            { sabs: sab, includeRelationLabels: "PAR", pageSize: "1" },
          );
          parent = rels?.result?.[0]?.relatedIdName;
      } catch (_) { /* best-effort */ }
    }
  }

  return {
    resourceType: "Parameters",
    parameter: [
      param("name", display),
      param("display", display),
      param("system", p.system),
      param("version", "current"),
      ...(parent
        ? [{ name: "property", part: [
            { name: "code", valueCode: "parent" },
            { name: "value", valueCode: parent },
          ] }]
        : []),
      { name: "property", part: [
        { name: "code", valueCode: "inactive" },
        { name: "value", valueBoolean: !active },
      ] },
      ...(cui ? [{ name: "property", part: [
        { name: "code", valueCode: "cui" },
        { name: "value", valueCode: cui },
      ] }] : []),
    ],
  };
}

// ---- $expand ----------------------------------------------------------------
async function opExpand(p: { valueSet: string; filter?: string; count?: number }) {
  if (!supabase) throw new Error("Supabase service role not configured");
  // Try name first, then id, then fhir_url — avoids .or() escaping issues with spaces.
  const cols = "id, name, vocabulary, type, codes, intensional_rule, fhir_url, oid";
  let vs: any = null;
  for (const col of ["name", "id", "fhir_url"] as const) {
    const { data } = await supabase
      .from("custom_value_sets")
      .select(cols)
      .eq(col, p.valueSet)
      .maybeSingle();
    if (data) { vs = data; break; }
  }
  if (!vs) throw new Error(`ValueSet not found: ${p.valueSet}`);

  let contains: Array<{ system: string; code: string; display: string }> = [];
  const baseCodes = Array.isArray(vs.codes) ? vs.codes : [];
  contains = baseCodes.map((c: any) => ({
    system: c.system ?? c.vocabulary ?? vs.vocabulary,
    code: String(c.code),
    display: String(c.display ?? c.code),
  }));

  if (vs.type === "intensional" && vs.intensional_rule?.rootConcept) {
    // Try to expand SNOMED descendants via UMLS atoms — limited but real
    try {
      const root = String(vs.intensional_rule.rootConcept);
      const cuiSearch = await utsFetch("/search/current", {
        string: root, sabs: "SNOMEDCT_US", returnIdType: "concept",
        searchType: "exact", pageSize: "1",
      });
      const cui = cuiSearch?.result?.results?.[0]?.ui;
      if (cui && cui !== "NONE") {
        const rels = await utsFetch(
          `/content/current/CUI/${cui}/relations`,
          { sabs: "SNOMEDCT_US", includeRelationLabels: "CHD", pageSize: "50" },
        );
        const children = (rels?.result ?? []).map((r: any) => ({
          system: "http://snomed.info/sct",
          code: String(r.relatedId ?? "").split("/").pop() ?? "",
          display: String(r.relatedIdName ?? ""),
        })).filter((c: any) => c.code);
        const seen = new Set(contains.map(c => c.code));
        for (const c of children) if (!seen.has(c.code)) { contains.push(c); seen.add(c.code); }
      }
    } catch (_) { /* fall back to base codes */ }
  }

  if (p.filter) {
    const f = p.filter.toLowerCase();
    contains = contains.filter(c => c.display.toLowerCase().includes(f) || c.code.includes(f));
  }
  const total = contains.length;
  if (p.count && p.count > 0) contains = contains.slice(0, p.count);

  return {
    resourceType: "ValueSet",
    id: vs.id,
    url: vs.fhir_url,
    name: vs.name,
    status: "active",
    expansion: {
      identifier: vs.oid,
      timestamp: new Date().toISOString(),
      total,
      contains,
    },
  };
}

// ---- $translate -------------------------------------------------------------
async function opTranslate(p: {
  system: string; code: string; targetSystem: string;
}) {
  const srcSab = toSab(p.system);
  const tgtSab = toSab(p.targetSystem);

  // Use the dedicated UMLS crosswalk endpoint:
  // GET /crosswalk/current/source/{fromSab}/{fromCode}?targetSource={toSab}
  let xwalk: any[] = [];
  try {
    const qs = new URLSearchParams({ targetSource: tgtSab, apiKey: UMLS_API_KEY });
    const res = await fetch(
      `${UTS}/crosswalk/current/source/${encodeURIComponent(srcSab)}/${encodeURIComponent(p.code)}?${qs}`,
      { headers: { Accept: "application/json" } },
    );
    if (res.ok) {
      const json = await res.json();
      xwalk = json?.result ?? [];
    }
  } catch (_) { /* leave empty */ }

  const matches = xwalk.map((a: any, i: number) => ({
    name: "match",
    part: [
      { name: "equivalence", valueCode: i === 0 ? "equivalent" : "wider" },
      { name: "concept", valueCoding: {
        system: p.targetSystem,
        code: String(a.ui ?? a.code ?? "").split("/").pop().trim(),
        display: String(a.name ?? ""),
      } },
      ...(a.rootSource ? [{ name: "source", valueUri: String(a.rootSource) }] : []),
    ],
  })).filter((m: any) => m.part[1].valueCoding.code);

  return {
    resourceType: "Parameters",
    parameter: [
      param("result", matches.length > 0),
      ...(matches.length ? matches : [param("message", "No crosswalk found in UMLS Metathesaurus")]),
    ],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!UMLS_API_KEY) {
    return new Response(JSON.stringify({ error: "UMLS_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { operation, params } = body as { operation: string; params: any };
    let result;
    switch (operation) {
      case "lookup":     result = await opLookup(params); break;
      case "expand":     result = await opExpand(params); break;
      case "translate":  result = await opTranslate(params); break;
      default:
        return new Response(JSON.stringify({ error: `Unknown operation: ${operation}` }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/fhir+json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      resourceType: "OperationOutcome",
      issue: [{ severity: "error", code: "exception", diagnostics: (err as Error).message }],
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/fhir+json" } });
  }
});