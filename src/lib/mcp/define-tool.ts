import type { z, ZodRawShape } from "zod";
import type { ToolAnnotations, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolDefinition<Args extends ZodRawShape = ZodRawShape> {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Args;
  annotations?: ToolAnnotations;
  // Method syntax (not a property of function type) deliberately keeps this
  // bivariant: `defineTool` call sites get a fully-typed `args` from `Args`,
  // while heterogeneous `ToolDefinition<ZodRawShape>[]` arrays (registering
  // several tools with different schemas) still type-check.
  handler(args: z.objectOutputType<Args, z.ZodTypeAny>): Promise<CallToolResult> | CallToolResult;
}

// Identity helper kept only for type inference at the call site — same
// no-op shape as the tool definitions previously wrapped in defineTool().
export function defineTool<Args extends ZodRawShape>(
  def: ToolDefinition<Args>,
): ToolDefinition<Args> {
  return def;
}
