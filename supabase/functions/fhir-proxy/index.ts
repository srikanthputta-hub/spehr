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

// Strip anything that could leak or override the secure credentials we attach
// server-side. Clients never get to set Authorization / Apikey.
const FORBIDDEN_FORWARD_HEADERS = new Set([
  "authorization",
  "apikey",
  "host",
  "content-length",
  "connection",
]);

function buildUpstreamUrl(path: string | undefined, query: Record<string, string> | undefined): string {
  let base = FHIR_SERVER_URL.replace(/\/+$/, "");
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
      const upstream = await fetch(FHIR_SERVER_URL, {
        method: "POST",
        headers: withSecureHeaders(),
        body: JSON.stringify(fhirBundle),
      });
      const text = await upstream.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      const ok = upstream.ok;
      return new Response(
        JSON.stringify({
          success: ok,
          status: upstream.status,
          statusText: upstream.statusText,
          response: ok ? body : undefined,
          error: ok ? undefined : (typeof body === "string" ? body : (body as any)?.issue ?? body),
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
    const upstreamUrl = buildUpstreamUrl(payload?.path, payload?.query);
    const hasBody = method !== "GET" && method !== "DELETE" && payload?.body !== undefined;

    const upstream = await fetch(upstreamUrl, {
      method,
      headers: withSecureHeaders(payload?.headers ?? {}),
      body: hasBody ? JSON.stringify(payload.body) : undefined,
    });

    const text = await upstream.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }

    // Transparent return: surface upstream status + body to the caller, so the
    // UI can read the exact FHIR JSON response just like a direct call would.
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status: upstream.status,
        headers: {
          ...corsHeaders,
          "Content-Type": upstream.headers.get("content-type") ?? "application/fhir+json",
        },
      },
    );
  } catch (error) {
    console.error("[fhir-proxy] error:", error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      },
    );
  }
});