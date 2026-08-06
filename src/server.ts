import express from "express";
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPool, initDatabase } from "./db/schema.js";
import { OpsRepository } from "./db/queries.js";
import { buildToolDefinitions } from "./tools/definitions.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const pool = createPool();
initDatabase(pool).catch((err) => {
  console.error("Failed to initialize database:", err);
  process.exit(1);
});
const repo = new OpsRepository(pool);
const toolDefs = buildToolDefinitions(repo);

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "ops-mcp", version: "1.0.0" });

  for (const tool of toolDefs) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema as any },
      async (args: any) => {
        const result = await tool.handler(args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      // Both return promises. This callback is synchronous, so an unhandled
      // rejection here would surface as a process-level unhandledRejection —
      // which Node terminates on by default. Swallow deliberately: cleanup
      // failure on an already-finished response is not worth a crash.
      void Promise.resolve(transport.close()).catch(() => {});
      void Promise.resolve(server.close()).catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// The MCP Streamable HTTP spec has clients probe GET /mcp to open an optional
// server->client SSE stream, and DELETE /mcp to end a session. This server is
// stateless and offers neither, but "no such route" and "route exists, method
// not offered" are different answers and clients act on the difference: the
// official SDK client treats 405 as "no SSE stream, carry on" and throws a
// StreamableHTTPError on any other status. Falling through to Express's
// default 404 therefore made every SDK client emit a transport error on
// connect. 405 with an Allow header is the correct, spec-compliant answer.
app.all("/mcp", (req, res) => {
  if (req.method === "POST") return; // handled above
  res.setHeader("Allow", "POST");
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: `Method Not Allowed: this server is stateless and only supports POST /mcp. ${req.method} is not offered.`,
    },
    id: null,
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", tools: toolDefs.map((t) => t.name) });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ops-mcp server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
