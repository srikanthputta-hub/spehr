import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { corsHeadersFor, rejectDisallowedOrigin } from "@/lib/cors-allowlist";

/**
 * Value-set $validate-code proxy.
 *
 * POST { code, system, valueSetOid }
 *  → { ok: true, valid: boolean, reason?: string }
 *  → { ok: false, error: string } on upstream failure (HTTP 502)
 *
 * Extensional value sets: check membership in stored `codes` array.
 * Intensional SNOMED value sets with ECL `<<root`: check code==root
 * or root in UMLS ancestors of code.
 *
 * Non-SNOMED intensional or unknown types resolve as valid (nothing to check).
 *
 * Origin allowlist below is defense-in-depth only (see src/lib/cors-allowlist.ts):
 * it stops a hostile web page from calling this from a visitor's browser, not
 * curl or server-to-server callers, which send no Origin header at all.
 */

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

// Fallback intensional roots for value sets whose `intensional_rule` column is NULL.
const FALLBACK_ROOTS: Record<string, string> = {
  "ED Chief Complaints": "404684003",
  "Chronic Conditions": "27624003",
  "Medicinal Products": "763158003",
  "Allergy Substances": "105590001",
};

// In-memory ancestor cache (per worker instance).
const ancestorCache = new Map<string, Set<string>>();

async function fetchSnomedAncestors(code: string, apiKey: string): Promise<Set<string>> {
  const cached = ancestorCache.get(code);
  if (cached) return cached;
  const set = new Set<string>();
  const pageSize = 50;
  // Cap pagination to keep CPU well under Worker limits; ancestor chains rarely exceed a few hundred concepts.
  for (let pageNumber = 1; pageNumber <= 4; pageNumber++) {
    const url = new URL(
      `https://uts-ws.nlm.nih.gov/rest/content/current/source/SNOMEDCT_US/${encodeURIComponent(code)}/ancestors`,
    );
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("pageNumber", String(pageNumber));
    const r = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    // 404 = code has no ancestors on this page (common for leaf/invalid codes). Treat as end-of-list.
    if (r.status === 404) break;
    if (!r.ok) throw new Error(`UMLS ${r.status}`);
    const j: any = await r.json();
    const results: any[] = j?.result ?? [];
    for (const row of results) {
      if (row?.ui) set.add(String(row.ui));
    }
    if (results.length < pageSize) break;
  }
  ancestorCache.set(code, set);
  return set;
}

export const Route = createFileRoute("/api/public/umls-validate-code")({
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
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!supabaseUrl || !supabaseKey) return json({ ok: false, error: "Supabase not configured" }, 500, cors);

        let body: any = null;
        try { body = await request.json(); } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400, cors);
        }
        const code = String(body?.code ?? "").trim();
        const oid = String(body?.valueSetOid ?? "").trim();
        if (!code || !oid) return json({ ok: false, error: "code and valueSetOid required" }, 400, cors);

        const sb = createClient<Database>(supabaseUrl, supabaseKey, {
          auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        });
        const { data: vs, error } = await sb
          .from("custom_value_sets")
          .select("name, vocabulary, type, codes, intensional_rule")
          .eq("oid", oid)
          .maybeSingle();
        if (error) return json({ ok: false, error: `value set lookup failed: ${error.message}` }, 502, cors);
        if (!vs) return json({ ok: false, error: "value set not found" }, 404, cors);

        const type = (vs as any).type as string;
        const vocabulary = String((vs as any).vocabulary ?? "").toUpperCase();

        if (type === "extensional") {
          const codes: any[] = ((vs as any).codes ?? []) as any[];
          const valid = codes.some((c) => String(c?.code ?? "").trim() === code);
          return json({ ok: true, valid, reason: valid ? undefined : "not in extensional list" }, 200, cors);
        }

        if (type === "intensional") {
          const rule = ((vs as any).intensional_rule ?? null) as any;
          const root = String(rule?.root_concept ?? FALLBACK_ROOTS[(vs as any).name] ?? "").trim();
          const isSnomed = vocabulary.includes("SNOMED");
          if (!isSnomed || !root) return json({ ok: true, valid: true }, 200, cors);
          if (code === root) return json({ ok: true, valid: true }, 200, cors);
          if (!apiKey) return json({ ok: false, error: "UMLS_API_KEY not configured" }, 500, cors);
          try {
            const ancestors = await fetchSnomedAncestors(code, apiKey);
            const valid = ancestors.has(root);
            return json({ ok: true, valid, reason: valid ? undefined : `not a descendant of ${root}` }, 200, cors);
          } catch (err: any) {
            // Fail-open with 200 so callers treat as "errored" (valid=true) instead of surfacing a 502 runtime error.
            return json({ ok: false, error: String(err?.message ?? err) }, 200, cors);
          }
        }

        return json({ ok: true, valid: true }, 200, cors);
      },
    },
  },
});