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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UTS = "https://uts-ws.nlm.nih.gov/rest";
const RXNAV = "https://rxnav.nlm.nih.gov/REST";

// ─── UMLS/VSAC response shapes ───────────────────────────────────────────────
//
// The UTS REST API returns loosely-typed JSON; these interfaces describe only
// the fields this function actually reads, so upstream payloads are cast to
// them (via `as`) instead of flowing through as `any`.

/** One row of a UMLS /search or /atoms result ("ui" is "NONE" when absent). */
interface UmlsSearchResult {
  ui: string;
  name: string;
  rootSource?: string;
}

interface UmlsSearchResponse {
  result?: { results?: UmlsSearchResult[] };
}

/** One row of a UMLS /atoms or /ancestors /descendants /children /parents list. */
interface UmlsAtom {
  code?: string;
  ui?: string;
  name?: string;
  rootSource?: string;
}

interface UmlsAtomsResponse {
  result?: UmlsAtom[];
}

/** A VSAC/FHIR ValueSet $expand response, trimmed to the fields we read. */
interface VsacExpansionContains {
  code?: string;
  display?: string;
  system?: string;
}

interface VsacInclude {
  valueSet?: string[];
  filter?: unknown[];
}

interface VsacValueSetResource {
  expansion?: { contains?: VsacExpansionContains[] };
  compose?: { include?: VsacInclude[] };
}

/** One entry of a FHIR `ValueSet?name:contains=...` search Bundle, trimmed
 * to the fields `vsacSearch` reads. The VSAC FHIR terminology server uses
 * the OID itself as the resource `id`. */
interface VsacSearchEntryResource {
  id?: string;
  name?: string;
  title?: string;
  publisher?: string;
  status?: string;
}

interface VsacSearchBundle {
  entry?: Array<{ resource?: VsacSearchEntryResource }>;
}

// ─── Secret redaction ────────────────────────────────────────────────────────
//
// UMLS authenticates via an `apiKey` query parameter, so every upstream URL we
// build embeds the secret. Deno's fetch errors also quote the request URL in
// their message. Run anything that leaves this function — logs and HTTP
// response bodies alike — through this first so the key never escapes.

function redactSecrets(input: unknown): string {
  let s = typeof input === "string" ? input : String(input ?? "");
  // Query-param form: ?apiKey=xxx / &apiKey=xxx (any casing/underscore variant)
  s = s.replace(/([?&](?:apikey|api_key)=)[^&\s"'\\)]+/gi, "$1***");
  // Belt-and-braces: scrub the literal key wherever else it may appear.
  if (UMLS_API_KEY) s = s.split(UMLS_API_KEY).join("***");
  return s;
}

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
    console.log("[umls-proxy] crosswalk fallback error:", redactSecrets((e as Error).message));
    return { matches: [] };
  }
}

