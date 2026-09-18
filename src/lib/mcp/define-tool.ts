import type { ZodRawShape } from "zod";
import type { ToolAnnotations, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolDefinition<Args extends ZodRawShape = ZodRawShape> {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Args;
  annotations?: ToolAnnotations;
  handler: (args: any) => Promise<CallToolResult> | CallToolResult;
}

// Identity helper kept only for type inference at the call site — same
// no-op shape as the tool definitions previously wrapped in defineTool().
export function defineTool<Args extends ZodRawShape>(def: ToolDefinition<Args>): ToolDefinition<Args> {
  return def;
}
