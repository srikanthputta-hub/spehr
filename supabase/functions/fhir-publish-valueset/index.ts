// Publishes rows from `public.custom_value_sets` as real FHIR R4
// ValueSet resources to the upstream FHIR server (Medblocks). Reuses
// the same FHIR_SERVER_URL / FHIR_BEARER_TOKEN / FHIR_APIKEY secrets
// that fhir-outbound-poll and fhir-proxy already use — no second
// credential path.
//
// Request shapes (POST):
//   { id: "<uuid>" }              — publish one value set
//   { ids: ["<uuid>", ...] }      — publish a specific batch
//   { all_published: true }       — publish every row with status='published'
//
// On success, sets fhir_published_at = now() and overwrites fhir_url
// with the real Medblocks canonical URL.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FHIR_SERVER_URL = (Deno.env.get("FHIR_SERVER_URL") ?? "").replace(/\/+$/, "");
const FHIR_BEARER_TOKEN = Deno.env.get("FHIR_BEARER_TOKEN") ?? "";
const FHIR_APIKEY = Deno.env.get("FHIR_APIKEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function fhirHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/fhir+json",
    Accept: "application/fhir+json",
    Authorization: `Bearer ${FHIR_BEARER_TOKEN}`,
  };
  if (FHIR_APIKEY) h.Apikey = FHIR_APIKEY;
  return h;
}

function slugify(s: string): string {
  return (
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "valueset"
  );
}

function pascalName(s: string): string {
  return String(s || "").replace(/[^A-Za-z0-9]+/g, "");
}

function systemUri(v: string | null | undefined): string {
  const s = String(v ?? "");
  if (/snomed/i.test(s)) return "http://snomed.info/sct";
  if (/icd-?10/i.test(s)) return "http://hl7.org/fhir/sid/icd-10-cm";
  if (/loinc/i.test(s)) return "http://loinc.org";
  if (/rxnorm/i.test(s)) return "http://www.nlm.nih.gov/research/umls/rxnorm";
  if (/cpt/i.test(s)) return "http://www.ama-assn.org/go/cpt";
  if (/meddra/i.test(s)) return "http://terminology.hl7.org/CodeSystem/meddra";
  return "urn:oid:unknown";
}

type VsRow = {
  id: string;
  name: string;
  oid: string | null;
  vocabulary: string | null;
  type: "extensional" | "intensional";
  codes: any[] | null;
  intensional_rule: any | null;
  status: string;
  description: string | null;
  version: string | null;
};

function buildValueSetResource(row: VsRow, canonicalUrl: string) {
  const defaultSys = systemUri(row.vocabulary);
  const groups = new Map<string, Array<{ code: string; display: string }>>();
  for (const c of Array.isArray(row.codes) ? row.codes : []) {
    const sys = systemUri(c?.vocabulary ?? row.vocabulary);
    const code = String(c?.code ?? "").trim();
    if (!code) continue;
    if (!groups.has(sys)) groups.set(sys, []);
    groups.get(sys)!.push({ code, display: String(c?.display ?? "") });
  }
  const include: any[] = [];
  if (row.type === "intensional" && row.intensional_rule?.rootConcept) {
    include.push({
      system: defaultSys,
      filter: [{ property: "concept", op: "is-a", value: row.intensional_rule.rootConcept }],
    });
  } else {
    for (const [system, concept] of groups.entries()) {
      include.push({ system, concept });
    }
    if (include.length === 0) include.push({ system: defaultSys, concept: [] });
  }

  return {
    resourceType: "ValueSet",
    id: slugify(row.oid ?? row.name),
    url: canonicalUrl,
    identifier: row.oid
      ? [{ system: "urn:ietf:rfc:3986", value: `urn:oid:${row.oid}` }]
      : undefined,
    version: row.version ?? "1",
    name: pascalName(row.name),
    title: row.name,
    status: row.status === "published" ? "active" : "draft",
    experimental: row.status !== "published",
    publisher: "S Group Private Network",
    description: row.description ?? undefined,
    compose: { include },
  };
}

async function publishOne(
  admin: any,
  row: VsRow,
): Promise<{
  id: string;
  name: string;
  ok: boolean;
  url?: string;
  error?: string;
  status?: number;
}> {
  try {
    const slug = slugify(row.oid ?? row.name);
    const canonicalUrl = `${FHIR_SERVER_URL}/ValueSet/${slug}`;
    const resource = buildValueSetResource(row, canonicalUrl);
    const res = await fetch(canonicalUrl, {
      method: "PUT",
      headers: fhirHeaders(),
      body: JSON.stringify(resource),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        id: row.id,
        name: row.name,
        ok: false,
        status: res.status,
        error: text.slice(0, 400),
      };
    }
    const now = new Date().toISOString();
    await admin
      .from("custom_value_sets")
      .update({ fhir_published_at: now, fhir_url: canonicalUrl, updated_at: now })
      .eq("id", row.id);
    return { id: row.id, name: row.name, ok: true, url: canonicalUrl, status: res.status };
  } catch (e: any) {
    return { id: row.id, name: row.name, ok: false, error: String(e?.message ?? e) };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    if (!FHIR_SERVER_URL || !FHIR_BEARER_TOKEN) {
      return json(
        { success: false, error: "FHIR_SERVER_URL or FHIR_BEARER_TOKEN not configured" },
        500,
      );
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}) as any);

    let rows: VsRow[] = [];
    if (body?.all_published) {
      const { data, error } = await admin
        .from("custom_value_sets")
        .select(
          "id, name, oid, vocabulary, type, codes, intensional_rule, status, description, version",
        )
        .eq("status", "published");
      if (error) return json({ success: false, error: error.message }, 500);
      rows = (data ?? []) as any[];
    } else {
      const ids: string[] = Array.isArray(body?.ids)
        ? body.ids
        : typeof body?.id === "string"
          ? [body.id]
          : [];
      if (ids.length === 0)
        return json({ success: false, error: "id, ids, or all_published required" }, 400);
      const { data, error } = await admin
        .from("custom_value_sets")
        .select(
          "id, name, oid, vocabulary, type, codes, intensional_rule, status, description, version",
        )
        .in("id", ids);
      if (error) return json({ success: false, error: error.message }, 500);
      rows = (data ?? []) as any[];
    }

    const results: any[] = [];
    for (const row of rows) {
      results.push(await publishOne(admin, row));
    }
    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    return json({
      success: fail === 0,
      fhir_server_url: FHIR_SERVER_URL,
      total: results.length,
      published: ok,
      failed: fail,
      results,
    });
  } catch (e: any) {
    console.error("[fhir-publish-valueset] error", e);
    return json({ success: false, error: String(e?.message ?? e) }, 500);
  }
});
