import { createClient } from "@supabase/supabase-js";
import { defineTool } from "../define-tool";
import { z } from "zod";

export default defineTool({
  name: "list_patients",
  title: "List patients",
  description:
    "List simulated patients in the S.P.E.H.R clinical workspace. Returns MRN, name, and facility for up to `limit` patients.",
  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Maximum number of patients to return (1-100)."),
    facility: z
      .string()
      .optional()
      .describe("Optional facility name to filter by."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit, facility }) => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    let q = supabase
      .from("patients")
      .select("mrn, name, age, gender, facility_name, chief_complaint, admission_time, status")
      .limit(limit);
    if (facility) q = q.eq("facility_name", facility);
    const { data, error } = await q;
    if (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { patients: data ?? [] },
    };
  },
});