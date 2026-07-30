import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDatabase } from "./db/schema.js";
import { OpsRepository } from "./db/queries.js";
import { buildToolDefinitions } from "./tools/definitions.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const db = createDatabase();
const repo = new OpsRepository(db);
const toolDefs = buildToolDefinitions(repo);

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "ops-mcp", version: "1.0.0" });

  for (const tool of toolDefs) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema as any },
      async (args: any) => {
        const result = tool.handler(args);
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
      transport.close();
      server.close();
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", tools: toolDefs.map((t) => t.name) });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ops-mcp server listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
