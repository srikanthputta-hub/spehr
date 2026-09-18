import { createFileRoute } from "@tanstack/react-router";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "../lib/mcp/index";

// Stateless MCP endpoint: a fresh server + transport per request, matching
// the SDK's own stateless-deployment pattern (no session store needed for
// read-only tools, and no shared state across Worker isolates).
async function handleMcpRequest({ request }: { request: Request }): Promise<Response> {
  const server = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      GET: handleMcpRequest,
      POST: handleMcpRequest,
      DELETE: handleMcpRequest,
    },
  },
});
