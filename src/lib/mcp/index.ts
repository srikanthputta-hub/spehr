import { defineMcp } from "@lovable.dev/mcp-js";
import listPatients from "./tools/list-patients";
import getPatientChart from "./tools/get-patient-chart";
import listSafetyAlerts from "./tools/list-safety-alerts";

export default defineMcp({
  name: "spehr-mcp",
  title: "S.P.E.H.R Clinical MCP",
  version: "0.1.0",
  instructions:
    "Read-only tools for the S.P.E.H.R simulated clinical workspace. All patient data is fabricated for simulation and contains no real PHI. Use `list_patients` to browse patients, `get_patient_chart` to fetch a chart by MRN, and `list_safety_alerts` to review clinical safety alerts.",
  tools: [listPatients, getPatientChart, listSafetyAlerts],
});