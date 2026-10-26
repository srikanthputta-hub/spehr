// Inbound FHIR webhook — receives resources pushed FROM Medblocks by the two
// R4 Subscription resources we register (Appointment and PaymentNotice tagged
// `urn:spehr:source|myspehr`). Delegates to the shared ingest module so the
// polling fallback (`fhir-inbound-poll`) uses exactly the same upsert logic.
//
// Auth: query-string `?key=<FHIR_WEBHOOK_SECRET>`. Missing/wrong → 401.
// Body: a full FHIR resource JSON.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { ingestFhirResource, logIngestEvent } from "../_shared/fhir-ingest.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("FHIR_WEBHOOK_SECRET") ?? "";

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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!WEBHOOK_SECRET) {
    console.error("[fhir-inbound-webhook] FHIR_WEBHOOK_SECRET is not configured");
    return json({ ok: false, error: "server_not_configured" }, 500);
  }
  const url = new URL(req.url);
  const providedKey = url.searchParams.get("key") ?? "";
  if (!timingSafeEqual(providedKey, WEBHOOK_SECRET)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let resource: any;
  try {
    resource = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  if (!resource?.resourceType) return json({ ok: false, error: "missing_resourceType" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { outcome, resourceType, fhirId } = await ingestFhirResource(admin, resource);
  await logIngestEvent(admin, { source: "webhook", resourceType, fhirId, outcome });

  return json({ received: resourceType, id: fhirId, outcome }, outcome.ok ? 200 : 202);
});
