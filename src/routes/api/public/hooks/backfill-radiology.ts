import { createFileRoute } from "@tanstack/react-router";

/**
 * One-shot backfill hook: iterates every patient, and for each one that
 * has no radiology_orders row yet, derives the department-appropriate
 * imaging order from the Auto Doc catalog and pushes both a DB row and
 * a FHIR ServiceRequest to the shared Medblocks imaging network.
 *
 * Called from the admin dashboard "Backfill Radiology" button. Safe to
 * re-run — each call is bounded to 1000 patients, per-exam idempotent by
 * stable id, and skips patients that already have any radiology_orders
 * row on file.
 */
export const Route = createFileRoute("/api/public/hooks/backfill-radiology")({
  server: {
    handlers: {
      POST: async () => {
        try {
          const { backfillMissingRadiologyOrders } = await import("@/lib/auto-doc.server");
          const res = await backfillMissingRadiologyOrders();
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
