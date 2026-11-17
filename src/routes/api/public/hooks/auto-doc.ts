import { createFileRoute } from "@tanstack/react-router";

/**
 * Public hook that triggers the headless Auto Doc pipeline for a single
 * MRN. Idempotent — safe to call multiple times for the same MRN.
 *
 * NOTE: the `patients_auto_doc_after_insert` DB trigger this comment used
 * to credit as the caller was permanently dropped in migration
 * 20260619161440 (unrelated reason: duplicate "Administered" med rows)
 * and never recreated — confirmed absent on the live project. Today this
 * single-MRN mode is called by the in-app client (useAIAutomation, after
 * seeding an admission) while a browser tab is open. The `?all=1` mode
 * below is the tab-independent path: it is the pg_cron target that keeps
 * this reliable for admissions created with no tab open at all (e.g.
 * `auto_admit_due_appointments` / `admit_patient_from_appointment`, which
 * insert into `patients` directly from plpgsql). See
 * backfillMissingAutoDocRuns() in auto-doc.server.ts for the full story.
 */
export const Route = createFileRoute("/api/public/hooks/auto-doc")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("all") === "1") {
          try {
            const { backfillMissingAutoDocRuns } = await import("@/lib/auto-doc.server");
            const res = await backfillMissingAutoDocRuns();
            return new Response(JSON.stringify(res), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (e) {
            return new Response(JSON.stringify({ error: (e as Error).message }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        let body: { mrn?: string } | null = null;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
        }
        const mrn = String(body?.mrn ?? "").trim();
        if (!mrn) {
          return new Response(JSON.stringify({ error: "mrn or ?all=1 required" }), {
            status: 400,
          });
        }
        try {
          const { runAutoDocPipeline } = await import("@/lib/auto-doc.server");
          const res = await runAutoDocPipeline(mrn);
          return new Response(JSON.stringify(res), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: (e as Error).message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
