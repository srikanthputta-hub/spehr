import { createFileRoute } from "@tanstack/react-router";
import { corsHeadersFor, rejectDisallowedOrigin } from "@/lib/cors-allowlist";

/**
 * Secure UMLS search proxy.
 *
 * POST { searchTerm: string, vocabulary: 'SNOMED-CT'|'ICD-10-CM'|'LOINC'|'RxNorm' }
 * → Forwards to https://uts-ws.nlm.nih.gov/rest/search/current with the
 *   stored UMLS_API_KEY (server-only) and returns the raw NLM JSON.
 *
 * Lives under /api/public/ so external automation can call it without
 * an authenticated session. The API key never leaves the server.
 *
 * Origin allowlist below is defense-in-depth only (see src/lib/cors-allowlist.ts):
 * it stops a hostile web page from calling this from a visitor's browser, not
 * curl or server-to-server callers, which send no Origin header at all.
 */

const VOCAB_MAP: Record<string, string> = {
  "SNOMED-CT": "SNOMEDCT_US",
  "SNOMED CT": "SNOMEDCT_US",
  SNOMEDCT_US: "SNOMEDCT_US",
  "ICD-10-CM": "ICD10CM",
  "ICD-10": "ICD10CM",
  ICD10CM: "ICD10CM",
  LOINC: "LNC",
  LNC: "LNC",
  RxNorm: "RXNORM",
  RXNORM: "RXNORM",
};

function corsFor(request: Request) {
  return {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    ...corsHeadersFor(request.headers.get("Origin")),
  };
}

function json(body: unknown, status = 200, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

export const Route = createFileRoute("/api/public/umls-search")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const rejected = rejectDisallowedOrigin(request);
        if (rejected) return rejected;
        return new Response(null, { status: 204, headers: corsFor(request) });
      },
      POST: async ({ request }) => {
        const rejected = rejectDisallowedOrigin(request);
        if (rejected) return rejected;
        const cors = corsFor(request);
        const apiKey = process.env.UMLS_API_KEY;
        if (!apiKey) return json({ error: "UMLS_API_KEY not configured" }, 500, cors);

        let body: any = null;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON body" }, 400, cors);
        }

        const searchTerm = String(body?.searchTerm ?? "").trim();
        const vocabularyRaw = String(body?.vocabulary ?? "").trim();
        if (!searchTerm) return json({ error: "searchTerm is required" }, 400, cors);

        const sabs = VOCAB_MAP[vocabularyRaw];
        if (!sabs) {
          return json({ error: `Unsupported vocabulary: ${vocabularyRaw}` }, 400, cors);
        }

        const url = new URL("https://uts-ws.nlm.nih.gov/rest/search/current");
        url.searchParams.set("string", searchTerm);
        url.searchParams.set("sabs", sabs);
        url.searchParams.set("returnIdType", "code");
        url.searchParams.set("apiKey", apiKey);
        url.searchParams.set("pageSize", "20");

        try {
          const r = await fetch(url.toString(), {
            headers: { Accept: "application/json" },
          });
          const text = await r.text();
          if (!r.ok) {
            return json(
              { error: `UMLS responded ${r.status}`, detail: text.slice(0, 500) },
              502,
              cors,
            );
          }
          // Pass through raw NLM JSON
          return new Response(text, {
            status: 200,
            headers: { "Content-Type": "application/json", ...cors },
          });
        } catch (err: any) {
          return json(
            { error: "UMLS upstream failed", detail: String(err?.message ?? err) },
            502,
            cors,
          );
        }
      },
    },
  },
});
