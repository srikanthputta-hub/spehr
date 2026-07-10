import { createFileRoute } from "@tanstack/react-router";

const FACILITIES = [
  "Memorial Hospital",
  "St. Jude Medical Center",
  "City General Infirmary",
  "County Health Pavilion",
  "Srik Health Clinic",
];

const CORS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Public directory endpoint consumed by MySPEHR (different origin) so its
 * appointment-booking UI can populate facility + physician dropdowns from
 * SPEHR's live staff roster.
 */
export const Route = createFileRoute("/api/public/directory")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      GET: async () => {
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
          return new Response(
            JSON.stringify({ facilities: FACILITIES, providers }),
            { headers: CORS },
          );
        } catch (e) {
          return new Response(
            JSON.stringify({ error: (e as Error).message }),
            { status: 500, headers: CORS },
          );
        }
      },
    },
  },
});