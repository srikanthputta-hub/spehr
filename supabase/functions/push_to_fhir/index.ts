import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
    if (!FHIR_SERVER_URL || !FHIR_BEARER_TOKEN) {
      throw new Error("FHIR_SERVER_URL or FHIR_BEARER_TOKEN secret is not configured");
    }

    const payload = await req.json();
    const fhirBundle = payload?.bundle ?? payload;

    if (!fhirBundle || fhirBundle.resourceType !== "Bundle" || fhirBundle.type !== "transaction") {
      throw new Error("Payload must be a FHIR Bundle of type 'transaction'");
    }

    console.log("FHIR TRANSACTION BUNDLE →", FHIR_SERVER_URL);
    console.log(JSON.stringify(fhirBundle, null, 2));

    const response = await fetch(FHIR_SERVER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/fhir+json",
        Accept: "application/fhir+json",
        Authorization: `Bearer ${FHIR_BEARER_TOKEN}`,
      },
      body: JSON.stringify(fhirBundle),
    });

    const text = await response.text();
    let responseBody: unknown = text;
    try {
      responseBody = JSON.parse(text);
    } catch {
      /* keep text */
    }

    if (!response.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          status: response.status,
          statusText: response.statusText,
          error:
            typeof responseBody === "string"
              ? responseBody
              : ((responseBody as any)?.issue ?? responseBody),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 502 },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        status: response.status,
        statusText: response.statusText,
        response: responseBody,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (error) {
    console.error("FHIR Sync Error:", error);
    return new Response(JSON.stringify({ success: false, error: (error as Error).message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});
