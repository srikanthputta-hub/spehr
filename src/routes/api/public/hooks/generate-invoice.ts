import { createFileRoute } from "@tanstack/react-router";

/**
 * One-shot generator hook: force (re)generation of the FHIR Invoice +
 * ChargeItem set for a single MRN. Idempotent per (mrn, encounter).
 * Also exposes a `?all=1` mode that re-runs the periodic backfill for any
 * discharged patient that has no invoice yet — used as the cron target so
 * new discharges don't get stuck waiting for someone to open the Finance
 * board.
 */
export const Route = createFileRoute("/api/public/hooks/generate-invoice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const url = new URL(request.url);
        const all = url.searchParams.get("all");
        let body: any = null;
        try { body = await request.json(); } catch { /* empty */ }
        const mrn = String(body?.mrn ?? url.searchParams.get("mrn") ?? "").trim();
        try {
          if (all === "1" || (!mrn && all !== null)) {
            const { backfillMissingInvoices } = await import("@/lib/auto-doc.server");
            const res = await backfillMissingInvoices();
            return new Response(JSON.stringify(res), {
              headers: { "Content-Type": "application/json" },
            });
          }
          if (!mrn) {
            return new Response(JSON.stringify({ error: "mrn or ?all=1 required" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          const { generateInvoiceForPatient } = await import("@/lib/auto-doc.server");
          const inv = await generateInvoiceForPatient(mrn);
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          let items: unknown[] = [];
          if (inv.ok && inv.invoiceId) {
            const { data } = await supabaseAdmin
              .from("fhir_charge_items")
              .select("*")
              .eq("invoice_id", inv.invoiceId);
            items = data ?? [];
          }
          return new Response(JSON.stringify({ ...inv, items }), {
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