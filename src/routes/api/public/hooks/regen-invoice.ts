import { createFileRoute } from "@tanstack/react-router";

// TEMP verification hook — regenerate an invoice for an MRN regardless of
// patient status. Safe to delete after billing-pricing changes verified.
export const Route = createFileRoute("/api/public/hooks/regen-invoice")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.json().catch(() => ({}) as any);
        const mrn = String(body?.mrn ?? "").trim();
        if (!mrn) return new Response(JSON.stringify({ error: "mrn required" }), { status: 400 });
        const { generateInvoiceForPatient } = await import("@/lib/auto-doc.server");
        const res = await generateInvoiceForPatient(mrn);
        return new Response(JSON.stringify(res), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});