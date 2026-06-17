import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FHIR_SERVER_URL = Deno.env.get("FHIR_SERVER_URL") ?? "";
const FHIR_BEARER_TOKEN = Deno.env.get("FHIR_BEARER_TOKEN") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const payload = await req.json();
    const patientMrn = payload.record?.mrn ?? payload.mrn;

    if (!patientMrn) throw new Error("Missing MRN in payload");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { data: fhirBundle, error } = await supabaseClient.rpc("get_fhir_bundle", {
      target_mrn: patientMrn,
    });

    if (error) throw error;

    console.log('FHIR BUNDLE:', JSON.stringify(fhirBundle, null, 2));

    const response = await fetch(FHIR_SERVER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/fhir+json",
        "Authorization": `Bearer ${FHIR_BEARER_TOKEN}`,
      },
      body: JSON.stringify(fhirBundle),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Medblocks rejected the bundle: ${response.status} - ${text}`);
    }

    return new Response(JSON.stringify({ success: true, mrn: patientMrn }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("FHIR Sync Error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
