// FHIR R4 Terminology Server — EMPTY SHELL, intentionally not implemented.
//
// This function used to duplicate umls-proxy's $lookup/$expand/$translate
// logic (own UMLS_API_KEY usage, own service-role Supabase client) despite
// having zero callers in the frontend — a live, undocumented attack surface
// nobody was meant to reach. All terminology operations route through
// umls-proxy instead (see src/components/admin/dictionary/FhirOpCards.tsx
// for the real $lookup/$expand/$translate presentation layer). Gutted here
// so the code matches what CLAUDE.md has always said about this function.
//
// Do not re-implement UMLS/DB logic in this file — extend umls-proxy instead.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "error",
          code: "not-supported",
          diagnostics:
            "fhir-terminology is not implemented. Use umls-proxy for all terminology operations.",
        },
      ],
    }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/fhir+json" } },
  );
});
