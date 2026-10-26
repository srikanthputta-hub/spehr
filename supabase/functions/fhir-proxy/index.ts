// Generic, secure FHIR server-side proxy.
//
// Mediates ALL traffic between the browser and the external FHIR server
// (e.g. Medblocks) so that the FHIR Apikey / Bearer credentials NEVER reach
// the client bundle or the browser Network Inspector. The frontend invokes
// this function via `supabase.functions.invoke("fhir-proxy", { body })` and
// this function attaches the secure headers server-side, forwards the
// request, and returns the upstream FHIR JSON response transparently.
//
// Accepted request shapes (all POST to this function):
//
//   1. Bundle shorthand (back-compat with the legacy push_to_fhir):
//        { bundle: <FHIR Bundle>, mrn?: string }
//      Forwarded as POST <FHIR_SERVER_URL> with `application/fhir+json`.
//
//   2. Generic passthrough (any HTTP verb against any FHIR resource path):
//        {
//          method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
//          path?:   string,            // appended to FHIR_SERVER_URL
//          query?:  Record<string, string>,
//          body?:   unknown,           // serialised as application/fhir+json
//          headers?: Record<string,string> // extra non-auth headers only
//        }
//
// Secure env vars (Supabase Secrets):
//   FHIR_SERVER_URL    — base URL of the upstream FHIR endpoint
//   FHIR_BEARER_TOKEN  — long-lived Bearer token (Authorization header)
//   FHIR_APIKEY        — optional Apikey header (if the upstream requires it)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const FHIR_SERVER_URL = Deno.env.get("FHIR_SERVER_URL") ?? "";
const FHIR_BEARER_TOKEN = Deno.env.get("FHIR_BEARER_TOKEN") ?? "";
const FHIR_APIKEY = Deno.env.get("FHIR_APIKEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Shape 2 (generic passthrough) is invoked from the browser with the anon
// key, so it must not become an arbitrary FHIR client — restrict it to
// exactly what the app's own call sites use. Any caller-supplied path/method
// combination outside this allowlist is rejected before it ever reaches the
// upstream FHIR server. See src/hooks/useBackgroundFhirSync.ts,
// src/components/patient/RadiologyFhirCard.tsx, and
// src/components/physician/RadiologyOrderPanel.tsx for the real usage this
// mirrors.
const PASSTHROUGH_METHODS = new Set(["GET", "PUT", "DELETE"]);
const PASSTHROUGH_RESOURCE_TYPES = new Set([
  "Condition",
  "AllergyIntolerance",
  "MedicationRequest",
  "MedicationAdministration",
  "Observation",
  "Composition",
  "ServiceRequest",
  "DiagnosticReport",
]);
// FHIR ids: HAPI generates plain alphanumeric/dash/dot ids; this also blocks
// path traversal ("..") and FHIR operations ("$everything", "$expunge", ...).
const FHIR_ID_RE = /^[A-Za-z0-9._-]+$/;

// Every entry the app ever constructs is a PUT-with-stable-id upsert (see
// src/lib/fhir-bundle.ts's requestFor(): "Every resource is PUT with its
// deterministic stable ID... the FHIR UPSERT contract"). A transaction Bundle
// is otherwise a second, unvalidated path into the FHIR server — reject any
// entry that isn't that exact shape rather than trusting caller-supplied
// bundles wholesale.
function validateBundleEntries(bundle: any): { ok: true } | { ok: false; error: string } {
  const entries: any[] = Array.isArray(bundle?.entry) ? bundle.entry : [];
  for (const entry of entries) {
    const method = String(entry?.request?.method ?? "").toUpperCase();
    if (method !== "PUT") {
      return {
        ok: false,
        error: `Bundle entries must use PUT (upsert); got ${method || "(none)"}`,
      };
    }
    const url = String(entry?.request?.url ?? "");
    if (!/^[A-Za-z0-9]+\/[A-Za-z0-9._-]+$/.test(url)) {
      return { ok: false, error: `Bundle entry request.url must be ResourceType/id; got ${url}` };
    }
  }
  return { ok: true };
}

function validatePassthroughRequest(
  method: string,
  path: string | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!PASSTHROUGH_METHODS.has(method)) {
    return { ok: false, error: `Method ${method} is not permitted on this endpoint` };
  }
  const segments = (path ?? "").replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 2) {
    return { ok: false, error: "Path must be ResourceType or ResourceType/id" };
  }
  const [resourceType, id] = segments;
  if (!PASSTHROUGH_RESOURCE_TYPES.has(resourceType)) {
    return { ok: false, error: `Resource type ${resourceType} is not permitted on this endpoint` };
  }
  if (id !== undefined && !FHIR_ID_RE.test(id)) {
    return { ok: false, error: "Invalid resource id" };
  }
  // DELETE must target one specific resource — never a bare resource type,
  // which HAPI would treat as a conditional/bulk delete against the query.
  if (method === "DELETE" && segments.length !== 2) {
    return { ok: false, error: "DELETE requires a specific ResourceType/id path" };
  }
  return { ok: true };
}

