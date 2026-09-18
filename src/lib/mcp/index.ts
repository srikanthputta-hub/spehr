import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import listPatients from "./tools/list-patients";
import getPatientChart from "./tools/get-patient-chart";
import listSafetyAlerts from "./tools/list-safety-alerts";
import type { ToolDefinition } from "./define-tool";

const tools: ToolDefinition[] = [listPatients, getPatientChart, listSafetyAlerts];

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "spehr-mcp",
    title: "S.P.E.H.R Clinical MCP",
    version: "0.1.0",
  }, {
    instructions:
      "Read-only tools for the S.P.E.H.R simulated clinical workspace. All patient data is fabricated for simulation and contains no real PHI. Use `list_patients` to browse patients, `get_patient_chart` to fetch a chart by MRN, and `list_safety_alerts` to review clinical safety alerts.",
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      tool.handler,
    );
  }

  return server;
}
