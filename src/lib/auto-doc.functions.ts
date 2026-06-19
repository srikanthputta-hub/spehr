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