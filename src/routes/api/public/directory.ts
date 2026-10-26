import { createFileRoute } from "@tanstack/react-router";
import { corsHeadersFor, rejectDisallowedOrigin } from "@/lib/cors-allowlist";

const FACILITIES = [
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Srik Health Clinic",
];

function corsFor(request: Request) {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...corsHeadersFor(request.headers.get("Origin")),
  };
}

/**
 * Public directory endpoint consumed by MySPEHR (different origin) so its
 * appointment-booking UI can populate facility + physician dropdowns from
 * SPEHR's live staff roster.
 *
 * Origin allowlist below is defense-in-depth only (see src/lib/cors-allowlist.ts):
 * it stops a hostile web page from calling this from a visitor's browser, not
 * curl or server-to-server callers, which send no Origin header at all. Note:
 * MySpehr's own domain is not yet in the allowlist (it wasn't specified when
 * this was added) — add it there once confirmed, or this browser-based
 * integration will start failing CORS preflight.
 */
export const Route = createFileRoute("/api/public/directory")({
  server: {
    handlers: {
      OPTIONS: async ({ request }) => {
        const rejected = rejectDisallowedOrigin(request);
        if (rejected) return rejected;
        return new Response(null, { status: 204, headers: corsFor(request) });
      },
      GET: async ({ request }) => {
        const rejected = rejectDisallowedOrigin(request);
        if (rejected) return rejected;
        const cors = corsFor(request);
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data, error } = await supabaseAdmin
            .from("staff_roster")
            .select("name, facility, role, active")
            .eq("role", "physician")
            .order("facility")
            .order("name");
          if (error) throw error;
          const providers = (data ?? [])
            .filter((r: any) => r.active !== false)
            .map((r: any) => ({ name: r.name, facility: r.facility }));
          return new Response(JSON.stringify({ facilities: FACILITIES, providers }), {
            headers: cors,
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: (e as Error).message }), {
            status: 500,
            headers: cors,
          });
        }
      },
    },
  },
});
