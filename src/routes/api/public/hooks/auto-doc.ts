import { createFileRoute } from "@tanstack/react-router";

/**
 * Public hook that triggers the headless Auto Doc pipeline. Called by the
 * Postgres `patients_auto_doc_after_insert` trigger via pg_net whenever a
 * new patient row lands in `public.patients` (covers SQL-seeded ghost
 * admissions). Idempotent — safe to call multiple times for the same MRN.
 */
export const Route = createFileRoute("/api/public/hooks/auto-doc")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: any = null;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
        }
        const mrn = String(body?.mrn ?? "").trim();
        if (!mrn) {
          return new Response(JSON.stringify({ error: "mrn required" }), { status: 400 });
        }
        try {
          const { runAutoDocPipeline } = await import("@/lib/auto-doc.server");
          // fire-and-await; DB trigger expects only HTTP ack
          const res = await runAutoDocPipeline(mrn);
          return new Response(JSON.stringify(res), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(
            JSON.stringify({ error: (e as Error).message }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      },
    },
  },
});