// ─── P1-A: Resolve text → SNOMED code, validate, return confidence ───────────
//
// The Auto Terminologist was calling "validate" with raw clinical text (e.g.
// "chest pain") as the code parameter. Because "validate" uses inputType=sourceUi
// + searchType=exact, UMLS found no match → result=null → confidence 0.40–0.48.
//
// This action fixes that by:
//   1. Detecting whether input is already a code (6-18 digits) or free text.
//   2. If text: searching UMLS with searchType=words to find the best SNOMED match.
//   3. Computing a confidence score based on name similarity.
//   4. Returning resolvedCode, resolvedName, confidence, and a statusRouting hint.
//
// Confidence thresholds (mirrors Auto Terminologist routing):
//   ≥ 0.80 → "review"  (In Review)
//   0.50–0.79 → "draft"
//   < 0.50 → "held"

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
    return {
      resolvedCode: null,
      resolvedName: null,
      confidence: 0,
      valid: false,
      statusRouting: "held",
      elapsed_ms: 0,
    };
  }

  // If input looks like an existing SNOMED code (purely numeric, 6-18 digits),
  // validate it directly with exact sourceUi match — skip the text search.
  const isCodeLike = /^\d{6,18}$/.test(input);

  if (isCodeLike) {
    const url = `${UTS}/search/current?string=${encodeURIComponent(input)}&sabs=${encodeURIComponent(sab)}&inputType=sourceUi&searchType=exact&returnIdType=sourceUi&pageSize=1&apiKey=${UMLS_API_KEY}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const elapsed_ms = Date.now() - started;
    if (!res.ok) {
      return {
        resolvedCode: input,
        resolvedName: null,
        confidence: 0.35,
        valid: false,
        statusRouting: "held",
        elapsed_ms,
      };
    }
    const json = (await res.json()) as UmlsSearchResponse;
    const results = Array.isArray(json?.result?.results) ? json.result.results : [];
    const top = results.find((r) => r?.ui && r.ui !== "NONE");
    if (top) {
      return {
        resolvedCode: top.ui,
        resolvedName: top.name,
        confidence: 0.95,
        valid: true,
        statusRouting: "review",
        elapsed_ms,
      };
    }
    return {
      resolvedCode: input,
      resolvedName: null,
      confidence: 0.3,
      valid: false,
      statusRouting: "held",
      elapsed_ms,
    };
  }

  // Free text: two-step CUI lookup.
  //
  // Step 1: search with returnIdType=concept (gets CUI + display name).
  // returnIdType=sourceUi with searchType=words frequently returns ui="NONE"
  // for multi-word clinical phrases because UMLS can locate the concept but
  // cannot resolve it to a single source code in one pass.
  const searchUrl = `${UTS}/search/current?string=${encodeURIComponent(input)}&sabs=${encodeURIComponent(sab)}&returnIdType=concept&searchType=words&pageSize=5&apiKey=${UMLS_API_KEY}`;
  const res = await fetch(searchUrl, { headers: { Accept: "application/json" } });
  const elapsed_ms = Date.now() - started;

  if (!res.ok) {
    return {
      resolvedCode: null,
      resolvedName: null,
      confidence: 0.2,
      valid: false,
      statusRouting: "held",
      elapsed_ms,
    };
  }

  const json = (await res.json()) as UmlsSearchResponse;
  const results = Array.isArray(json?.result?.results) ? json.result.results : [];
  const top = results.find((r) => r?.ui && r.ui !== "NONE");

  if (!top) {
    return {
      resolvedCode: null,
      resolvedName: null,
      confidence: 0.25,
      valid: false,
      statusRouting: "held",
      elapsed_ms,
    };
  }

  const cui = String(top.ui); // e.g. "C0008031"
  const cuiDisplayName = String(top.name ?? ""); // e.g. "Chest Pain"

  // Step 2: resolve CUI → source code in the requested vocabulary.
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
        // UMLS returns full URLs like ".../sourceUi/29857009" — extract the tail
        const code = rawCode.includes("/") ? rawCode.split("/").pop()! : rawCode;
        if (!code || code === "NONE") continue;
        resolvedSourceCode = code;
        resolvedSourceName = String(a.name ?? cuiDisplayName);
        break;
      }
    }
  } catch (e) {
    console.log(
      "[umls-proxy] atoms lookup error for CUI",
      cui,
      redactSecrets((e as Error).message),
    );
  }

  if (!resolvedSourceCode) {
    // CUI found but no atom in requested vocabulary — return held with low confidence
    return {
      resolvedCode: null,
      resolvedName: cuiDisplayName,
      confidence: 0.3,
      valid: false,
      statusRouting: "held",
      elapsed_ms,
    };
  }

  // Compute confidence from name similarity between the resolved display name and input.
  const resolvedName = resolvedSourceName.toLowerCase().trim();
  const inputLower = input.toLowerCase().trim();

  let confidence: number;
  if (resolvedName === inputLower) {
    confidence = 0.93;
  } else if (resolvedName.includes(inputLower) || inputLower.includes(resolvedName)) {
    // One contains the other (e.g. "chest pain" vs "Chest pain (finding)")
    confidence = 0.85;
  } else {
    // Word-overlap ratio — partial match
    const inputWords = new Set(inputLower.split(/\s+/).filter(Boolean));
    const nameWords = new Set(resolvedName.split(/\s+/).filter(Boolean));
    const overlap = [...inputWords].filter((w) => nameWords.has(w)).length;
    const maxWords = Math.max(inputWords.size, nameWords.size, 1);
    const ratio = overlap / maxWords;
    confidence = 0.5 + Math.min(ratio, 1) * 0.28;
  }

  const statusRouting: "review" | "draft" | "held" =
    confidence >= 0.8 ? "review" : confidence >= 0.5 ? "draft" : "held";

  return {
    resolvedCode: resolvedSourceCode,
    resolvedName: resolvedSourceName,
    confidence,
    valid: true,
    statusRouting,
    elapsed_ms,
  };
}

// ─── P1-B: Subsumption check via UMLS source ancestors ───────────────────────
//
// Implements FHIR $subsumes semantics using the UMLS source ancestors endpoint:
//   GET /content/current/source/{SAB}/{code}/ancestors
//
// Logic:
//   codeA === codeB               → "equivalent"
//   codeB in ancestors(codeA)     → "subsumed-by" (codeA is more specific)
//   codeA in ancestors(codeB)     → "subsumes"    (codeA is more general)
//   otherwise                     → "not-subsumed"
//
// Paginates up to 10 pages × 50 = 500 ancestors (covers all SNOMED depths).

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

  // Is codeA subsumed-by codeB? (codeB is an ancestor of codeA)
  const ancestorsOfA = await fetchRelatedCodes(sab, codeA, "ancestors", { maxPages: 10 });
  if (ancestorsOfA.some((r) => r.code === codeB)) {
    return { outcome: "subsumed-by", codeA, codeB, elapsed_ms: Date.now() - started };
  }

  // Does codeA subsume codeB? (codeA is an ancestor of codeB)
  const ancestorsOfB = await fetchRelatedCodes(sab, codeB, "ancestors", { maxPages: 10 });
  if (ancestorsOfB.some((r) => r.code === codeA)) {
    return { outcome: "subsumes", codeA, codeB, elapsed_ms: Date.now() - started };
  }

  return { outcome: "not-subsumed", codeA, codeB, elapsed_ms: Date.now() - started };
}

// ─── P2: Shared UMLS relation pagination + hierarchyExpand ───────────────────
//
// Single helper used by checkSubsumes (ancestors) and hierarchyExpand
// (descendants / ancestors / children / parents). Returns { code, name } pairs
// extracted from ancestor/descendant/child/parent atoms with the URL-tail
// code extraction. Ancestors and descendants paginate up to `maxPages`;
// children and parents are one hop so a single page is enough.

type UmlsRelation = "ancestors" | "descendants" | "children" | "parents";

async function fetchRelatedCodes(
  sab: string,
  code: string,
  relation: UmlsRelation,
  opts: { maxPages?: number; cap?: number } = {},
): Promise<Array<{ code: string; name: string }>> {
  const maxPages = opts.maxPages ?? (relation === "children" || relation === "parents" ? 1 : 10);
  const cap = opts.cap ?? Infinity;
  const pageSize = 50;
  const out: Array<{ code: string; name: string }> = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const url =
      `${UTS}/content/current/source/${encodeURIComponent(sab)}/${encodeURIComponent(code)}/${relation}` +
      `?pageNumber=${page}&pageSize=${pageSize}&apiKey=${UMLS_API_KEY}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch {
      break;
    }
    if (!res.ok) break; // 404 → none / leaf / unknown
    const json = await res.json();
    const rows = Array.isArray(json?.result) ? json.result : [];
    if (rows.length === 0) break;
    for (const r of rows) {
      // UMLS source-relation rows expose the code as `ui`. Older code paths
      // ship it as a full URL under `code`; support both so the extractor
      // works regardless of which shape UTS returns.
      let extracted = String(r?.ui ?? "").trim();
      if (!extracted) {
        const codeUrl = String(r?.code ?? "");
        extracted = codeUrl.includes("/") ? (codeUrl.split("/").pop() ?? "") : codeUrl;
      }
      if (!extracted || extracted === "NONE" || seen.has(extracted)) continue;
      seen.add(extracted);
      out.push({ code: extracted, name: String(r?.name ?? "") });
      if (out.length >= cap) return out;
    }
    if (rows.length < pageSize) break;
  }
  return out;
}

