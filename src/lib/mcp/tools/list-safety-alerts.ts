import { createClient } from "@supabase/supabase-js";
import { defineTool } from "../define-tool";
import { z } from "zod";

export default defineTool({
  name: "list_safety_alerts",
  title: "List clinical safety alerts",
  description:
    "List recent clinical safety alerts (drug-drug, drug-allergy, etc.) from the S.P.E.H.R workspace, optionally filtered by MRN or status.",
  inputSchema: {
    mrn: z.string().optional().describe("Filter by patient MRN."),
    status: z
      .enum(["pending_review", "resolved", "dismissed"])
      .optional()
      .describe("Filter by alert status."),
    limit: z.number().int().min(1).max(100).default(25),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ mrn, status, limit }) => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    let q = supabase
      .from("clinical_safety_alerts")
      .select(
        "id, mrn, patient_name, facility_name, kind, drug, drug_b, allergy_name, severity, status, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (mrn) q = q.eq("mrn", mrn);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { alerts: data ?? [] },
    };
  },
});
