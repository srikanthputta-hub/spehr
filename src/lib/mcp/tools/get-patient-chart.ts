import { createClient } from "@supabase/supabase-js";
import { defineTool } from "../define-tool";
import { z } from "zod";

export default defineTool({
  name: "get_patient_chart",
  title: "Get patient chart",
  description:
    "Fetch a simulated patient's chart summary by MRN, including demographics, chief complaint, and coded terminology.",
  inputSchema: {
    mrn: z.string().min(1).describe("Medical Record Number of the patient."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ mrn }) => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await supabase
      .from("patients")
      .select(
        "mrn, name, age, gender, facility_name, chief_complaint, admission_time, status, standardized_output, snomed_codes, icd10_codes",
      )
      .eq("mrn", mrn)
      .maybeSingle();
    if (error) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    if (!data) {
      return {
        content: [{ type: "text", text: `No patient found for MRN ${mrn}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { patient: data },
    };
  },
});
