// Edge function: receives webhook payloads from Supabase Database Webhooks on
// patients / medication_orders / lab_results INSERT|UPDATE events and pulls
// the corresponding FHIR-shaped row(s) out of public.fhir_export_view for
// the affected MRN. Returns the resolved FHIR bundle so downstream callers
// (or pg_net trigger logs) can confirm the sync succeeded.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type WebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
};

function extractMrn(p: WebhookPayload): string | null {
  const row = p.record ?? p.old_record ?? {};
  const candidates = ["mrn", "patient_mrn", "patientMrn"];
  for (const k of candidates) {
    const v = (row as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const payload = (await req.json()) as WebhookPayload;
    const mrn = extractMrn(payload);

    if (!mrn) {
      return new Response(
        JSON.stringify({ ok: false, reason: "no_mrn", table: payload.table }),
        { status: 200, headers: { ...corsHeaders, "content-type": "application/json" } },
      );
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await admin
      .from("fhir_export_view")
      .select("*")
      .eq("mrn", mrn);

    if (error) {
      console.error("fhir_export_view query failed", { mrn, error });
      return new Response(
        JSON.stringify({ ok: false, error: error.message, mrn }),
        { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } },
      );
    }

    console.log("fhir-sync resolved", {
      table: payload.table,
      type: payload.type,
      mrn,
      rows: data?.length ?? 0,
    });

    return new Response(
      JSON.stringify({ ok: true, mrn, table: payload.table, type: payload.type, fhir: data }),
      { status: 200, headers: { ...corsHeaders, "content-type": "application/json" } },
    );
  } catch (err) {
    console.error("fhir-sync crashed", err);
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } },
    );
  }
});