import { createServerFn } from "@tanstack/react-start";

/**
 * Headless Auto Doc entry point. Called by:
 *   - the in-app Live Automation Loop after admitting a new patient,
 *   - the public hook `/api/public/hooks/auto-doc` triggered by the DB
 *     `patients_auto_doc_after_insert` trigger.
 * Idempotent: short-circuits if the patient's run is already complete.
 */
export const runAutoDoc = createServerFn({ method: "POST" })
  .inputValidator((data: { mrn: string }) => {
    if (!data?.mrn || typeof data.mrn !== "string") {
      throw new Error("mrn is required");
    }
    return { mrn: data.mrn };
  })
  .handler(async ({ data }) => {
    const { runAutoDocPipeline } = await import("./auto-doc.server");
    return runAutoDocPipeline(data.mrn);
  });

/**
 * Generate (or regenerate) the FHIR Invoice + ChargeItem set for a single
 * discharged patient. Idempotent on (mrn, encounter): updates totals and
 * line items in place rather than producing duplicates.
 */
export const generateInvoiceForMrn = createServerFn({ method: "POST" })
  .inputValidator((data: { mrn: string }) => {
    if (!data?.mrn || typeof data.mrn !== "string") {
      throw new Error("mrn is required");
    }
    return { mrn: data.mrn };
  })
  .handler(async ({ data }) => {
    const { generateInvoiceForPatient } = await import("./auto-doc.server");
    return generateInvoiceForPatient(data.mrn);
  });

/**
 * Backfill: generate invoices for every already-discharged patient that
 * doesn't yet have one. Used by the Finance dashboard "Sync" button.
 */
export const backfillInvoices = createServerFn({ method: "POST" }).handler(async () => {
  const { backfillMissingInvoices } = await import("./auto-doc.server");
  return backfillMissingInvoices();
});

/**
 * Backfill: for every patient with no existing radiology_orders row,
 * derive their imaging order from the department template and push a
 * FHIR ServiceRequest to the shared imaging network.
 */
export const backfillRadiology = createServerFn({ method: "POST" }).handler(async () => {
  const { backfillMissingRadiologyOrders } = await import("./auto-doc.server");
  return backfillMissingRadiologyOrders();
});

/**
 * Patient portal payment action: marks an invoice balanced and records a
 * FHIR PaymentNotice.
 */
export const payInvoice = createServerFn({ method: "POST" })
  .inputValidator((data: { invoiceId: string; method?: string }) => {
    if (!data?.invoiceId) throw new Error("invoiceId is required");
    return { invoiceId: data.invoiceId, method: data.method };
  })
  .handler(async ({ data }) => {
    const { payInvoiceById } = await import("./auto-doc.server");
    return payInvoiceById(data.invoiceId, data.method);
  });