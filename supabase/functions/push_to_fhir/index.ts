import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FHIR_SERVER_URL = Deno.env.get("FHIR_SERVER_URL") ?? "";
const FHIR_BEARER_TOKEN = Deno.env.get("FHIR_BEARER_TOKEN") ?? ""; // Make sure this is set in Supabase Secrets!

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const payload = await req.json();
    const newPatient = payload.record ?? payload;
    const patientMrn = newPatient?.mrn;

    if (!patientMrn) throw new Error("Missing MRN in payload");

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabaseClient = createClient(supabaseUrl, supabaseKey);

    const { data: fhirBundle, error } = await supabaseClient.rpc("get_fhir_bundle", {
      target_mrn: patientMrn,
    });

    if (error) throw error;

    // Added Authorization header which was missing
    const response = await fetch(FHIR_SERVER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/fhir+json",
        Authorization: `Bearer ${FHIR_BEARER_TOKEN}`,
      },
      body: JSON.stringify(fhirBundle),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FHIR Server rejected the bundle: ${response.status} - ${text}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (error) {
    console.error("push_to_fhir error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