type HierarchyOperator =
  | "equal"
  | "in"
  | "descendantOf"
  | "descendantOrSelfOf"
  | "childOf"
  | "ancestorOf"
  | "ancestorOrSelfOf"
  | "parentOf";

const HIERARCHY_CAP = 500;

async function fetchAnchorName(sab: string, code: string): Promise<string> {
  try {
    const url = `${UTS}/content/current/source/${encodeURIComponent(sab)}/${encodeURIComponent(code)}?apiKey=${UMLS_API_KEY}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return "";
    const json = await res.json();
    return String(json?.result?.name ?? "");
  } catch {
    return "";
  }
}

async function hierarchyExpand(p: Record<string, unknown>): Promise<{
  anchorCode: string;
  operator: HierarchyOperator;
  codes: Array<{ code: string; name: string }>;
  count: number;
  truncated: boolean;
  elapsed_ms: number;
}> {
  const started = Date.now();
  const sab = String(p.sab ?? "SNOMEDCT_US");
  const anchorCode = String(p.code ?? "").trim();
  const operator = String(p.operator ?? "descendantOrSelfOf") as HierarchyOperator;

  const empty = {
    anchorCode,
    operator,
    codes: [] as Array<{ code: string; name: string }>,
    count: 0,
    truncated: false,
    elapsed_ms: Date.now() - started,
  };
  if (!anchorCode) return empty;

  const anchorName = await fetchAnchorName(sab, anchorCode);
  const self = { code: anchorCode, name: anchorName };

  let related: Array<{ code: string; name: string }> = [];
  let includeSelf = false;
  let cap = HIERARCHY_CAP;

  switch (operator) {
    case "equal":
    case "in":
      return {
        anchorCode,
        operator,
        codes: [self],
        count: 1,
        truncated: false,
        elapsed_ms: Date.now() - started,
      };
    case "descendantOrSelfOf":
      includeSelf = true;
      cap = HIERARCHY_CAP - 1;
      related = await fetchRelatedCodes(sab, anchorCode, "descendants", { cap });
      break;
    case "descendantOf":
      related = await fetchRelatedCodes(sab, anchorCode, "descendants", { cap });
      break;
    case "ancestorOrSelfOf":
      includeSelf = true;
      cap = HIERARCHY_CAP - 1;
      related = await fetchRelatedCodes(sab, anchorCode, "ancestors", { cap });
      break;
    case "ancestorOf":
      related = await fetchRelatedCodes(sab, anchorCode, "ancestors", { cap });
      break;
    case "childOf":
      related = await fetchRelatedCodes(sab, anchorCode, "children", { cap });
      break;
    case "parentOf":
      related = await fetchRelatedCodes(sab, anchorCode, "parents", { cap });
      break;
    default:
      return empty;
  }

  const codes = includeSelf ? [self, ...related] : related;
  const truncated = codes.length >= HIERARCHY_CAP;
  return {
    anchorCode,
    operator,
    codes: codes.slice(0, HIERARCHY_CAP),
    count: Math.min(codes.length, HIERARCHY_CAP),
    truncated,
    elapsed_ms: Date.now() - started,
  };
}

// ─── VSAC $expand by OID ─────────────────────────────────────────────────────
//
// Calls the NLM VSAC FHIR terminology server with HTTP Basic Auth
// (username = UMLS_API_KEY, empty password). Returns a normalized shape the
// UI can preview + import into custom_value_sets.

const VSAC_SYSTEM_TO_VOCAB: Record<string, string> = {
  "http://snomed.info/sct": "SNOMED CT",
  "http://hl7.org/fhir/sid/icd-10-cm": "ICD-10-CM",
  "http://loinc.org": "LOINC",
  "http://www.nlm.nih.gov/research/umls/rxnorm": "RxNorm",
  "http://www.ama-assn.org/go/cpt": "CPT",
};

async function vsacExpand(p: Record<string, unknown>): Promise<
  | {
      oid: string;
      name: string | null;
      title: string | null;
      total: number;
      type: "grouping" | "intensional" | "extensional";
      codes: Array<{ code: string; display: string; vocabulary: string }>;
    }
  | { error: string; status: number }
> {
  const oid = String(p.oid ?? "").trim();
  if (!oid) return { error: "Missing OID", status: 400 };

  try {
    const url = `https://cts.nlm.nih.gov/fhir/ValueSet/${encodeURIComponent(oid)}/$expand`;
    let auth: string;
    try {
      auth = btoa(`apikey:${UMLS_API_KEY}`);
    } catch {
      return {
        error: "UMLS_API_KEY contains characters that cannot be Base64-encoded for Basic auth.",
        status: 500,
      };
    }
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      return {
        error: `VSAC returned ${res.status}: ${res.statusText}. This UMLS API key may not have VSAC access, or the OID doesn't exist.`,
        status: res.status,
      };
    }

    let resource: VsacValueSetResource;
    try {
      resource = (await res.json()) as VsacValueSetResource;
    } catch {
      return { error: "VSAC returned a non-JSON response body.", status: 502 };
    }
    const expansion = resource?.expansion ?? {};
    const contains: VsacExpansionContains[] = Array.isArray(expansion.contains)
      ? expansion.contains
      : [];
    const codes = contains
      .map((c) => ({
        code: String(c?.code ?? ""),
        display: String(c?.display ?? ""),
        vocabulary: VSAC_SYSTEM_TO_VOCAB[String(c?.system ?? "")] ?? String(c?.system ?? ""),
      }))
      .filter((c) => c.code);

    // Fetch the ValueSet definition (without $expand) to detect its authoring
    // type: grouping (compose.include[].valueSet), intensional (…filter), or
    // extensional (…concept). Fall back to "extensional" if unavailable.
    let vsType: "grouping" | "intensional" | "extensional" = "extensional";
    try {
      const defRes = await fetch(
        `https://cts.nlm.nih.gov/fhir/ValueSet/${encodeURIComponent(oid)}`,
        { headers: { Accept: "application/json", Authorization: `Basic ${auth}` } },
      );
      if (defRes.ok) {
        const def = (await defRes.json()) as VsacValueSetResource;
        const includes: VsacInclude[] = Array.isArray(def?.compose?.include)
          ? def.compose.include
          : [];
        const hasGrouping = includes.some(
          (inc) => Array.isArray(inc?.valueSet) && inc.valueSet.length > 0,
        );
        const hasFilter = includes.some(
          (inc) => Array.isArray(inc?.filter) && inc.filter.length > 0,
        );
        if (hasGrouping) vsType = "grouping";
        else if (hasFilter) vsType = "intensional";
        else vsType = "extensional";
      }
    } catch {
      // ignore — keep default "extensional"
    }

    return {
      oid,
      name: resource?.name ?? null,
      title: resource?.title ?? null,
      total: typeof expansion.total === "number" ? expansion.total : codes.length,
      type: vsType,
      codes,
    };
  } catch (e) {
    return {
      error: `VSAC request failed: ${redactSecrets((e as Error).message ?? "unknown error")}`,
      status: 502,
    };
  }
}