// HAPI FHIR throws HTTP 409 "version constraint failure" when two concurrent
// transactions touch the same resource. Retry transparently with jittered
// backoff so the live 400ms sync loop self-heals instead of surfacing 502s.
const MAX_RETRIES = 4;
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastRes: Response | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 409) return res;
    lastRes = res;
    // drain body so the connection can be reused
    try {
      await res.clone().text();
    } catch {
      /* ignore */
    }
    const delay = 80 * Math.pow(2, attempt) + Math.floor(Math.random() * 120);
    await new Promise((r) => setTimeout(r, delay));
  }
  return lastRes!;
}

// Strip anything that could leak or override the secure credentials we attach
// server-side. Clients never get to set Authorization / Apikey.
const FORBIDDEN_FORWARD_HEADERS = new Set([
  "authorization",
  "apikey",
  "host",
  "content-length",
  "connection",
]);

function buildUpstreamUrl(
  path: string | undefined,
  query: Record<string, string> | undefined,
): string {
  const base = FHIR_SERVER_URL.replace(/\/+$/, "");
  let suffix = (path ?? "").trim();
  if (suffix && !suffix.startsWith("/")) suffix = "/" + suffix;
  let url = base + suffix;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes("?") ? "&" : "?") + qs;
  }
  return url;
}

function withSecureHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/fhir+json",
    Accept: "application/fhir+json",
    Authorization: `Bearer ${FHIR_BEARER_TOKEN}`,
  };
  if (FHIR_APIKEY) headers["Apikey"] = FHIR_APIKEY;
  for (const [k, v] of Object.entries(extra)) {
    if (FORBIDDEN_FORWARD_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  return headers;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (!FHIR_SERVER_URL || !FHIR_BEARER_TOKEN) {
      throw new Error("FHIR_SERVER_URL or FHIR_BEARER_TOKEN secret is not configured");
    }

    const payload = await req.json().catch(() => ({}));

    // ---- Shape 1: legacy bundle shorthand ----------------------------------
    if (payload && (payload.bundle || payload.resourceType === "Bundle")) {
      const fhirBundle = payload.bundle ?? payload;
      if (!fhirBundle || fhirBundle.resourceType !== "Bundle") {
        throw new Error("Payload.bundle must be a FHIR Bundle resource");
      }
      const bundleValidation = validateBundleEntries(fhirBundle);
      if (!bundleValidation.ok) {
        return new Response(JSON.stringify({ success: false, error: bundleValidation.error }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 403,
        });
      }
      const upstream = await fetchWithRetry(FHIR_SERVER_URL, {
        method: "POST",
        headers: withSecureHeaders(),
        body: JSON.stringify(fhirBundle),
      });
      const text = await upstream.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      const ok = upstream.ok;
      return new Response(
        JSON.stringify({
          success: ok,
          status: upstream.status,
          statusText: upstream.statusText,
          response: ok ? body : undefined,
          error: ok ? undefined : typeof body === "string" ? body : ((body as any)?.issue ?? body),
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: ok ? 200 : 502,
        },
      );
    }

    // ---- Shape 2: generic method/path passthrough --------------------------
    const method = String(payload?.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Unsupported HTTP method: ${method}`);
    }
    const validation = validatePassthroughRequest(method, payload?.path);
    if (!validation.ok) {
      return new Response(JSON.stringify({ success: false, error: validation.error }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 403,
      });
    }
    // DELETE must never carry caller-supplied query params — HAPI JPA
    // supports _cascade=delete and conditional-delete-by-search, either of
    // which would let a validated single-resource DELETE fan out to
    // resources never checked by the allowlist above.
    const effectiveQuery = method === "DELETE" ? undefined : payload?.query;
    const upstreamUrl = buildUpstreamUrl(payload?.path, effectiveQuery);
    const hasBody = method !== "GET" && method !== "DELETE" && payload?.body !== undefined;

    const upstream = await fetchWithRetry(upstreamUrl, {
      method,
      headers: withSecureHeaders(payload?.headers ?? {}),
      body: hasBody ? JSON.stringify(payload.body) : undefined,
    });

    const text = await upstream.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }

    // Transparent return: surface upstream status + body to the caller, so the
    // UI can read the exact FHIR JSON response just like a direct call would.
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: upstream.status,
      headers: {
        ...corsHeaders,
        "Content-Type": upstream.headers.get("content-type") ?? "application/fhir+json",
      },
    });
  } catch (error) {
    console.error("[fhir-proxy] error:", error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
