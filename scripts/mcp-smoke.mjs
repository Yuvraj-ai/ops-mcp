/**
 * End-to-end MCP protocol smoke test, run over real HTTP against a running
 * server (local or deployed).
 *
 *   node scripts/mcp-smoke.mjs                                  # localhost:3000
 *   node scripts/mcp-smoke.mjs https://ops-mcp.onrender.com/mcp # production
 *
 * Why this exists as a separate script rather than a case in the test suites:
 * both suites call tool handlers directly and never cross the wire, so nothing
 * in them exercises Express routing, McpServer registration, or the Streamable
 * HTTP transport. A protocol-level defect is invisible to them. This script
 * uses the official SDK client, so it fails on exactly what a real MCP client
 * would trip over — that is how the GET /mcp 404-instead-of-405 bug was found.
 *
 * Read-only: it never calls a write tool, so it is safe against production.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2] || "http://localhost:3000/mcp";
const base = url.replace(/\/mcp$/, "");

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  (ok ? passed++ : failed++);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log(`\nMCP protocol smoke test -> ${url}\n`);

// --- transport-level conformance, before touching the SDK ---
const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
check("GET /health returns ok", health?.status === "ok", `${health?.tools?.length ?? 0} tools`);

// The SDK client special-cases 405 as "no SSE stream offered, carry on" and
// throws StreamableHTTPError on anything else, so 404 here breaks real clients.
const getRes = await fetch(url, { method: "GET", headers: { Accept: "text/event-stream" } });
check("GET /mcp returns 405, not 404", getRes.status === 405, `got ${getRes.status}`);
check("GET /mcp advertises Allow: POST", getRes.headers.get("allow") === "POST");

const delRes = await fetch(url, { method: "DELETE" });
check("DELETE /mcp returns 405, not 404", delRes.status === 405, `got ${delRes.status}`);

// --- full session with the official client ---
const transportErrors = [];
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(url));
transport.onerror = (e) => {
  // The abort during close() is normal teardown, not a defect.
  if (!/aborted/i.test(e?.message ?? "")) transportErrors.push(e?.message ?? String(e));
};

try {
  const t0 = Date.now();
  await client.connect(transport);
  check("initialize handshake succeeds", true, `${Date.now() - t0}ms`);

  const { tools } = await client.listTools();
  check("tools/list returns 7 tools", tools.length === 7, `got ${tools.length}`);

  const names = tools.map((t) => t.name);
  for (const required of ["get_order_details", "reconfirm_order", "issue_refund"]) {
    check(`tool '${required}' is registered`, names.includes(required));
  }

  const res = await client.callTool({
    name: "get_order_details",
    arguments: { order_id: "A1023" },
  });
  const payload = JSON.parse(res.content[0].text);
  check("tools/call returns a well-formed order", typeof payload.id === "string", `id=${payload.id}`);
  check("response carries real DB fields", "status" in payload && "sku" in payload, `status=${payload.status}`);

  // A write tool must refuse without the operator-approval literal. The SDK
  // surfaces a tool-level rejection as isError on the result, not as a throw.
  let rejection = null;
  try {
    const bad = await client.callTool({ name: "reconfirm_order", arguments: { order_id: "A1023" } });
    rejection = bad.isError ? bad.content?.[0]?.text ?? "" : null;
  } catch (e) {
    rejection = e?.message ?? "threw";
  }
  check(
    "write tool rejects a call missing confirmed_by_operator",
    rejection !== null && /confirmed_by_operator/.test(rejection),
    rejection ? rejection.split("\n").pop() : "was ACCEPTED"
  );

  await client.close();
} catch (e) {
  check(`session completed without throwing`, false, `${e?.constructor?.name}: ${e?.message}`);
}

check("no transport-level errors during the session", transportErrors.length === 0, transportErrors.join("; "));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