// ─── VSAC catalog search by keyword ──────────────────────────────────────────
//
// Gap 1: real terminologists check VSAC's own "Search Value Sets" catalog
// for an already-published, steward-governed value set before authoring a
// new one from scratch. vsacExpand above requires an exact known OID; this
// action instead does a keyword search against the FHIR terminology
// server's ValueSet search (GET /fhir/ValueSet?name:contains=<term>), which
// returns a Bundle of ValueSet resources — same base URL and HTTP Basic
// Auth pattern as vsacExpand. Never throws: any failure (network, auth, a
// non-Bundle response) just degrades to an empty candidate list rather than
// erroring out, same philosophy as every other action in this file.

async function vsacSearch(p: Record<string, unknown>): Promise<{
  candidates: Array<{
    oid: string;
    name: string | null;
    title: string | null;
    publisher: string | null;
    status: string | null;
  }>;
}> {
  const query = String(p.query ?? "").trim();
  if (!query) return { candidates: [] };
  const count = Math.max(1, Math.min(50, Number(p.count ?? 20) || 20));

  try {
    let auth: string;
    try {
      auth = btoa(`apikey:${UMLS_API_KEY}`);
    } catch {
      return { candidates: [] };
    }
    const qs = new URLSearchParams({ "name:contains": query, _count: String(count) });
    const url = `https://cts.nlm.nih.gov/fhir/ValueSet?${qs}`;
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Basic ${auth}` },
    });
    if (!res.ok) return { candidates: [] };

    let bundle: VsacSearchBundle;
    try {
      bundle = (await res.json()) as VsacSearchBundle;
    } catch {
      return { candidates: [] };
    }
    const entries = Array.isArray(bundle?.entry) ? bundle.entry : [];
    const candidates = entries
      .map((e) => e?.resource)
      .filter((r): r is VsacSearchEntryResource => !!r && !!r.id)
      .map((r) => ({
        oid: String(r.id),
        name: r.name ?? null,
        title: r.title ?? null,
        publisher: r.publisher ?? null,
        status: r.status ?? null,
      }));
    return { candidates };
  } catch (e) {
    console.log("[umls-proxy] vsacSearch error:", redactSecrets((e as Error).message));
    return { candidates: [] };
  }
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
  | "icd10Resolve"
  | "loinc"
  | "resolveAndValidate" // P1-A: replaces "validate" for Auto Terminologist
  | "subsumes" // P1-B: FHIR $subsumes via UMLS ancestors
  | "vsacExpand" // VSAC $expand by OID via HL7 FHIR terminology server
  | "vsacSearch" // Gap 1: VSAC catalog keyword search (ValueSet?name:contains=)
  | "hierarchyExpand"; // P2: intensional expansion for SNOMED CT

interface Body {
  action: Action;
  params: Record<string, unknown>;
}

// ─── Supabase client + cache helpers ─────────────────────────────────────────

const supabase =
  SUPABASE_URL && SERVICE_ROLE_KEY
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

async function cacheSet(key: string, vocabulary: string, response: unknown): Promise<void> {
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

// ─── Simple single-URL action builder ────────────────────────────────────────

function buildUrl(
  action: Action,
  p: Record<string, unknown>,
): {
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
      // NOTE: "validate" expects an actual source code (e.g. SNOMED concept ID
      // "29857009"), NOT free text. For free-text input, use "resolveAndValidate".
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
    // Multi-step actions handled before buildUrl in Deno.serve — should never reach here
    case "resolveAndValidate":
    case "subsumes":
    case "vsacExpand":
    case "vsacSearch":
    case "icd10Resolve":
    case "hierarchyExpand":
      throw new Error(`Action "${action}" must be handled before buildUrl`);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

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

    // ── P1-A: resolveAndValidate (multi-step, bypasses buildUrl) ─────────────
    if (action === "resolveAndValidate") {
      if (!UMLS_API_KEY) {
        return new Response(JSON.stringify({ error: "UMLS_API_KEY not configured" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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
      return new Response(JSON.stringify({ cached: false, vocabulary: "SNOMEDCT_US", ...result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── P1-B: subsumes (multi-step, bypasses buildUrl) ────────────────────────
    if (action === "subsumes") {
      if (!UMLS_API_KEY) {
        return new Response(JSON.stringify({ error: "UMLS_API_KEY not configured" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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
      return new Response(JSON.stringify({ cached: false, vocabulary: "SNOMEDCT_US", ...result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── P2: hierarchyExpand (multi-step, bypasses buildUrl) ──────────────────
    if (action === "hierarchyExpand") {
      if (!UMLS_API_KEY) {
        return new Response(JSON.stringify({ error: "UMLS_API_KEY not configured" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cacheKey = await hashKey(`hierarchyExpand:${JSON.stringify(params ?? {})}`);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return new Response(
          JSON.stringify({ cached: true, vocabulary: "SNOMEDCT_US", ...(cached as object) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const result = await hierarchyExpand(params ?? {});
      cacheSet(cacheKey, "SNOMEDCT_US", result).catch(() => {});
      return new Response(JSON.stringify({ cached: false, vocabulary: "SNOMEDCT_US", ...result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── vsacExpand: VSAC ValueSet $expand by OID ─────────────────────────────
    if (action === "vsacExpand") {
      if (!UMLS_API_KEY) {
        return new Response(JSON.stringify({ error: "UMLS_API_KEY not configured" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const oid = String(params?.oid ?? "").trim();
      const cacheKey = await hashKey(`vsacExpand:${oid}`);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return new Response(
          JSON.stringify({ cached: true, vocabulary: "VSAC", ...(cached as object) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const result = await vsacExpand(params ?? {});
      if ("error" in result) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      cacheSet(cacheKey, "VSAC", result).catch(() => {});
      return new Response(JSON.stringify({ cached: false, vocabulary: "VSAC", ...result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── vsacSearch: VSAC catalog keyword search (Gap 1) ──────────────────────
    if (action === "vsacSearch") {
      if (!UMLS_API_KEY) {
        return new Response(JSON.stringify({ error: "UMLS_API_KEY not configured" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const query = String(params?.query ?? "").trim();
      const count = Math.max(1, Math.min(50, Number(params?.count ?? 20) || 20));
      const cacheKey = await hashKey(`vsacSearch:${query}:${count}`);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return new Response(
          JSON.stringify({ cached: true, vocabulary: "VSAC", ...(cached as object) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const result = await vsacSearch(params ?? {});
      cacheSet(cacheKey, "VSAC", result).catch(() => {});
      return new Response(JSON.stringify({ cached: false, vocabulary: "VSAC", ...result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── All other actions: single-URL via buildUrl ───────────────────────────
    // ── snomed: 2-step CUI → SNOMEDCT_US atom lookup (free-text safe) ────────
    if (action === "snomed") {
      const input = String(params?.string ?? "").trim();
      if (!input || !UMLS_API_KEY) {
        return new Response(JSON.stringify({ result: { results: [] } }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cacheKey = await hashKey(`snomed2:${input}`);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return new Response(
          JSON.stringify({ cached: true, vocabulary: "SNOMEDCT_US", ...(cached as object) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const s1 = await fetch(
        `${UTS}/search/current?string=${encodeURIComponent(input)}&returnIdType=concept&searchType=words&pageSize=10&apiKey=${UMLS_API_KEY}`,
        { headers: { Accept: "application/json" } },
      );
      const s1json = (s1.ok ? await s1.json() : {}) as UmlsSearchResponse;
      const candidates = (
        Array.isArray(s1json?.result?.results) ? s1json.result.results : []
      ).filter((r) => r?.ui && r.ui !== "NONE");

      let code: string | null = null;
      let name: string | null = null;
      for (const c of candidates) {
        const a = await fetch(
          `${UTS}/content/current/CUI/${encodeURIComponent(c.ui)}/atoms?sabs=SNOMEDCT_US&apiKey=${UMLS_API_KEY}`,
          { headers: { Accept: "application/json" } },
        );
        if (!a.ok) continue;
        const aj = (await a.json()) as UmlsAtomsResponse;
        const atoms = Array.isArray(aj?.result) ? aj.result : [];
        for (const atom of atoms) {
          const raw = String(atom?.code ?? "");
          const extracted = raw.includes("/") ? raw.split("/").pop()! : raw;
          if (extracted && extracted !== "NONE") {
            code = extracted;
            name = String(atom.name ?? c.name);
            break;
          }
        }
        if (code) break;
      }

      const out = { result: { results: code ? [{ ui: code, name }] : [] } };
      cacheSet(cacheKey, "SNOMEDCT_US", out).catch(() => {});
      return new Response(JSON.stringify({ cached: false, vocabulary: "SNOMEDCT_US", ...out }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── icd10Resolve: 2-step CUI → ICD10CM atom lookup (free-text safe) ──────
    if (action === "icd10Resolve") {
      const input = String(params?.string ?? "").trim();
      if (!input || !UMLS_API_KEY) {
        return new Response(JSON.stringify({ result: { results: [] } }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const cacheKey = await hashKey(`icd10Resolve2:${input}`);
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return new Response(
          JSON.stringify({ cached: true, vocabulary: "ICD10CM", ...(cached as object) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const s1 = await fetch(
        `${UTS}/search/current?string=${encodeURIComponent(input)}&returnIdType=concept&searchType=words&pageSize=10&apiKey=${UMLS_API_KEY}`,
        { headers: { Accept: "application/json" } },
      );
      const s1json = (s1.ok ? await s1.json() : {}) as UmlsSearchResponse;
      const candidates = (
        Array.isArray(s1json?.result?.results) ? s1json.result.results : []
      ).filter((r) => r?.ui && r.ui !== "NONE");

      let code: string | null = null;
      let name: string | null = null;
      for (const c of candidates) {
        const a = await fetch(
          `${UTS}/content/current/CUI/${encodeURIComponent(c.ui)}/atoms?sabs=ICD10CM&apiKey=${UMLS_API_KEY}`,
          { headers: { Accept: "application/json" } },
        );
        if (!a.ok) continue;
        const aj = (await a.json()) as UmlsAtomsResponse;
        const atoms = Array.isArray(aj?.result) ? aj.result : [];
        for (const atom of atoms) {
          const raw = String(atom?.code ?? "");
          const extracted = raw.includes("/") ? raw.split("/").pop()! : raw;
          if (extracted && extracted !== "NONE") {
            code = extracted;
            name = String(atom.name ?? c.name);
            break;
          }
        }
        if (code) break;
      }

      const out = { result: { results: code ? [{ ui: code, name }] : [] } };
      cacheSet(cacheKey, "ICD10CM", out).catch(() => {});
      return new Response(JSON.stringify({ cached: false, vocabulary: "ICD10CM", ...out }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const needsUmls =
      action !== "rxnorm" && action !== "rxnormDetail" && action !== "rxnormRelated";
    if (needsUmls && !UMLS_API_KEY) {
      return new Response(JSON.stringify({ error: "UMLS_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
      console.log("[umls-proxy] crosswalk upstream URL:", redactSecrets(url));
    }
    const upstream = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const elapsed_ms = Date.now() - started;

    if (!upstream.ok) {
      // UMLS crosswalk returns 404 when no equivalents exist — normalize to empty.
      if (action === "crosswalk" && upstream.status === 404) {
        const fb = await crosswalkCuiFallback(params ?? {});
        const out = {
          result: fb.matches[0] ?? null,
          matches: fb.matches,
          elapsed_ms,
          fallback: "cui-atoms",
        };
        cacheSet(cacheKey, vocab, out).catch(() => {});
        return new Response(JSON.stringify({ cached: false, vocabulary: vocab, ...out }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const text = await upstream.text();
      return new Response(
        JSON.stringify({
          error: `Upstream ${upstream.status}`,
          detail: redactSecrets(text).slice(0, 500),
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
      const crosswalkJson = json as { result?: UmlsSearchResult[] };
      const raw = Array.isArray(crosswalkJson.result) ? crosswalkJson.result : [];
      const filtered = raw.filter((r) => r && r.ui && r.ui !== "NONE");
      let matches = filtered.map((r) => ({
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
      const validateJson = json as UmlsSearchResponse;
      const results = Array.isArray(validateJson?.result?.results)
        ? validateJson.result.results
        : [];
      const top = results.find((r) => r && r.ui && r.ui !== "NONE") ?? null;
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
      JSON.stringify({ error: redactSecrets((err as Error).message ?? "Unknown error") }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
